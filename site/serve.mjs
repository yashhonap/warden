// Local preview server for the Warden landing page (your Claude Design export, served byte-for-byte).
// Run: node site/serve.mjs   then open http://127.0.0.1:4173/
// Separate from the Warden daemon on purpose: the daemon holds your code and transcripts, this is a public page.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = "Warden Landing Page.html";
const PORT = Number(process.env.SITE_PORT || 4173);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/" || rel === "/index.html") rel = "/" + PAGE;
  const file = path.resolve(ROOT, "." + rel);
  // stay inside this folder (no ../ escapes) and never serve this script
  if (!file.startsWith(ROOT + path.sep) || file === fileURLToPath(import.meta.url)) return res.writeHead(404).end("not found");
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Warden site on http://127.0.0.1:${PORT}/`));
