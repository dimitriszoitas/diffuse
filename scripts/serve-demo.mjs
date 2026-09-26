import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? "4178");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

// A fixed allowlist keeps the demo server from exposing workspace files.
const files = new Map([
  ["/", ["production.html", "text/html; charset=utf-8"]],
  ["/production.html", ["production.html", "text/html; charset=utf-8"]],
  ["/prototype.html", ["prototype.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/showcase-production.html", ["showcase-production.html", "text/html; charset=utf-8"]],
  ["/showcase-prototype.html", ["showcase-prototype.html", "text/html; charset=utf-8"]],
  ["/showcase.css", ["showcase.css", "text/css; charset=utf-8"]],
  ["/showcase.js", ["showcase.js", "text/javascript; charset=utf-8"]],
]);

const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // The fixture deliberately rejects iframe embedding; comparison uses tab video.
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed\n");
    return;
  }

  let entry;
  try {
    const pathname = new URL(request.url, `http://${host}:${port}`).pathname;
    entry = files.get(pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid URL\n");
    return;
  }

  if (!entry) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  try {
    const [filename, contentType] = entry;
    const content = await readFile(fileURLToPath(new URL(`../demo/${filename}`, import.meta.url)));
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    console.error("Could not read a demo asset:", error.message);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Could not load demo asset\n");
  }
});

server.on("error", (error) => {
  console.error(`Could not start demo server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Diffuse demo is available at http://${host}:${port}`);
  console.log(`Production: http://${host}:${port}/production.html`);
  console.log(`Prototype:  http://${host}:${port}/prototype.html`);
  console.log(`Showcase:   http://${host}:${port}/showcase-production.html`);
  console.log("Keep this process running while comparing. Press Ctrl+C to stop.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
