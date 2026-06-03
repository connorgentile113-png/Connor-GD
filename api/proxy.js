const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_BYTES = 4.5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12000;

function getTargetFromRequest(req) {
  if (req.query && req.query.url) {
    return Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  }

  const parsed = new URL(req.url || "/", "https://connor-web.local");
  return parsed.searchParams.get("url");
}

function publicError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function normalizeUrl(value) {
  const input = String(value || "").trim();

  if (!input) {
    throw publicError(400, "Enter a URL to open.");
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(withProtocol);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw publicError(400, "Connor Web only opens http and https URLs.");
  }

  if (url.username || url.password) {
    throw publicError(400, "URLs with embedded credentials are not supported.");
  }

  return url;
}

function ipv4ToNumber(ip) {
  return ip.split(".").reduce((total, part) => ((total << 8) + Number(part)) >>> 0, 0);
}

function inIpv4Range(ip, range, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(range) & mask);
}

function isBlockedIp(ip) {
  if (net.isIP(ip) === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ].some(([range, prefix]) => inIpv4Range(ip, range, prefix));
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();

    if (normalized === "::" || normalized === "::1") {
      return true;
    }

    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice(7);
      return net.isIP(mapped) === 4 ? isBlockedIp(mapped) : true;
    }

    const firstBlock = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return (firstBlock & 0xfe00) === 0xfc00 || (firstBlock & 0xffc0) === 0xfe80 || (firstBlock & 0xff00) === 0xff00;
  }

  return true;
}

async function assertPublicTarget(url) {
  const hostname = url.hostname.toLowerCase();

  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw publicError(400, "Local and private hostnames are blocked.");
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw publicError(400, "Local and private IP addresses are blocked.");
    }

    return;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some((entry) => isBlockedIp(entry.address))) {
    throw publicError(400, "This hostname resolves to a blocked network address.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function shouldSkipUrl(value) {
  const trimmed = String(value || "").trim();
  return !trimmed || trimmed.startsWith("#") || /^(about|blob|data|file|javascript|mailto|tel):/i.test(trimmed) || trimmed.startsWith("{{");
}

function proxiedUrl(value, baseUrl) {
  if (shouldSkipUrl(value)) {
    return null;
  }

  try {
    const absolute = new URL(value, baseUrl);

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return null;
    }

    return `/api/proxy?url=${encodeURIComponent(absolute.href)}`;
  } catch {
    return null;
  }
}

function rewriteUrlAttributes(html, baseUrl) {
  return html.replace(/\s(href|src|action|poster|formaction)=("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, attribute, rawValue) => {
    const quote = rawValue.startsWith("'") || rawValue.startsWith('"') ? rawValue[0] : "";
    const value = quote ? rawValue.slice(1, -1) : rawValue;
    const nextValue = proxiedUrl(value, baseUrl);

    if (!nextValue) {
      return match;
    }

    return ` ${attribute}=${quote}${escapeAttribute(nextValue)}${quote}`;
  });
}

function rewriteSrcset(html, baseUrl) {
  return html.replace(/\s(srcset)=("[^"]*"|'[^']*')/gi, (match, attribute, rawValue) => {
    const quote = rawValue[0];
    const value = rawValue.slice(1, -1);
    const rewritten = value.split(",").map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = parts.shift();
      const nextUrl = proxiedUrl(url, baseUrl);
      return nextUrl ? [nextUrl, ...parts].join(" ") : candidate.trim();
    }).join(", ");

    return ` ${attribute}=${quote}${escapeAttribute(rewritten)}${quote}`;
  });
}

function rewriteCssUrls(css, baseUrl) {
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, value) => {
      const nextValue = proxiedUrl(value, baseUrl);
      return nextValue ? `url("${nextValue}")` : match;
    })
    .replace(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi, (match, quote, value) => {
      const nextValue = proxiedUrl(value, baseUrl);
      return nextValue ? `@import url("${nextValue}")` : match;
    });
}

function frameBridgeScript(baseUrl) {
  return `<script>
(() => {
  const currentUrl = ${JSON.stringify(baseUrl)};
  const proxyPath = (value) => {
    try {
      if (value.startsWith("/api/proxy?url=")) return value;
      return "/api/proxy?url=" + encodeURIComponent(new URL(value, currentUrl).href);
    } catch {
      return value;
    }
  };
  const report = () => {
    parent.postMessage({ type: "connor-web:page", url: currentUrl, title: document.title || currentUrl }, "*");
  };
  const originalFromProxy = (value) => {
    try {
      const candidate = new URL(value, location.href);
      if (candidate.pathname === "/api/proxy" && candidate.searchParams.has("url")) {
        return candidate.searchParams.get("url");
      }
    } catch {}
    return value;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", report, { once: true });
  } else {
    report();
  }
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest && event.target.closest("a[href]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#") || anchor.target && anchor.target !== "_self") return;
    if (/^(blob|data|file|javascript|mailto|tel):/i.test(href)) return;
    if (href.startsWith("/api/proxy?url=")) return;
    event.preventDefault();
    location.href = proxyPath(href);
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || !form.action || String(form.method || "get").toLowerCase() !== "get") return;
    event.preventDefault();
    const target = new URL(originalFromProxy(form.getAttribute("action") || currentUrl), currentUrl);
    const data = new FormData(form);
    data.forEach((value, key) => target.searchParams.append(key, value));
    location.href = proxyPath(target.href);
  }, true);
})();
</script>`;
}

