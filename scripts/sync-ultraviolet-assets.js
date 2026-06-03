const fs = require("node:fs");
const path = require("node:path");
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "public");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    }
  }
}

fs.rmSync(output, { force: true, recursive: true });
copyFile(path.join(root, "portfolio.html"), path.join(output, "index.html"));
copyFile(path.join(root, "index.html"), path.join(output, "browser", "index.html"));
copyDirectory(path.join(root, "assets"), path.join(output, "assets"));

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
