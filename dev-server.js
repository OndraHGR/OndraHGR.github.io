/*
  Local preview:  node dev-server.js   ->  http://localhost:8080

  Serves this folder and stands in for the few GitHub API calls the editor makes
  (under /__gh), so the editor at /admin/ can be tried offline. Publishing here
  writes straight into this folder. It listens on this computer only.
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};
// The only paths a "commit" may touch.
const WRITABLE = /^(content\.json|admin\/access\.local\.json|photos\/[a-z0-9-]+\.(jpg|png|webp))$/;

const blobs = new Map(), trees = new Map(), commits = new Map();
let head = "local-head", seq = 0;
const id = (p) => p + "-" + (++seq);

function send(res, status, body, type) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}
function inside(rel) {
  const full = path.resolve(ROOT, rel);
  return full === ROOT || full.startsWith(ROOT + path.sep) ? full : null;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function github(req, res, route) {
  if (!req.headers.authorization) return send(res, 401, { message: "Bad credentials" });
  const m = req.method;
  if (m === "GET" && route === "") return send(res, 200, { default_branch: "main", permissions: { push: true } });

  if (m === "GET" && route.startsWith("/contents/")) {
    const rel = decodeURIComponent(route.slice(10)), full = inside(rel);
    if (!full || !fs.existsSync(full)) return send(res, 404, { message: "Not Found" });
    if (fs.statSync(full).isDirectory()) {
      return send(res, 200, fs.readdirSync(full).map((n) => ({ name: n, path: rel + "/" + n, type: "file" })));
    }
    return send(res, 200, fs.readFileSync(full), "application/json; charset=utf-8");
  }
  if (m === "GET" && route === "/git/ref/heads/main") return send(res, 200, { object: { sha: head } });
  if (m === "GET" && route.startsWith("/git/commits/")) return send(res, 200, { tree: { sha: "local-tree" } });

  const body = m === "GET" ? {} : await readBody(req);
  if (m === "POST" && route === "/git/blobs") {
    const sha = id("blob");
    blobs.set(sha, Buffer.from(body.content || "", body.encoding === "base64" ? "base64" : "utf8"));
    return send(res, 201, { sha });
  }
  if (m === "POST" && route === "/git/trees") {
    const sha = id("tree");
    trees.set(sha, body.tree || []);
    return send(res, 201, { sha });
  }
  if (m === "POST" && route === "/git/commits") {
    const sha = id("commit");
    commits.set(sha, body.tree);
    return send(res, 201, { sha });
  }
  if (m === "PATCH" && route === "/git/refs/heads/main") {
    const entries = trees.get(commits.get(body.sha));
    if (!entries) return send(res, 422, { message: "Unknown commit" });
    for (const e of entries) {
      const full = WRITABLE.test(e.path) && inside(e.path);
      if (!full) return send(res, 422, { message: "Path not allowed: " + e.path });
      if (e.sha === null) { if (fs.existsSync(full)) fs.unlinkSync(full); continue; }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, blobs.get(e.sha));
    }
    head = body.sha;
    console.log("published:", entries.map((e) => (e.sha === null ? "- " : "+ ") + e.path).join(", "));
    return send(res, 200, { object: { sha: head } });
  }
  send(res, 404, { message: "Not Found" });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const gh = url.pathname.match(/^\/__gh\/repos\/[^/]+\/[^/]+(\/.*)?$/);
  if (gh) return github(req, res, gh[1] || "").catch(() => send(res, 400, { message: "Bad request" }));

  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const full = inside(rel);
  if (!full || rel.split("/").some((s) => s.startsWith(".")) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
}).listen(PORT, "127.0.0.1", () => console.log("http://localhost:" + PORT + "   editor: http://localhost:" + PORT + "/admin/"));