function rewriteHtml(html, baseUrl) {
  let output = html
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/\s(integrity|nonce)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  output = rewriteSrcset(output, baseUrl);
  output = rewriteUrlAttributes(output, baseUrl);
  output = rewriteCssUrls(output, baseUrl);

  const injection = `<base href="${escapeAttribute(baseUrl)}">${frameBridgeScript(baseUrl)}`;

  if (/<head[^>]*>/i.test(output)) {
    return output.replace(/<head[^>]*>/i, (match) => `${match}${injection}`);
  }

  return `${injection}${output}`;
}

function buildRequestHeaders(req) {
  return {
    "accept": req.headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": req.headers["accept-language"] || "en-US,en;q=0.8",
    "user-agent": req.headers["user-agent"] || "Mozilla/5.0 ConnorWeb/1.0"
  };
}

async function fetchWithRedirects(startUrl, req) {
  let currentUrl = startUrl;

  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    await assertPublicTarget(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: buildRequestHeaders(req),
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        currentUrl = normalizeUrl(new URL(response.headers.get("location"), currentUrl).href);
        clearTimeout(timeout);
        continue;
      }

      clearTimeout(timeout);
      return { response, finalUrl: currentUrl.href };
    } catch (error) {
      clearTimeout(timeout);

      if (error.name === "AbortError") {
        throw publicError(504, "The target site took too long to respond.");
      }

      throw error;
    }
  }

  throw publicError(508, "Too many redirects.");
}

async function writeProxyResponse(res, response, finalUrl) {
  const contentLength = Number(response.headers.get("content-length") || 0);

  if (contentLength > MAX_BYTES) {
    throw publicError(413, "The target response is too large for Connor Web.");
  }

  if (response.status === 204 || response.status === 304) {
    res.statusCode = response.status;
    res.end();
    return;
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength > MAX_BYTES) {
    throw publicError(413, "The target response is too large for Connor Web.");
  }

  let body = buffer;
  let outputType = contentType;

  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    body = Buffer.from(rewriteHtml(buffer.toString("utf8"), finalUrl), "utf8");
    outputType = "text/html; charset=utf-8";
  } else if (/text\/css/i.test(contentType)) {
    body = Buffer.from(rewriteCssUrls(buffer.toString("utf8"), finalUrl), "utf8");
    outputType = "text/css; charset=utf-8";
  }

  res.statusCode = response.status;
  res.setHeader("content-type", outputType);
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-connor-web-url", finalUrl);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(reqMethodAllowsBody(response) ? body : undefined);
}

function reqMethodAllowsBody(response) {
  return response.status !== 204 && response.status !== 304;
}

function sendErrorPage(res, statusCode, message, targetUrl = "") {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Connor Web</title>
    <style>
      body { margin: 0; display: grid; min-height: 100vh; place-items: center; color: #1f2d3a; font-family: "Segoe UI", system-ui, sans-serif; background: #f4f7fb; }
      main { width: min(560px, calc(100vw - 32px)); padding: 28px; border: 1px solid #c7d0da; border-radius: 4px; background: #fff; box-shadow: 0 16px 38px rgba(20, 35, 50, 0.12); }
      h1 { margin: 0 0 10px; font-size: 1.45rem; letter-spacing: 0; }
      p { margin: 0; color: #52606f; line-height: 1.5; }
      code { display: block; overflow-wrap: anywhere; margin-top: 16px; color: #005a9e; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connor Web</h1>
      <p>${escapeHtml(message)}</p>
      ${targetUrl ? `<code>${escapeHtml(targetUrl)}</code>` : ""}
    </main>
    <script>parent.postMessage({ type: "connor-web:page", url: ${JSON.stringify(targetUrl)}, title: "Connor Web" }, "*");</script>
  </body>
</html>`);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("access-control-allow-methods", "GET,HEAD,OPTIONS");
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendErrorPage(res, 405, "Connor Web supports GET and HEAD requests.");
    return;
  }

  let targetUrl;

  try {
    targetUrl = normalizeUrl(getTargetFromRequest(req));
    const { response, finalUrl } = await fetchWithRedirects(targetUrl, req);
    await writeProxyResponse(res, response, finalUrl);
  } catch (error) {
    sendErrorPage(res, error.statusCode || 502, error.publicMessage || "Connor Web could not open that page.", targetUrl ? targetUrl.href : "");
  }
};
