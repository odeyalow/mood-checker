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
      name: "mood-checker-worker",
      script: "node",
      args: "scripts/recognition-worker.mjs",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      max_memory_restart: "2500M",
      env: {
        NODE_ENV: "production",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
