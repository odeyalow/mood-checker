module.exports = {
  apps: [
    {
      name: "mood-checker-app",
      script: "node",
      args: "server.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "mood-checker-worker",
      script: "node",
      args: "scripts/recognition-worker.mjs",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
