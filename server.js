const http = require("http");
const express = require("express");
const next = require("next");
const rtspRelay = require("rtsp-relay");

const dev = process.argv.includes("--dev");
process.env.NODE_ENV = dev ? "development" : "production";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const app = next({ dev, port });
const handle = app.getRequestHandler();

function isIgnorableWsError(error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "")
      : "";
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message || "")
      : "";

  return (
    Boolean(error) &&
    typeof error === "object" &&
    ((code.startsWith("WS_ERR_") && code.length > "WS_ERR_".length) ||
      message.includes("Invalid WebSocket frame"))
  );
}

const handleFatalError = (error) => {
  if (isIgnorableWsError(error)) {
    console.warn("[ws] Ignored invalid close code frame.");
    return;
  }
  console.error("Uncaught exception:", error);
  process.exit(1);
};

if (
  typeof process.setUncaughtExceptionCaptureCallback === "function" &&
  !process.hasUncaughtExceptionCaptureCallback()
) {
  process.setUncaughtExceptionCaptureCallback(handleFatalError);
} else {
  process.on("uncaughtException", handleFatalError);
}

app
  .prepare()
  .then(() => {
    const expressApp = express();
    const server = http.createServer(expressApp);
    const { proxy } = rtspRelay(expressApp, server);

    expressApp.ws("/api/stream", (ws, req) => {
      ws.on("error", (error) => {
        if (isIgnorableWsError(error)) return;
        console.error("[ws] Stream socket error:", error);
      });

      const rawUrl = req.query?.url;
      const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;

      if (typeof url !== "string" || !url.startsWith("rtsp://")) {
        ws.close(1008, "invalid_rtsp_url");
        return;
      }

      try {
        const handler = proxy({
          url,
          transport: "tcp",
          verbose: false,
        });
        handler(ws);
      } catch (error) {
        console.error("[ws] Failed to attach stream handler:", error);
        ws.close(1011, "stream_handler_error");
      }
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
