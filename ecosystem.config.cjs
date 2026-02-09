module.exports = {
  apps: [
    {
      name: "mood-checker-app",
      script: "node",
      args: "server.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: "700M",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=384",
      },
      env_production: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=384",
      },
    },
    {
      name: "mood-checker-pyworker",
      script: "node",
      args: "worker/node-detection-worker.mjs",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: "1200M",
      env: {
        NODE_ENV: "production",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
