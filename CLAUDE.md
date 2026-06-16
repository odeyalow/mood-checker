# CLAUDE.md

Guidance for working in this repository.

## What this is
Mood Checker — система мониторинга эмоций студентов по видео с одной IP-камеры.
Распознаёт лица (присваивает короткий ID), определяет эмоцию и пишет события в БД.
Веб-дашборд показывает статистику, «топ негативных», журнал матчинга и реестр лиц.
UI трёхъязычный (ru/kz/en). Работает локально на сервере Proxmox.

## Architecture (PM2 processes)
- **mood-checker-app** — Next.js 16 (App Router, React 19) + кастомный Express-сервер
  ([server.js](server.js)). Отдаёт UI, API и статику снапшотов (`/_faces`, `/_worker-snaps`).
- **mood-checker-worker** — [worker/node-detection-worker.mjs](worker/node-detection-worker.mjs)
  (~4500 строк, ядро). Кадры из go2rtc → детекция через InsightFace → матчинг по реестру →
  эмоции → presence-сессии (1 запись на присутствие) → запись событий.
- **recognition-consumer** — [worker/recognition-consumer.mjs](worker/recognition-consumer.mjs).
  При `WORKER_DB_WRITER_MODE=external` (дефолт) детектор пишет события в JSONL-очередь
  (`worker/recognition-queue.jsonl`), а этот процесс читает её и POST-ит в `/api/recognitions`.
- **go2rtc** — приём RTSP-потока камеры, выдаёт snapshot/MJPEG.

Python-сервис: [worker/insightface-service.py](worker/insightface-service.py) — HTTP-сервис
детекции/эмбеддингов (buffalo_l, 512-dim) + эмоции через hsemotion-onnx (фолбэк — face-api).
Воркер запускает его автоматически. [worker/py-recognition-worker.py](worker/py-recognition-worker.py) — legacy, не используется.

## Data flow
Камера(RTSP) → go2rtc → `/api/camera/frame` → worker → InsightFace(детекция+эмбеддинг+эмоция)
→ матчинг (косинус-дистанция по галерее) → presence-session → JSONL-очередь → recognition-consumer
→ POST `/api/recognitions` → SQLite → дашборд.

## Data model ([prisma/schema.prisma](prisma/schema.prisma))
- `Recognition` — событие (name=shortId, mood, камера, дистанция, снапшот).
- `FaceIdentity` — личность (shortId + центроид-дескриптор, EMA-обновление).
- `FaceDescriptor` — галерея дескрипторов на личность (до 6 разнообразных сэмплов, точнее матчинг).
- `FaceDedupLog` — журнал слияния дубликатов лиц.
- `EmotionSnapshot` — почасовые агрегаты.
- `User` — учётки админки (JWT + bcrypt, кука `mc_auth`, [middleware.ts](middleware.ts)).

## Key conventions
- Распознавание: `name` в `Recognition` — это `shortId` личности (не имя человека).
- Эмоции маппятся в 7 ключей face-api: neutral/happy/sad/angry/fearful/disgusted/surprised.
  Классификация mood (позитив/нейтрал/негатив) — [src/lib/mood.ts](src/lib/mood.ts) по ключевым словам (multi-lang).
- Дескрипторы: 512-dim (InsightFace) → косинус-дистанция; 128-dim (face-api) → евклид. См. [src/lib/faces.ts](src/lib/faces.ts).
- Реестр для воркера отдаёт `/api/faces/registry` (центроид + галерея `descriptors[]`); галерея пополняется в `/api/recognitions`.
- Поведение воркера почти целиком настраивается через env (`WORKER_*`); см. [.env.worker.example](.env.worker.example).
  Все опции имеют безопасные дефолты в коде.

## Commands
```bash
npm run dev                 # локальная разработка (next dev)
npm run build               # сборка (next build) — делает typecheck, нужен prisma generate заранее
npm run start               # прод-запуск app
node worker/node-detection-worker.mjs   # воркер вручную
npm run db:push             # синхронизировать схему в SQLite + перегенерировать клиент
npm run lint
```
PM2: `npm run pm2:start:all`, `pm2:restart:worker`, `pm2:logs:worker`, и т.д. (см. package.json).

## Deploy (Proxmox, /opt/mood-checker)
Пуш в `master` с локальной машины → на сервере `git pull`, затем:
```bash
# worker/*.mjs или *.py — только рестарт:
npm run pm2:restart:worker
# src/** (UI/API/lib):
npm run build && npm run pm2:restart && npm run pm2:restart:worker
# prisma/schema.prisma — СНАЧАЛА (иначе next build упадёт на типах):
npx prisma generate && npx prisma migrate deploy
# python-зависимости:
.venv/bin/python -m pip install -r worker/requirements-cpu.txt
```
Диагностика: `pm2 logs mood-checker-worker`, `curl 127.0.0.1:8765/health`, `curl 127.0.0.1:3000/api/worker/status?cameraId=cam-01`.

## Gotchas
- `prisma.faceDescriptor` требует `prisma generate` после правок схемы, иначе `next build` упадёт на типах.
  Код к таблице обращается fail-safe (try/catch) — без миграции матчинг работает на одиночном центроиде.
- Десктоп-копия легко отстаёт от `origin/master` (разработка идёт и на сервере) — перед работой делай `git fetch` и сверяйся.
- Конфиг камер хардкодит одну камеру `cam-01` ([src/lib/cameras.ts](src/lib/cameras.ts)).
- L10N-словари и `type AppLocale` продублированы в каждой странице (локаль `kz`, не `kk`) — кандидат на вынос.
- Нет автотестов.
