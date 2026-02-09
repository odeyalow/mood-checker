const pythonBin =
  process.env.PYTHON_BIN || `${__dirname.replace(/\\/g, "/")}/.venv/bin/python`;

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
      script: pythonBin,
      args: "worker/py-recognition-worker.py",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: "700M",
      env: {
        NODE_ENV: "production",
        PYTHONUNBUFFERED: "1",
      },
      env_production: {
        NODE_ENV: "production",
        PYTHONUNBUFFERED: "1",
      },
    },
  ],
};
