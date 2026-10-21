// Local preview: serves the page and runs api/check.js like Vercel would. `npm run dev`
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import handler from "./api/check.js";

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain" };
const port = Number(process.env.PORT || 5190);
http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/api/check") return handler(req, res);
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (file.includes("..") || /^(lib|api|test|node_modules)\//.test(file)) { res.statusCode = 404; return res.end(); }
  try {
    const body = await readFile(join(process.cwd(), file));
    res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
    res.end(body);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(port, () => console.log(`http://localhost:${port}`));
