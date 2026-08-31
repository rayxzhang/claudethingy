const ADSB_BASE = "https://api.adsb.lol/v2/point";
const ROUTE_URL = "https://api.adsb.lol/api/0/routeset";
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "carthingy/1.0 (local dashboard)",
};
const REFRESH_MS = Number(process.env.CARTHINGY_FLIGHTS_REFRESH_MS ?? 15_000);
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;

function envNumber(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function envList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

const OFFICE = {
  lat: envNumber("OFFICE_LAT"),
  lon: envNumber("OFFICE_LON"),
  radiusNm: envNumber("OFFICE_RADIUS_NM") ?? 7,
  label: process.env.OFFICE_LABEL || "Office",
};

const EXCLUDE_NEAR = {
  lat: envNumber("EXCLUDE_NEAR_LAT"),
  lon: envNumber("EXCLUDE_NEAR_LON"),
};
const EXCLUDE_DEST = new Set(envList("EXCLUDE_DEST"));

const CATEGORY_LABEL = {
  A0: "Unknown",
  A1: "Light aircraft",
  A2: "Small jet",
  A3: "Large aircraft",
  A4: "High vortex",
  A5: "Heavy jet",
  A6: "High performance",
  A7: "Rotorcraft",
  B1: "Glider",
  B2: "Balloon",
  B6: "UAV",
};

const TYPE_NAMES = {
  B772: "Boeing 777-200",
  B77W: "Boeing 777-300ER",
  B738: "Boeing 737-800",
  B739: "Boeing 737-900",
  B38M: "Boeing 737 MAX 8",
  B39M: "Boeing 737 MAX 9",
  A320: "Airbus A320",
  A321: "Airbus A321",
  A359: "Airbus A350-900",
  A388: "Airbus A380",
  E75L: "Embraer E175",
  CRJ2: "Bombardier CRJ-200",
  CRJ7: "Bombardier CRJ-700",
  CRJ9: "Bombardier CRJ-900",
  E55P: "Embraer Phenom 300",
  B763: "Boeing 767-300",
  B789: "Boeing 787-9",
  A21N: "Airbus A321neo",
  A20N: "Airbus A320neo",
};

let cache = {
  data: null,
  error: null,
  fetchedAt: 0,
};

const routeCache = new Map();

function trimCallsign(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim();
}

function angleDiff(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseRadarAirports() {
  const raw = process.env.RADAR_AIRPORTS;
  if (!raw) return [];
  if (OFFICE.lat == null || OFFICE.lon == null) return [];

  const out = [];
  const parts = String(raw).split(",");
  for (const part of parts) {
    const bits = part.trim().split(":");
    if (bits.length < 3) continue;
    const code = bits[0].trim().toUpperCase();
    const lat = Number(bits[1]);
    const lon = Number(bits[2]);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const distanceNm = haversineNm(OFFICE.lat, OFFICE.lon, lat, lon);
    if (distanceNm > OFFICE.radiusNm) continue;
    out.push({
      code,
      distanceNm: Math.round(distanceNm * 10) / 10,
      bearingDeg: Math.round(bearingFrom(OFFICE.lat, OFFICE.lon, lat, lon)),
    });
  }
  return out;
}

function nearerExclude(ac) {
  if (EXCLUDE_NEAR.lat == null || EXCLUDE_NEAR.lon == null) return false;
  if (ac.lat == null || ac.lon == null) return false;
  if (OFFICE.lat == null || OFFICE.lon == null) return false;
  const toOffice = haversineNm(ac.lat, ac.lon, OFFICE.lat, OFFICE.lon);
  const toOther = haversineNm(ac.lat, ac.lon, EXCLUDE_NEAR.lat, EXCLUDE_NEAR.lon);
  return toOther + 1.5 < toOffice;
}

function bearingFrom(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function typeLabel(code) {
  if (!code) return "Unknown type";
  return TYPE_NAMES[code] ?? code;
}

function categoryLabel(code) {
  if (!code) return "Unknown";
  return CATEGORY_LABEL[code] ?? code;
}

function isApproaching(ac) {
  if (OFFICE.lat == null || OFFICE.lon == null) return false;
  if (ac.lat == null || ac.lon == null) return false;
  if (ac.alt_baro === "ground") return false;

  const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : null;
  const gs = typeof ac.gs === "number" ? ac.gs : 0;
  if (gs < 70) return false;
  if (alt != null && alt > 10000) return false;
  if (nearerExclude(ac)) return false;

  const dist = typeof ac.dst === "number" ? ac.dst : null;
  if (dist == null || dist > OFFICE.radiusNm) return false;

  const toward = bearingFrom(ac.lat, ac.lon, OFFICE.lat, OFFICE.lon);
  const trackDiff = typeof ac.track === "number" ? angleDiff(ac.track, toward) : 180;
  const descending = typeof ac.baro_rate === "number" && ac.baro_rate < -128;
  const low = alt != null && alt <= 6000;

  return trackDiff <= 50 || (low && descending && trackDiff <= 90);
}

function isExcludedDest(route) {
  if (!route || EXCLUDE_DEST.size === 0) return false;
  const dest = String(route.destination || "").toUpperCase();
  return EXCLUDE_DEST.has(dest);
}

function etaMinutes(distNm, gsKts) {
  if (!distNm || !gsKts || gsKts <= 0) return null;
  return Math.round((distNm / gsKts) * 60);
}

function approachScore(ac) {
  const dist = typeof ac.dst === "number" ? ac.dst : OFFICE.radiusNm;
  const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : 15000;
  const gs = typeof ac.gs === "number" ? ac.gs : 0;
  const vRate = typeof ac.baro_rate === "number" ? ac.baro_rate : 0;
  const toward = bearingFrom(ac.lat, ac.lon, OFFICE.lat, OFFICE.lon);
  const trackDiff = typeof ac.track === "number" ? angleDiff(ac.track, toward) : 90;

  let score = 1000 - dist * 40;
  score -= alt / 40;
  score -= trackDiff * 2;
  if (vRate < -256) score += 120;
  else if (vRate < 0) score += 60;
  if (gs > 120) score += 20;
  return score;
}

function normalizeAircraft(raw, route) {
  const callsign = trimCallsign(raw.flight);
  const dist = typeof raw.dst === "number" ? raw.dst : null;
  const gs = typeof raw.gs === "number" ? raw.gs : null;
  const alt = raw.alt_baro === "ground" ? 0 : raw.alt_baro;
  let bearingDeg = typeof raw.dir === "number" ? Math.round(raw.dir) : null;
  if (
    bearingDeg == null &&
    OFFICE.lat != null &&
    OFFICE.lon != null &&
    typeof raw.lat === "number" &&
    typeof raw.lon === "number"
  ) {
    bearingDeg = Math.round(bearingFrom(OFFICE.lat, OFFICE.lon, raw.lat, raw.lon));
  }

  return {
    hex: raw.hex ?? "",
    callsign: callsign || raw.r || raw.hex?.toUpperCase() || "Unknown",
    registration: raw.r ?? "",
    typeCode: raw.t ?? "",
    typeName: typeLabel(raw.t),
    category: categoryLabel(raw.category),
    altFt: typeof alt === "number" ? Math.round(alt) : null,
    gsKts: gs != null ? Math.round(gs) : null,
    trackDeg: typeof raw.track === "number" ? Math.round(raw.track) : null,
    vRateFpm: typeof raw.baro_rate === "number" ? Math.round(raw.baro_rate) : null,
    squawk: raw.squawk ?? "",
    distanceNm: dist != null ? Math.round(dist * 10) / 10 : null,
    bearingDeg,
    etaMin: etaMinutes(dist, gs),
    navAltFt: typeof raw.nav_altitude_mcp === "number" ? Math.round(raw.nav_altitude_mcp) : null,
    navHeadingDeg: typeof raw.nav_heading === "number" ? Math.round(raw.nav_heading) : null,
    emergency: raw.emergency && raw.emergency !== "none" ? raw.emergency : "",
    route: route ?? null,
    score: approachScore(raw),
  };
}

async function fetchPoint() {
  if (OFFICE.lat == null || OFFICE.lon == null) {
    throw new Error("Set OFFICE_LAT and OFFICE_LON in carthingy.conf");
  }
  const url = `${ADSB_BASE}/${OFFICE.lat}/${OFFICE.lon}/${OFFICE.radiusNm}`;
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`adsb.lol ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.ac) ? payload.ac : [];
}

async function fetchRoutes(planes) {
  const needed = planes.filter((plane) => {
    const key = plane.callsign;
    if (!key) return false;
    const cached = routeCache.get(key);
    return !cached || Date.now() - cached.at > ROUTE_TTL_MS;
  });

  if (needed.length === 0) return;

  const body = {
    planes: needed.slice(0, 12).map((plane) => ({
      callsign: plane.callsign,
      lat: plane.lat,
      lng: plane.lon,
    })),
  };

  try {
    const response = await fetch(ROUTE_URL, {
      method: "POST",
      headers: { ...FETCH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) return;

    const text = await response.text();
    if (!text) return;

    const routes = JSON.parse(text);
    if (!Array.isArray(routes)) return;

    for (const entry of routes) {
      const key = trimCallsign(entry.callsign);
      if (!key || !Array.isArray(entry._airports) || entry._airports.length < 2) continue;

      const origin = entry._airports[0];
      const dest = entry._airports[entry._airports.length - 1];
      routeCache.set(key, {
        at: Date.now(),
        value: {
          origin: origin.iata || origin.icao,
          originName: origin.name,
          originCity: origin.location,
          destination: dest.iata || dest.icao,
          destinationName: dest.name,
          destinationCity: dest.location,
          codes: entry._airport_codes_iata || entry.airport_codes || "",
        },
      });
    }
  } catch {
    return;
  }
}

function routeForCallsign(callsign) {
  const cached = routeCache.get(callsign);
  return cached?.value ?? null;
}

export function flightsConfig() {
  return { ...OFFICE, refreshMs: REFRESH_MS };
}

export async function getFlightsSnapshot(force = false) {
  const age = Date.now() - cache.fetchedAt;
  if (!force && cache.data && age < REFRESH_MS) {
    return cache;
  }

  try {
    const rawList = await fetchPoint();
    const approaching = rawList.filter(isApproaching);
    approaching.sort((a, b) => approachScore(b) - approachScore(a));

    const top = approaching.slice(0, 6);
    await fetchRoutes(
      top.map((ac) => ({
        callsign: trimCallsign(ac.flight) || ac.r,
        lat: ac.lat,
        lon: ac.lon,
      })),
    );

    const aircraft = top
      .map((ac) => {
        const callsign = trimCallsign(ac.flight) || ac.r || ac.hex?.toUpperCase();
        return normalizeAircraft(ac, routeForCallsign(callsign));
      })
      .filter((plane) => !isExcludedDest(plane.route))
      .slice(0, 4);

    cache = {
      data: {
        office: OFFICE,
        airports: parseRadarAirports(),
        aircraft,
        totalSeen: rawList.length,
        approachingCount: approaching.length,
      },
      error: null,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    cache = {
      data: cache.data,
      error: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now(),
    };
  }

  return cache;
}
