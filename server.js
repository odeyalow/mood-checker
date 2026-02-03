const http = require("http");
const express = require("express");
const next = require("next");
const rtspRelay = require("rtsp-relay");

const dev = process.argv.includes("--dev");
process.env.NODE_ENV = dev ? "development" : "production";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const app = next({ dev, port });
const handle = app.getRequestHandler();

const proxyHandlers = new Map();

function getProxyHandler(proxy, url) {
  if (!proxyHandlers.has(url)) {
    proxyHandlers.set(
      url,
      proxy({
        url,
        transport: "tcp",
        verbose: false,
      })
    );
  }
  return proxyHandlers.get(url);
}

app
  .prepare()
  .then(() => {
    const expressApp = express();
    const server = http.createServer(expressApp);
    const { proxy } = rtspRelay(expressApp, server);

    expressApp.ws("/api/stream", (ws, req) => {
      const rawUrl = req.query?.url;
      const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;

      if (typeof url !== "string" || !url.startsWith("rtsp://")) {
        ws.close(1008, "invalid_rtsp_url");
        return;
      }

      const handler = getProxyHandler(proxy, url);
      handler(ws);
    });

    expressApp.use((req, res) => handle(req, res));

    server.listen(port, () => {
      const mode = dev ? "dev" : "prod";
      console.log(`> Ready on http://localhost:${port} (${mode})`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
