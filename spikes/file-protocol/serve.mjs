// Tiny static server for the HTTP leg of the spike: node serve.mjs <root> <port>
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";

const isMain = process.argv[1].endsWith("serve.mjs");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };

export function start(rootDir = isMain ? process.argv[2] : "out", port = Number(isMain ? process.argv[3] ?? 8765 : 8765)) {
  const root = path.resolve(rootDir);
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
      let f = p;
      try { if (statSync(f).isDirectory()) f = path.join(f, "index.html"); statSync(f); } catch { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(f).pipe(res);
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}
if (isMain) start().then(() => console.log("serving on http://127.0.0.1:" + (process.argv[3] ?? 8765)));
