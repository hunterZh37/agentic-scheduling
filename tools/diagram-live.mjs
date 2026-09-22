/**
 * Live system diagram: `npm run diagram`.
 *
 * Serves docs/diagrams/system-architecture.html on localhost and reloads the
 * open tab whenever the diagram changes. Saving the JSON re-renders it with
 * archify, so an edit shows up in the browser before anything is committed;
 * a commit or pull that rewrites the HTML shows up the same way.
 *
 *   node tools/diagram-live.mjs [--port 4178] [--no-open]
 *
 * Spec: docs/superpowers/specs/2026-09-21-live-system-diagram-design.md
 * Origin: the same tool in the messaging-agent repo.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "docs/diagrams");
const JSON_FILE = path.join(DIR, "system-architecture.json");
const HTML_FILE = path.join(DIR, "system-architecture.html");
const ARCHIFY = path.join(homedir(), ".claude/skills/archify/bin/archify.mjs");

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 4178;
const open = !args.includes("--no-open");

// Reload over server-sent events. On reconnect after a server restart the
// page reloads too, so a stale tab never lies.
const RELOAD = `<script>(() => {
  let seen = false;
  const es = new EventSource("/__live");
  es.onmessage = (e) => { if (e.data === "reload" || seen) location.reload(); seen = true; };
})();</script>`;

const clients = new Set();
let lastError = null;

function log(msg) {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

function broadcast() {
  for (const res of clients) res.write("data: reload\n\n");
}

let rendering = null;
function render() {
  if (rendering) return rendering;
  rendering = new Promise((resolve) => {
    execFile(
      "node",
      [ARCHIFY, "deliver", "architecture", JSON_FILE, HTML_FILE, "--quality", "showcase", "--json"],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        rendering = null;
        if (err) {
          let detail = err.message;
          try {
            const r = JSON.parse(stdout);
            detail = (r.diagnostics || []).map((d) => d.message).join("\n") || r.error || detail;
          } catch {
            /* not JSON */
          }
          lastError = detail;
          log(`render failed:\n${detail}`);
        } else {
          lastError = null;
          log("rendered");
        }
        resolve();
      }
    );
  });
  return rendering;
}

const server = createServer(async (req, res) => {
  if (req.url === "/__live") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("data: hello\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/__error") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(lastError || "");
    return;
  }
  try {
    let html = await readFile(HTML_FILE, "utf8");
    const banner = lastError
      ? `<pre style="position:fixed;top:0;left:0;right:0;z-index:99999;margin:0;padding:12px 16px;background:#7f1d1d;color:#fff;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap">last render failed, showing previous render:\n${lastError.replace(/</g, "&lt;")}</pre>`
      : "";
    html = html.replace("</body>", `${banner}${RELOAD}</body>`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`cannot read ${HTML_FILE}: ${err.message}\nrun: npm run diagram:render`);
  }
});

// Editors save in bursts, and git rewrites files as delete+create; coalesce.
let timer = null;
watch(DIR, (event, file) => {
  if (!file) return;
  if (file !== path.basename(JSON_FILE) && file !== path.basename(HTML_FILE)) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (file === path.basename(JSON_FILE)) {
      log("json changed, rendering");
      await render();
    }
    broadcast();
  }, 150);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${port} is in use; pick another: npm run diagram -- --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  log(`serving ${path.relative(ROOT, HTML_FILE)} at ${url}`);
  log("watching docs/diagrams; save the JSON to re-render, ctrl-c to stop");
  if (open) execFile("open", [url], () => {});
});
