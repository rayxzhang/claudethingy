import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credentialsStatus, getUsageSnapshot } from "./claude-usage.mjs";
import { flightsConfig, getFlightsSnapshot } from "./flights.mjs";
import { listHotkeys, runHotkey } from "./hotkeys.mjs";
import { getUsageHistory } from "./usage-history.mjs";
import { hostTimeZone, tzOffsetMinutesAt } from "./tz.mjs";
import { weeklyResetLabel } from "./weekly-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "display");
const PORT = Number(process.env.CARTHINGY_PORT ?? 8787);
const REFRESH_MS = Number(process.env.CARTHINGY_REFRESH_MS ?? 120_000);

let usageCache = {
  data: null,
  error: null,
  fetchedAt: 0,
};

let historyCache = {
  data: null,
  error: null,
  fetchedAt: 0,
};
const HISTORY_REFRESH_MS = Number(process.env.CARTHINGY_HISTORY_REFRESH_MS ?? 15_000);

async function refreshUsageCache(force = false) {
  const age = Date.now() - usageCache.fetchedAt;
  if (!force && usageCache.data && age < REFRESH_MS) {
    return usageCache;
  }

  try {
    const data = await getUsageSnapshot();
    usageCache = { data, error: null, fetchedAt: Date.now() };
  } catch (error) {
    usageCache = {
      data: usageCache.data,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now(),
    };
  }

  return usageCache;
}

async function refreshHistoryCache(force = false) {
  const age = Date.now() - historyCache.fetchedAt;
  if (!force && historyCache.data && age < HISTORY_REFRESH_MS) {
    return historyCache;
  }
  try {
    const data = await getUsageHistory();
    historyCache = { data, error: null, fetchedAt: Date.now() };
  } catch (error) {
    historyCache = {
      data: historyCache.data,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now(),
    };
  }
  return historyCache;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function clockPayload() {
  const now = Date.now();
  return {
    now,
    tzOffsetMinutes: tzOffsetMinutesAt(now, hostTimeZone()),
  };
}

function sendFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      credentials: credentialsStatus(),
      cacheAgeMs: Date.now() - usageCache.fetchedAt,
      flights: flightsConfig(),
      clock: clockPayload(),
    });
    return;
  }

  if (url.pathname === "/api/usage") {
    const force = url.searchParams.get("refresh") === "1";
    const snapshot = await refreshUsageCache(force);
    sendJson(res, snapshot.error && !snapshot.data ? 503 : 200, {
      ok: !snapshot.error || Boolean(snapshot.data),
      error: snapshot.error,
      usage: snapshot.data,
      weeklyReset: weeklyResetLabel(),
      fetchedAt: snapshot.fetchedAt,
      refreshMs: REFRESH_MS,
    });
    return;
  }

  if (url.pathname === "/api/usage-history") {
    const force = url.searchParams.get("refresh") === "1";
    const snapshot = await refreshHistoryCache(force);
    sendJson(res, snapshot.error && !snapshot.data ? 503 : 200, snapshot.data || { error: snapshot.error });
    return;
  }

  if (url.pathname === "/api/flights") {
    const force = url.searchParams.get("refresh") === "1";
    const snapshot = await getFlightsSnapshot(force);
    sendJson(res, snapshot.error && !snapshot.data ? 503 : 200, {
      ok: !snapshot.error || Boolean(snapshot.data),
      error: snapshot.error,
      flights: snapshot.data,
      fetchedAt: snapshot.fetchedAt,
      refreshMs: flightsConfig().refreshMs,
      clock: clockPayload(),
    });
    return;
  }

  if (url.pathname === "/api/hotkeys") {
    sendJson(res, 200, { ok: true, hotkeys: listHotkeys() });
    return;
  }

  if (url.pathname === "/api/hotkey" && req.method === "POST") {
    const raw = await readBody(req);
    let n = 0;
    try {
      n = Number(JSON.parse(raw).n);
    } catch {
      n = 0;
    }
    if (![1, 2, 3, 4].includes(n)) {
      sendJson(res, 400, { ok: false, error: "bad hotkey" });
      return;
    }
    sendJson(res, 200, runHotkey(n));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  const assetPath = path.join(PUBLIC_DIR, url.pathname.replace(/^\/+/, ""));
  if (assetPath.startsWith(PUBLIC_DIR) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    sendFile(res, assetPath);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

await refreshUsageCache(true);
await refreshHistoryCache(true);
await getFlightsSnapshot(true);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`carthingy listening on http://127.0.0.1:${PORT}`);
  console.log(`Open in a browser to preview. Plug in Car Thing and run ./scripts/start.sh.`);
});

setInterval(() => {
  refreshUsageCache(true).catch(() => {});
}, REFRESH_MS);

setInterval(() => {
  getFlightsSnapshot(true).catch(() => {});
}, flightsConfig().refreshMs);
