const http = require("http");
const express = require("express");
const next = require("next");
const rtspRelay = require("rtsp-relay");
const path = require("path");
const dev = process.argv.includes("--dev");
process.env.NODE_ENV = dev ? "development" : "production";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const app = next({ dev, port });
const handle = app.getRequestHandler();
const previewMaxWidth = Math.max(
  320,
  Number.parseInt(process.env.STREAM_PREVIEW_MAX_WIDTH || "1280", 10) || 1280,
);
const previewFrameRate = Math.max(
  5,
  Number.parseInt(process.env.STREAM_PREVIEW_FPS || "15", 10) || 15,
);
const previewQuality = Math.min(
  31,
  Math.max(1, Number.parseInt(process.env.STREAM_PREVIEW_MPEG1_Q || "5", 10) || 5),
);

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

function parseZoomParam(rawZoom) {
  const value = Array.isArray(rawZoom) ? rawZoom[0] : rawZoom;
  if (typeof value !== "string" || value.trim() === "") return 1;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 1;

  return Math.min(Math.max(parsed, 1), 4);
}

function buildVideoFilter(zoom) {
  const filters = [];

  if (zoom > 1) {
    const safeZoom = Number(zoom.toFixed(2));
    filters.push(
      `crop=iw/${safeZoom}:ih/${safeZoom}:(iw-iw/${safeZoom})/2:(ih-ih/${safeZoom})/2`,
      "scale=iw:ih",
    );
  }

  if (previewMaxWidth > 0) {
    filters.push(`scale='min(${previewMaxWidth},iw)':-2`);
  }

  return filters.join(",");
}

const handleFatalError = (error) => {
  if (isIgnorableWsError(error)) {
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
    const publicDir = path.join(__dirname, "public");

    // Serve worker/face snapshots directly to avoid Next.js 404 on underscored paths.
    expressApp.use("/_faces", express.static(path.join(publicDir, "_faces")));
    expressApp.use("/_worker-snaps", express.static(path.join(publicDir, "_worker-snaps")));

    expressApp.ws("/api/stream", (ws, req) => {
      ws.on("error", (error) => {
        if (isIgnorableWsError(error)) return;
        console.error("[ws] Stream socket error:", error);
      });

      const rawUrl = req.query?.url;
      const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
      const zoom = parseZoomParam(req.query?.zoom);

      if (typeof url !== "string" || !url.startsWith("rtsp://")) {
        ws.close(1008, "invalid_rtsp_url");
        return;
      }

      try {
        const filter = buildVideoFilter(zoom);
        const additionalFlags = ["-q", String(previewQuality), "-r", String(previewFrameRate)];
        if (filter) {
          additionalFlags.push("-vf", filter);
        }

        const handler = proxy({
          url,
          transport: "tcp",
          additionalFlags,
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
