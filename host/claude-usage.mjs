import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USER_AGENT = "claude-code/2.1.72";

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

function parseLimitsArray(limits) {
  const buckets = [];

  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const pct = entry.percent;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;

    const kind = entry.kind;
    let id;
    let label;
    let order;

    if (kind === "session") {
      id = "session";
      label = "Session (5h)";
      order = 0;
    } else if (kind === "weekly_all") {
      id = "weekly";
      label = "Weekly";
      order = 1;
    } else if (kind === "weekly_scoped") {
      const name =
        entry.scope?.model?.display_name ||
        entry.scope?.model?.id ||
        "scoped";
      id = `weekly_${String(name).toLowerCase().replace(/\s+/g, "_")}`;
      label = `Weekly (${name})`;
      order = 2;
    } else {
      id = String(kind || "other");
      label = id.replace(/_/g, " ");
      order = 9;
    }

    buckets.push({
      id,
      label,
      order,
      percent: Math.round(pct * 10) / 10,
      resetsAt: entry.resets_at ?? null,
    });
  }

  buckets.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return buckets;
}

function parseLegacyResponse(apiData) {
  const buckets = [];
  const mapping = [
    ["five_hour", "Session (5h)", 0],
    ["seven_day", "Weekly", 1],
    ["seven_day_sonnet", "Weekly (Sonnet)", 2],
    ["seven_day_opus", "Weekly (Opus)", 3],
  ];

  for (const [key, label, order] of mapping) {
    const entry = apiData[key];
    if (!entry || typeof entry !== "object") continue;
    if (entry.utilization == null) continue;
    buckets.push({
      id: key,
      label,
      order,
      percent: Math.round(Number(entry.utilization) * 10) / 10,
      resetsAt: entry.resets_at ?? null,
    });
  }

  buckets.sort((a, b) => a.order - b.order);
  return buckets;
}

function normalizeUsage(apiData, creds) {
  let buckets = [];
  if (Array.isArray(apiData.limits)) {
    buckets = parseLimitsArray(apiData.limits);
  }
  if (buckets.length === 0) {
    buckets = parseLegacyResponse(apiData);
  }

  const session = buckets.find((b) => b.id === "session" || b.id === "five_hour") ?? null;
  const weekly = buckets.find((b) => b.id === "weekly" || b.id === "seven_day") ?? null;

  return {
    plan: planFromCredentials(creds),
    updatedAt: new Date().toISOString(),
    session,
    weekly,
    buckets,
    extraUsage: apiData.extra_usage ?? null,
  };
}

async function fetchUsageRaw(token) {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Usage API ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
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
