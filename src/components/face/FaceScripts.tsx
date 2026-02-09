"use client";

export default function FaceScripts({ includeFaceApi = true }: { includeFaceApi?: boolean }) {
  return (
    <>
      {includeFaceApi ? (
        <script
          src="https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js"
          async
        />
      ) : null}
      <script
        src="https://cdn.jsdelivr.net/npm/rtsp-relay@1.9.0/browser/index.js"
        async
      />
    </>
  );
}
