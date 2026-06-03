const fs = require("node:fs");
const path = require("node:path");
const { uvPath } = require("@titaniumnetwork-dev/ultraviolet");

const root = path.resolve(__dirname, "..");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

for (const file of ["uv.bundle.js", "uv.client.js", "uv.handler.js", "uv.sw.js", "sw.js"]) {
  copyFile(path.join(uvPath, file), path.join(root, file));
}

fs.writeFileSync(path.join(root, "uv.config.js"), `/*global Ultraviolet*/
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
  path.join(root, "bare-mux", "index.mjs")
);
copyFile(
  path.join(root, "node_modules", "@mercuryworkshop", "bare-mux", "dist", "worker.js"),
  path.join(root, "bare-mux", "worker.js")
);
copyFile(
  path.join(root, "node_modules", "@mercuryworkshop", "epoxy-transport", "dist", "index.mjs"),
  path.join(root, "epoxy", "index.mjs")
);
