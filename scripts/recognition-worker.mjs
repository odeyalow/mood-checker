import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const body = fs.readFileSync(filePath, "utf8");
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function createConfig() {
  const envPath = path.resolve(process.cwd(), ".env.worker");
  loadEnvFile(envPath);

  return {
    baseUrl: process.env.WORKER_BASE_URL ?? "http://127.0.0.1:3000",
    locale: process.env.WORKER_LOCALE ?? "ru",
    login: process.env.WORKER_LOGIN ?? "",
    password: process.env.WORKER_PASSWORD ?? "",
    headless: parseBoolean(process.env.WORKER_HEADLESS, true),
    healthcheckIntervalMs: parseNumber(
      process.env.WORKER_HEALTHCHECK_INTERVAL_MS,
      20_000
    ),
    restartDelayMs: parseNumber(process.env.WORKER_RESTART_DELAY_MS, 10_000),
    requestTimeoutMs: parseNumber(process.env.WORKER_REQUEST_TIMEOUT_MS, 15_000),
    ignoreHttpsErrors: parseBoolean(process.env.WORKER_IGNORE_HTTPS_ERRORS, false),
    verboseBrowserLogs: parseBoolean(
      process.env.WORKER_VERBOSE_BROWSER_LOGS,
      false
    ),
  };
}

function ensureConfig(config) {
  if (!config.login) {
    throw new Error("WORKER_LOGIN is required");
  }
  if (!config.password) {
    throw new Error("WORKER_PASSWORD is required");
  }
}

function localePath(locale, section) {
  return `/${encodeURIComponent(locale)}/${section}`;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) {
      await locator.fill(value);
      return selector;
    }
  }
  throw new Error(`Input not found. Tried selectors: ${selectors.join(", ")}`);
}

async function runSession(config) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: config.ignoreHttpsErrors,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.requestTimeoutMs);
  page.setDefaultNavigationTimeout(config.requestTimeoutMs);

  if (config.verboseBrowserLogs) {
    page.on("console", (message) => {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    });
  }

  page.on("pageerror", (error) => {
    console.error("[worker] Page error:", error?.message || error);
  });

  const loginUrl = new URL(localePath(config.locale, "login"), config.baseUrl).toString();
  const camerasUrl = new URL(
    localePath(config.locale, "cameras"),
    config.baseUrl
  ).toString();

  console.log("[worker] Opening cameras page...");
  await page.goto(camerasUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  const isOnLoginPage = page.url().includes(`/${config.locale}/login`);
  if (isOnLoginPage) {
    console.log("[worker] Login required, submitting credentials...");
    try {
      await fillFirstVisible(page, ['input[name="login"]', "#login"], config.login);
      await fillFirstVisible(page, ['input[name="password"]', "#password"], config.password);
      await Promise.all([
        page.waitForURL(new RegExp(`/${config.locale}/(dashboard|cameras)`)),
        page.click('button[type="submit"]'),
      ]);
    } catch (error) {
      const title = await page.title();
      throw new Error(
        `Login form interaction failed at ${page.url()} (title: ${title}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  await page.goto(camerasUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".camera-card");
  console.log("[worker] Recognition worker is active.");

  try {
    while (true) {
      await sleep(config.healthcheckIntervalMs);
      if (page.isClosed()) {
        throw new Error("Worker page was closed");
      }

      const authResponse = await page.request.get(new URL("/api/auth/me", config.baseUrl).toString(), {
        timeout: config.requestTimeoutMs,
      });
      if (!authResponse.ok()) {
        throw new Error(`Auth healthcheck failed (${authResponse.status()})`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const config = createConfig();
  ensureConfig(config);

  let shouldStop = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shouldStop = true;
    });
  }

  while (!shouldStop) {
    try {
      await runSession(config);
    } catch (error) {
      if (shouldStop) break;
      console.error(
        `[worker] Crashed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.log(`[worker] Restarting in ${config.restartDelayMs}ms...`);
      await sleep(config.restartDelayMs);
    }
  }
}

main().catch((error) => {
  console.error("[worker] Fatal error:", error);
  process.exit(1);
});
