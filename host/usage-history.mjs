import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR
  ? path.resolve(process.env.CLAUDE_PROJECTS_DIR)
  : path.join(os.homedir(), ".claude", "projects");

const EMPTY = {
  main: 0,
  sub: 0,
  sessions: 0,
  cost: 0,
  priced: false,
  tin: 0,
  tout: 0,
  tcc: 0,
  tcr: 0,
};

const RATES = [
  { test: /opus/i, input: 15, output: 75 },
  { test: /sonnet/i, input: 3, output: 15 },
  { test: /haiku/i, input: 0.25, output: 1.25 },
];

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function isoDate(y, m, d) {
  return y + "-" + pad2(m) + "-" + pad2(d);
}

function localParts(ms, tzOffsetMinutes) {
  const shifted = new Date(ms - tzOffsetMinutes * 60000);
  return {
    date: isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()),
    hour: shifted.getUTCHours(),
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d + delta);
  const dt = new Date(utc);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function ratesFor(model) {
  const id = String(model || "");
  for (let i = 0; i < RATES.length; i++) {
    if (RATES[i].test.test(id)) return RATES[i];
  }
  return null;
}

function costOf(usage, model) {
  const rates = ratesFor(model);
  if (!rates) return { cost: 0, priced: false };
  const tin = Number(usage.input_tokens) || 0;
  const tout = Number(usage.output_tokens) || 0;
  const tcr = Number(usage.cache_read_input_tokens) || 0;
  const cache = usage.cache_creation || {};
  const tcc5 = Number(cache.ephemeral_5m_input_tokens) || 0;
  const tcc1h = Number(cache.ephemeral_1h_input_tokens) || Number(usage.cache_creation_input_tokens) || 0;
  const perM = 1 / 1e6;
  const cost =
    tin * rates.input * perM +
    tout * rates.output * perM +
    tcr * rates.input * 0.1 * perM +
    tcc5 * rates.input * 1.25 * perM +
    tcc1h * rates.input * 2 * perM;
  return { cost, priced: true };
}

function listJsonl(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsonl(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

function foldFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lastById = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== "assistant" || !rec.message || !rec.message.usage) continue;
    const id = rec.message.id || rec.uuid || String(i);
    lastById.set(id, rec);
  }
  return Array.from(lastById.values());
}

function bump(bucket, rec, tzOffsetMinutes) {
  const ms = Date.parse(rec.timestamp);
  if (!Number.isFinite(ms)) return;
  const usage = rec.message.usage;
  const tout = Number(usage.output_tokens) || 0;
  const tin = Number(usage.input_tokens) || 0;
  const tcr = Number(usage.cache_read_input_tokens) || 0;
  const tcc = Number(usage.cache_creation_input_tokens) || 0;
  const priced = costOf(usage, rec.message.model);
  const side = Boolean(rec.isSidechain);
  const parts = localParts(ms, tzOffsetMinutes);
  const day = bucket.days.get(parts.date) || {
    date: parts.date,
    main: 0,
    sub: 0,
    sessions: 0,
    cost: 0,
    priced: false,
    tin: 0,
    tout: 0,
    tcc: 0,
    tcr: 0,
    tracked: true,
  };
  if (side) day.sub += tout;
  else day.main += tout;
  day.tin += tin;
  day.tout += tout;
  day.tcc += tcc;
  day.tcr += tcr;
  if (priced.priced) {
    day.cost += priced.cost;
    day.priced = true;
  }
  bucket.days.set(parts.date, day);

  const hourKey = parts.date + "|" + parts.hour;
  const hour = bucket.hours[hourKey] || {
    main: 0,
    sub: 0,
    sessions: 0,
    cost: 0,
    priced: false,
    tin: 0,
    tout: 0,
    tcc: 0,
    tcr: 0,
  };
  if (side) hour.sub += tout;
  else hour.main += tout;
  hour.tin += tin;
  hour.tout += tout;
  hour.tcc += tcc;
  hour.tcr += tcr;
  if (priced.priced) {
    hour.cost += priced.cost;
    hour.priced = true;
  }
  bucket.hours[hourKey] = hour;

  if (rec.sessionId) bucket.sessions.add(parts.date + "|" + rec.sessionId);
}

function dayOrEmpty(iso, days) {
  const found = days.get(iso);
  if (found) return found;
  return {
    date: iso,
    main: 0,
    sub: 0,
    sessions: 0,
    cost: 0,
    priced: false,
    tin: 0,
    tout: 0,
    tcc: 0,
    tcr: 0,
    tracked: true,
  };
}

export function getUsageHistory(tzOffsetMinutes) {
  const tz = typeof tzOffsetMinutes === "number" ? tzOffsetMinutes : new Date().getTimezoneOffset();
  const nowParts = localParts(Date.now(), tz);
  const todayIso = nowParts.date;
  const files = [];
  listJsonl(PROJECTS_DIR, files);

  const bucket = { days: new Map(), hours: {}, sessions: new Set() };
  for (let i = 0; i < files.length; i++) {
    const recs = foldFile(files[i]);
    for (let r = 0; r < recs.length; r++) bump(bucket, recs[r], tz);
  }

  for (const key of bucket.sessions) {
    const date = key.split("|")[0];
    const day = bucket.days.get(date);
    if (day) day.sessions += 1;
  }

  const monday = addDays(todayIso, -nowParts.weekday);
  const calStart = addDays(monday, -7 * 11);
  const calendar = [];
  for (let i = 0; i < 84; i++) {
    calendar.push(dayOrEmpty(addDays(calStart, i), bucket.days));
  }

  const gridDays = [];
  for (let i = 6; i >= 0; i--) gridDays.push(addDays(todayIso, -i));

  const recent = [];
  for (let i = 13; i >= 0; i--) recent.push(dayOrEmpty(addDays(todayIso, -i), bucket.days));

  const today = dayOrEmpty(todayIso, bucket.days);
  let totalTokens = 0;
  let totalCost = 0;
  let trackedDays = 0;
  for (let i = 0; i < calendar.length; i++) {
    const d = calendar[i];
    const tok = (d.main || 0) + (d.sub || 0);
    totalTokens += tok;
    totalCost += d.cost || 0;
    if (tok > 0 || (d.cost || 0) > 0) trackedDays += 1;
  }

  return {
    today,
    hours: bucket.hours,
    calendar,
    recent,
    gridDays,
    totalTokens,
    totalCost,
    trackedDays,
    syncedAt: Date.now(),
    empty: EMPTY,
  };
}
