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
    </>
  );
}
