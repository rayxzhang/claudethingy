import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostTimeZone, localParts } from "./tz.mjs";
import { catalogStatus, costOf, ensureCatalog, tokensFromUsage } from "./pricing.mjs";

function projectsDir() {
  if (process.env.CLAUDE_PROJECTS_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECTS_DIR);
  }
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return path.join(root, "projects");
}

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

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function isoDate(y, m, d) {
  return y + "-" + pad2(m) + "-" + pad2(d);
}

function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d + delta);
  const dt = new Date(utc);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
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

function recTime(rec) {
  const t = rec && rec.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) {
    return t < 1e12 ? t * 1000 : t;
  }
  if (typeof t === "string" && t) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
    const asNum = Number(t);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
  }
  return NaN;
}

function usageOf(rec) {
  if (!rec) return null;
  if (rec.message && rec.message.usage) return rec.message.usage;
  if (rec.usage) return rec.usage;
  return null;
}

function tokenWeight(usage) {
  if (!usage) return 0;
  return (Number(usage.output_tokens) || 0) + (Number(usage.input_tokens) || 0);
}

function foldFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lastById = new Map();
  const results = [];
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
    const usage = usageOf(rec);
    if (!rec || !usage) continue;
    const assistantLike =
      rec.type === "assistant" ||
      (rec.message && rec.message.role === "assistant");
    if (assistantLike) {
      const id = (rec.message && rec.message.id) || rec.uuid || String(i);
      const prev = lastById.get(id);
      if (prev && tokenWeight(usageOf(prev)) > tokenWeight(usage)) continue;
      lastById.set(id, rec);
      continue;
    }
    if (rec.type === "result") results.push(rec);
  }
  const folded = Array.from(lastById.values());
  return folded.length ? folded : results;
}

function bump(bucket, rec, timeZone) {
  const ms = recTime(rec);
  if (!Number.isFinite(ms)) return;
  const usage = usageOf(rec);
  if (!usage) return;
  const tokens = tokensFromUsage(usage);
  const tout = tokens.output;
  const tin = tokens.input;
  const tcr = tokens.read;
  const tcc = tokens.write;
  const model = (rec.message && rec.message.model) || rec.model;
  const priced = costOf(usage, model);
  const side = Boolean(rec.isSidechain);
  const parts = localParts(ms, timeZone);
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
  if (priced.cost) day.cost += priced.cost;
  if (priced.priced) day.priced = true;
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
  if (priced.cost) hour.cost += priced.cost;
  if (priced.priced) hour.priced = true;
  bucket.hours[hourKey] = hour;

  const sessionId = rec.sessionId || rec.session_id;
  if (sessionId) bucket.sessions.add(parts.date + "|" + sessionId);
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

function newestFiles(files) {
  const ranked = [];
  for (let i = 0; i < files.length; i++) {
    let mtime = 0;
    try {
      mtime = fs.statSync(files[i]).mtimeMs;
    } catch {
      continue;
    }
    ranked.push({ path: files[i], mtime });
  }
  ranked.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (let i = 0; i < ranked.length && i < 5; i++) {
    out.push({
      name: path.basename(ranked[i].path),
      mtime: new Date(ranked[i].mtime).toISOString(),
    });
  }
  return out;
}

export async function getUsageHistory() {
  await ensureCatalog();
  const timeZone = hostTimeZone();
  const nowParts = localParts(Date.now(), timeZone);
  const todayIso = nowParts.date;
  const dir = projectsDir();
  const files = [];
  listJsonl(dir, files);

  const bucket = { days: new Map(), hours: {}, sessions: new Set() };
  let folded = 0;
  for (let i = 0; i < files.length; i++) {
    const recs = foldFile(files[i]);
    folded += recs.length;
    for (let r = 0; r < recs.length; r++) bump(bucket, recs[r], timeZone);
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
    source: {
      dir,
      timeZone,
      files: files.length,
      messages: folded,
      pricing: catalogStatus(),
      todayHours: Object.keys(bucket.hours).filter((k) => k.indexOf(todayIso + "|") === 0),
      newest: newestFiles(files),
    },
  };
}
