const fs = require("node:fs");
const path = require("node:path");
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "public");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

fs.rmSync(output, { force: true, recursive: true });
copyFile(path.join(root, "index.html"), path.join(output, "browser", "index.html"));
fs.writeFileSync(path.join(output, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="0; url=/browser/">
    <title>Connor Web</title>
    <script>location.replace("/browser/");</script>
  </head>
  <body>
    <a href="/browser/">Open Connor Web</a>
  </body>
</html>
`);

for (const file of ["uv.bundle.js", "uv.client.js", "uv.handler.js", "uv.sw.js", "sw.js"]) {
  copyFile(path.join(uvPath, file), path.join(output, file));
}

fs.writeFileSync(path.join(output, "uv.config.js"), `/*global Ultraviolet*/
self.__uv$config = {
  prefix: "/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv.handler.js",
  client: "/uv.client.js",
  bundle: "/uv.bundle.js",
  config: "/uv.config.js",
  sw: "/uv.sw.js"
};
`);

copyFile(
  path.join(root, "node_modules", "@mercuryworkshop", "bare-mux", "dist", "index.mjs"),
  path.join(output, "bare-mux", "index.mjs")
);
copyFile(
  path.join(root, "node_modules", "@mercuryworkshop", "bare-mux", "dist", "worker.js"),
  path.join(output, "bare-mux", "worker.js")
);
copyFile(
  path.join(root, "node_modules", "@mercuryworkshop", "epoxy-transport", "dist", "index.mjs"),
  path.join(output, "epoxy", "index.mjs")
);
