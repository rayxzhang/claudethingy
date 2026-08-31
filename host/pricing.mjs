import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_MS = Number(process.env.CARTHINGY_PRICING_REFRESH_MS ?? 3_600_000);
const WEB_SEARCH_USD = 0.01;
const THRESHOLD_KEY = /^input_cost_per_token_above_([0-9]+)(k?)_tokens$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = path.join(__dirname, "pricing-fallback.json");
const CACHE_PATH = path.join(__dirname, "..", ".carthingy", "litellm-prices.json");

let catalog = {
  byPattern: new Map(),
  byCanon: new Map(),
  source: "embedded",
  fetchedAt: 0,
};
let loadPromise = null;

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function asRates(row) {
  return {
    pattern: row.pattern,
    input: Number(row.input) || 0,
    output: Number(row.output) || 0,
    cacheWrite: Number(row.cacheWrite) || 0,
    cacheWrite1h: Number(row.cacheWrite1h) || 0,
    cacheRead: Number(row.cacheRead) || 0,
    bands: Array.isArray(row.bands) ? row.bands.map((b) => ({ ...b })) : [],
  };
}

function loadFallbackRows() {
  const rows = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  return rows.map(asRates);
}

function parseThreshold(raw, thousands) {
  let value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (thousands) value *= 1000;
  return value;
}

function parseLiteLLM(data) {
  const out = [];
  for (const [model, fields] of Object.entries(data)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    if (model === "sample_spec") continue;
    const input = typeof fields.input_cost_per_token === "number" ? fields.input_cost_per_token * 1e6 : 0;
    const output = typeof fields.output_cost_per_token === "number" ? fields.output_cost_per_token * 1e6 : 0;
    if (!input && !output) continue;
    const cacheWrite =
      typeof fields.cache_creation_input_token_cost === "number"
        ? fields.cache_creation_input_token_cost * 1e6
        : 0;
    const cacheWrite1h =
      typeof fields.cache_creation_input_token_cost_above_1hr === "number"
        ? fields.cache_creation_input_token_cost_above_1hr * 1e6
        : 0;
    const cacheRead =
      typeof fields.cache_read_input_token_cost === "number"
        ? fields.cache_read_input_token_cost * 1e6
        : 0;
    const bands = [];
    const seen = new Set();
    for (const key of Object.keys(fields)) {
      const match = THRESHOLD_KEY.exec(key);
      if (!match) continue;
      const above = parseThreshold(match[1], match[2] === "k");
      if (!above || seen.has(above)) continue;
      if (typeof fields[key] !== "number") continue;
      seen.add(above);
      const suffix = key.slice("input_cost_per_token".length);
      const pick = (prefix, fallback) =>
        typeof fields[prefix + suffix] === "number" ? fields[prefix + suffix] * 1e6 : fallback;
      bands.push({
        above,
        input: fields[key] * 1e6,
        output: pick("output_cost_per_token", output),
        cacheWrite: pick("cache_creation_input_token_cost", cacheWrite),
        cacheWrite1h: pick("cache_creation_input_token_cost_above_1hr", cacheWrite1h),
        cacheRead: pick("cache_read_input_token_cost", cacheRead),
      });
    }
    bands.sort((a, b) => a.above - b.above);
    out.push({
      pattern: model,
      input: round6(input),
      output: round6(output),
      cacheWrite: round6(cacheWrite),
      cacheWrite1h: round6(cacheWrite1h),
      cacheRead: round6(cacheRead),
      bands,
    });
  }
  return out;
}

function mapFromRows(rows) {
  const byPattern = new Map();
  for (const row of rows) byPattern.set(row.pattern, asRates(row));
  return byPattern;
}

function mergeCatalog(fallbackRows, fetchedRows, source, fetchedAt) {
  const byPattern = mapFromRows(fallbackRows);
  for (const row of fetchedRows) byPattern.set(row.pattern, asRates(row));
  const byCanon = new Map();
  for (const [key, rates] of byPattern) {
    const canon = canonicalize(key);
    if (!canon) continue;
    if (byCanon.has(canon) && byCanon.get(canon) !== rates) byCanon.set(canon, null);
    else if (!byCanon.has(canon)) byCanon.set(canon, rates);
  }
  catalog = { byPattern, byCanon, source, fetchedAt };
}

function readDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (!raw || !Array.isArray(raw.models) || !raw.fetchedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeDiskCache(models, fetchedAt) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ fetchedAt, models }),
    );
  } catch {
    /* cache is best-effort */
  }
}

