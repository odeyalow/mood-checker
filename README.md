## Mood Checker

Next.js app with camera stream preview and face recognition events.

## Run app

```bash
npm install
npm run build
npm run start
```

## Recognition worker (without open browser tab)

1. Install dependencies and browser runtime:

```bash
npm install
npx playwright install chromium
```

2. Create worker env file:

```bash
cp .env.worker.example .env.worker
```

3. Set `.env.worker`:
   - Preferred: `WORKER_AUTH_SECRET` (same value as app `AUTH_SECRET`).
   - Optional fallback: `WORKER_LOGIN` + `WORKER_PASSWORD`.

4. Start worker:

```bash
npm run worker:recognition
```

The worker opens `/${locale}/cameras` in headless Chromium, keeps recognition running, and auto-restarts on crash.

## PM2 (app + worker together)

```bash
npm run pm2:start
```

Useful commands:

```bash
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```
