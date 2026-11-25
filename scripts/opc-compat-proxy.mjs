#!/usr/bin/env node
// Compatibility front for the retired 8791 instance. Everything (HTTP, MCP, /ws) is forwarded to the
// canonical OPC OS service so old MCP sessions and bookmarks keep working while data lives in one place.
import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.PORT || 8791);
const target = new URL(process.env.OPC_CANONICAL_URL || "http://127.0.0.1:52328");

const server = http.createServer((req, res) => {
  const upstream = http.request({
    host: target.hostname, port: target.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: target.host, "x-forwarded-for-compat": "8791" },
  }, up => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
  upstream.on("error", err => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "canonical_unreachable", message: `OPC OS ${target.origin} 不可达：${err.message}` }));
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const [k, v] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? target.host : v}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`[opc-compat] 127.0.0.1:${listenPort} -> ${target.origin}`);
});