async function fetchLiteLLM() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(LITELLM_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error("LiteLLM HTTP " + res.status);
    return parseLiteLLM(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

function seedEmbedded() {
  mergeCatalog(loadFallbackRows(), [], "embedded", 0);
}

async function refreshCatalog(force) {
  const fallbackRows = loadFallbackRows();
  const now = Date.now();
  const offline = process.env.CARTHINGY_PRICING_OFFLINE === "1";
  if (!force && catalog.byPattern.size && now - catalog.fetchedAt < CACHE_MS) {
    return catalog;
  }
  if (offline) {
    mergeCatalog(fallbackRows, [], "embedded", now);
    return catalog;
  }
  const disk = readDiskCache();
  if (!force && disk && now - disk.fetchedAt < CACHE_MS) {
    mergeCatalog(fallbackRows, disk.models, "cached", disk.fetchedAt);
    return catalog;
  }
  try {
    const fetched = await fetchLiteLLM();
    writeDiskCache(fetched, now);
    mergeCatalog(fallbackRows, fetched, "fetched", now);
  } catch {
    if (disk) mergeCatalog(fallbackRows, disk.models, "cached", disk.fetchedAt);
    else mergeCatalog(fallbackRows, [], "embedded", now);
  }
  return catalog;
}

export async function ensureCatalog(force = false) {
  if (!catalog.byPattern.size) seedEmbedded();
  if (loadPromise) return loadPromise;
  loadPromise = refreshCatalog(force).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export function catalogStatus() {
  return {
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    models: catalog.byPattern.size,
  };
}

function normalizeDots(model) {
  return String(model || "").replaceAll(".", "-");
}

function canonicalize(s) {
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripTrailingGroup(s) {
  const t = s.trimEnd();
  let open = "";
  if (t.endsWith(")")) open = "(";
  else if (t.endsWith("]")) open = "[";
  else return s;
  const i = t.lastIndexOf(open);
  if (i <= 0) return s;
  return t.slice(0, i).trimEnd();
}

function stripTrailingDate(s) {
  const i = s.lastIndexOf("-");
  if (i <= 0 || s.length - i - 1 !== 8) return s;
  const stamp = s.slice(i + 1);
  for (let n = 0; n < stamp.length; n++) {
    if (stamp[n] < "0" || stamp[n] > "9") return s;
  }
  return s.slice(0, i);
}

function lookupExact(model) {
  if (!model) return null;
  if (catalog.byPattern.has(model)) return catalog.byPattern.get(model);
  const dashed = normalizeDots(model);
  if (dashed !== model && catalog.byPattern.has(dashed)) {
    return catalog.byPattern.get(dashed);
  }
  const lower = model.toLowerCase();
  const lowerDash = dashed.toLowerCase();
  for (const [key, rates] of catalog.byPattern) {
    const k = key.toLowerCase();
    if (k === lower || k === lowerDash) return rates;
  }
  return null;
}

export function resolveRates(model) {
  const id = String(model || "");
  if (!id) return null;
  const direct = lookupExact(id);
  if (direct) return direct;
  const candidates = [id, stripTrailingGroup(id)];
  candidates.push(stripTrailingDate(candidates[candidates.length - 1]));
  const canons = [];
  for (const c of candidates) {
    const canon = canonicalize(c);
    if (canon && !canons.includes(canon)) canons.push(canon);
  }
  for (const canon of canons) {
    if (!catalog.byCanon.has(canon)) continue;
    const found = catalog.byCanon.get(canon);
    if (found) return found;
  }
  return lookupExact(normalizeDots(stripTrailingDate(stripTrailingGroup(id))));
}

function ratesForRequest(rates, inputTokens, cacheWriteTokens, cacheReadTokens) {
  const total = inputTokens + cacheWriteTokens + cacheReadTokens;
  let selected = null;
  for (let i = 0; i < rates.bands.length; i++) {
    const band = rates.bands[i];
    if (total > band.above && (!selected || band.above > selected.above)) {
      selected = band;
    }
  }
  if (!selected) return rates;
  return {
    pattern: rates.pattern,
    input: selected.input,
    output: selected.output,
    cacheWrite: selected.cacheWrite,
    cacheWrite1h: selected.cacheWrite1h,
    cacheRead: selected.cacheRead,
    bands: rates.bands,
  };
}

export function tokensFromUsage(usage) {
  const nested = usage && usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : {};
  const tcc5 = Number(nested.ephemeral_5m_input_tokens) || 0;
  const tcc1h = Number(nested.ephemeral_1h_input_tokens) || 0;
  const nestedSum = tcc5 + tcc1h;
  const flat = Number(usage && usage.cache_creation_input_tokens) || 0;
  const write = nestedSum > 0 ? nestedSum : flat;
  const oneHour = Math.min(tcc1h, write);
  const thinking = usage && usage.output_tokens_details
    ? Number(usage.output_tokens_details.thinking_tokens) || 0
    : 0;
  const tool = usage && usage.server_tool_use && typeof usage.server_tool_use === "object"
    ? usage.server_tool_use
    : {};
  return {
    input: Number(usage && usage.input_tokens) || 0,
    output: Number(usage && usage.output_tokens) || 0,
    reasoning: thinking,
    write,
    oneHour,
    read: Number(usage && usage.cache_read_input_tokens) || 0,
    web: Number(tool.web_search_requests) || 0,
  };
}

export function costOf(usage, model) {
  const t = tokensFromUsage(usage);
  const resolved = resolveRates(model);
  let cost = 0;
  let priced = false;
  if (resolved) {
    priced = true;
    const rates = ratesForRequest(resolved, t.input, t.write, t.read);
    let oneHour = t.oneHour;
    if (oneHour > t.write) oneHour = t.write;
    const output = t.output || t.reasoning;
    const write1hRate = rates.cacheWrite1h || rates.cacheWrite;
    const perM = 1 / 1e6;
    cost =
      t.input * rates.input * perM +
      output * rates.output * perM +
      (t.write - oneHour) * rates.cacheWrite * perM +
      oneHour * write1hRate * perM +
      t.read * rates.cacheRead * perM;
  }
  if (t.web > 0) cost += t.web * WEB_SEARCH_USD;
  return {
    cost,
    priced,
    pattern: resolved ? resolved.pattern : "",
  };
}

seedEmbedded();
