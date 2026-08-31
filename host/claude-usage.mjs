import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_URL_WALL = `${USAGE_URL}?at_wall=1&skip_spend=1`;
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USER_AGENT = "claude-code/2.1.250";

function claudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), ".claude");
}

function credentialsPath() {
  return path.join(claudeDir(), ".credentials.json");
}

function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeCredentials(updated) {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(updated), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function refreshCredentials(creds) {
  const oauth = creds?.claudeAiOauth ?? {};
  const refreshToken = oauth.refreshToken;
  if (!refreshToken) {
    throw new Error("OAuth token expired. Run `claude` and sign in again.");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}). Run \`claude\` and sign in again.`);
  }

  const result = await response.json();
  const nextOauth = {
    ...oauth,
    accessToken: result.access_token,
    expiresAt: Date.now() + Number(result.expires_in ?? 3600) * 1000,
  };
  if (result.refresh_token) {
    nextOauth.refreshToken = result.refresh_token;
  }

  const updated = { ...creds, claudeAiOauth: nextOauth };
  writeCredentials(updated);
  return updated;
}

function planFromCredentials(creds) {
  const oauth = creds?.claudeAiOauth ?? {};
  const tier = oauth.rateLimitTier || oauth.subscriptionType || "unknown";
  return String(tier).replace(/^default_claude_/, "");
}

function asPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Claude Code 2.1.250 does utilization * 100 for statusline used_percentage.
  // Fractions in (0, 1) are 0-1 utilization. 1.0 is 1%, not 100%.
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return Math.round(Math.min(pct, 100) * 10) / 10;
}

function readPercent(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.used_percentage != null) return asPercent(entry.used_percentage);
  if (entry.percent != null) return asPercent(entry.percent);
  if (entry.utilization != null) return asPercent(entry.utilization);
  return null;
}

function classifyLimit(entry) {
  const kind = String(entry.kind || "");
  const group = String(entry.group || "");
  if (kind === "session" || kind === "five_hour" || group === "session") {
    return { id: "session", label: "Session (5h)", order: 0 };
  }
  if (kind === "weekly_scoped") {
    const name =
      entry.scope?.model?.display_name ||
      entry.scope?.model?.id ||
      "scoped";
    return {
      id: `weekly_${String(name).toLowerCase().replace(/\s+/g, "_")}`,
      label: `Weekly (${name})`,
      order: 2,
    };
  }
  if (kind === "weekly_all" || kind === "seven_day" || kind === "weekly" || group === "weekly") {
    return { id: "weekly", label: "Weekly", order: 1 };
  }
  if (!kind) return null;
  return { id: kind, label: kind.replace(/_/g, " "), order: 9 };
}

function parseLimitsArray(limits) {
  const buckets = [];

  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const percent = readPercent(entry);
    if (percent == null) continue;
    const cls = classifyLimit(entry);
    if (!cls) continue;
    buckets.push({
      id: cls.id,
      label: cls.label,
      order: cls.order,
      percent,
      resetsAt: entry.resets_at ?? entry.resetsAt ?? null,
      active: entry.is_active === true,
    });
  }

  buckets.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return buckets;
}

function parseNamedWindows(obj, mapping) {
  const buckets = [];
  if (!obj || typeof obj !== "object") return buckets;
  for (const [key, label, order, id] of mapping) {
    const entry = obj[key];
    if (!entry || typeof entry !== "object") continue;
    const percent = readPercent(entry);
    if (percent == null) continue;
    buckets.push({
      id: id || key,
      label,
      order,
      percent,
      resetsAt: entry.resets_at ?? entry.resetsAt ?? null,
      active: false,
    });
  }
  return buckets;
}

function parseLegacyResponse(apiData) {
  return parseNamedWindows(apiData, [
    ["five_hour", "Session (5h)", 0, "session"],
    ["seven_day", "Weekly", 1, "weekly"],
    ["seven_day_sonnet", "Weekly (Sonnet)", 2, "weekly_sonnet"],
    ["seven_day_opus", "Weekly (Opus)", 3, "weekly_opus"],
  ]);
}

function parseRateLimits(rateLimits) {
  return parseNamedWindows(rateLimits, [
    ["five_hour", "Session (5h)", 0, "session"],
    ["seven_day", "Weekly", 1, "weekly"],
  ]);
}

function pickBucket(buckets, ids) {
  const active = buckets.find((b) => b.active && ids.includes(b.id));
  if (active) return active;
  return buckets.find((b) => ids.includes(b.id)) ?? null;
}

function mergeBucketLists(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const bucket of list) {
      if (!byId.has(bucket.id)) byId.set(bucket.id, bucket);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.order - b.order || a.label.localeCompare(b.label),
  );
}

export function normalizeUsage(apiData, creds) {
  const data = apiData && typeof apiData === "object" ? apiData : {};
  const buckets = mergeBucketLists([
    Array.isArray(data.limits) ? parseLimitsArray(data.limits) : [],
    parseLegacyResponse(data),
    parseRateLimits(data.rate_limits),
  ]);

  return {
    plan: planFromCredentials(creds),
    updatedAt: new Date().toISOString(),
    session: pickBucket(buckets, ["session", "five_hour"]),
    weekly: pickBucket(buckets, ["weekly", "seven_day"]),
    buckets,
    extraUsage: data.extra_usage ?? data.spend ?? null,
  };
}

async function fetchUsageRaw(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "anthropic-beta": "oauth-2025-04-20",
  };
  const urls = [USAGE_URL_WALL, USAGE_URL];
  let lastError = null;
  for (const url of urls) {
    const response = await fetch(url, { headers });
    if (response.ok) return response.json();
    const body = await response.text();
    lastError = new Error(`Usage API ${response.status}: ${body.slice(0, 200)}`);
    if (response.status !== 404 && response.status !== 400) break;
  }
  throw lastError;
}

export async function getUsageSnapshot() {
  let creds = readCredentials();
  if (!creds) {
    throw new Error(`No Claude credentials at ${credentialsPath()}. Install Claude Code and run \`claude\` to sign in.`);
  }

  let oauth = creds.claudeAiOauth ?? {};
  let token = oauth.accessToken;
  if (!token) {
    throw new Error("No OAuth access token in Claude credentials.");
  }

  if (Date.now() > Number(oauth.expiresAt ?? 0) - 60_000) {
    creds = await refreshCredentials(creds);
    oauth = creds.claudeAiOauth ?? {};
    token = oauth.accessToken;
  }

  try {
    const apiData = await fetchUsageRaw(token);
    return normalizeUsage(apiData, creds);
  } catch (error) {
    if (String(error.message).includes("401")) {
      creds = await refreshCredentials(creds);
      token = creds.claudeAiOauth.accessToken;
      const apiData = await fetchUsageRaw(token);
      return normalizeUsage(apiData, creds);
    }
    throw error;
  }
}

export function credentialsStatus() {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, path: credentialsPath(), message: "missing" };
  }
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    return { ok: false, path: credentialsPath(), message: "no token" };
  }
  return {
    ok: true,
    path: credentialsPath(),
    plan: planFromCredentials(creds),
  };
}
