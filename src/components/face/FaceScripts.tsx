"use client";

import Script from "next/script";

export default function FaceScripts() {
  return (
    <>
      <Script
        src="https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js"
        strategy="afterInteractive"
      />
      <Script
        src="https://cdn.jsdelivr.net/npm/rtsp-relay@1.9.0/browser/index.js"
        strategy="afterInteractive"
      />
    </>
  );
}
