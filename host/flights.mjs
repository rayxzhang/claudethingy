import { compareVisibility, createObserver, scoreSighting } from "./visibility.mjs";

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

const OFFICE = {
  lat: envNumber("OFFICE_LAT"),
  lon: envNumber("OFFICE_LON"),
  radiusNm: envNumber("OFFICE_RADIUS_NM") ?? 7,
  label: process.env.OFFICE_LABEL || "Office",
};

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

function distanceNm(ac) {
  if (typeof ac.dst === "number") return ac.dst;
  if (
    OFFICE.lat != null &&
    OFFICE.lon != null &&
    typeof ac.lat === "number" &&
    typeof ac.lon === "number"
  ) {
    return haversineNm(ac.lat, ac.lon, OFFICE.lat, OFFICE.lon);
  }
  return Infinity;
}

function isInView(ac) {
  if (OFFICE.lat == null || OFFICE.lon == null) return false;
  if (ac.lat == null || ac.lon == null) return false;
  if (ac.alt_baro === "ground") return false;
  return distanceNm(ac) <= OFFICE.radiusNm;
}

function toSighting(ac) {
  const dist = distanceNm(ac);
  let bearingDeg = typeof ac.dir === "number" ? Math.round(ac.dir) : null;
  if (
    bearingDeg == null &&
    OFFICE.lat != null &&
    OFFICE.lon != null &&
    typeof ac.lat === "number" &&
    typeof ac.lon === "number"
  ) {
    bearingDeg = Math.round(bearingFrom(OFFICE.lat, OFFICE.lon, ac.lat, ac.lon));
  }
  const alt = ac.alt_baro === "ground" ? 0 : ac.alt_baro;
  const emergency = ac.emergency && ac.emergency !== "none" ? String(ac.emergency) : "";
  return {
    hex: ac.hex ?? "",
    lat: ac.lat,
    lon: ac.lon,
    altFt: typeof alt === "number" ? Math.round(alt) : 0,
    gsKts: typeof ac.gs === "number" ? ac.gs : null,
    trackDeg: typeof ac.track === "number" ? ac.track : null,
    categoryCode: typeof ac.category === "string" ? ac.category.toUpperCase() : "",
    typeCode: typeof ac.t === "string" ? ac.t : "",
    distanceNm: Number.isFinite(dist) ? dist : 0,
    bearingDeg,
    squawk: ac.squawk != null ? String(ac.squawk) : "",
    emergency,
  };
}

function normalizeAircraft(raw, sighting, route, vis) {
  const callsign = trimCallsign(raw.flight);
  const alt = raw.alt_baro === "ground" ? 0 : raw.alt_baro;
  return {
    hex: sighting.hex,
    callsign: callsign || raw.r || raw.hex?.toUpperCase() || "Unknown",
    registration: raw.r ?? "",
    typeCode: sighting.typeCode,
    typeName: typeLabel(raw.t),
    category: categoryLabel(raw.category),
    altFt: typeof alt === "number" ? Math.round(alt) : null,
    gsKts: sighting.gsKts != null ? Math.round(sighting.gsKts) : null,
    trackDeg: typeof sighting.trackDeg === "number" ? Math.round(sighting.trackDeg) : null,
    vRateFpm: typeof raw.baro_rate === "number" ? Math.round(raw.baro_rate) : null,
    squawk: sighting.squawk,
    distanceNm: Number.isFinite(sighting.distanceNm)
      ? Math.round(sighting.distanceNm * 10) / 10
      : null,
    bearingDeg: sighting.bearingDeg,
    navAltFt: typeof raw.nav_altitude_mcp === "number" ? Math.round(raw.nav_altitude_mcp) : null,
    navHeadingDeg: typeof raw.nav_heading === "number" ? Math.round(raw.nav_heading) : null,
    emergency: sighting.emergency,
    route: route ?? null,
    score: vis.score,
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
    const observer = createObserver(OFFICE);
    const inView = rawList.filter(isInView);
    const ranked = [];
    for (const ac of inView) {
      const sighting = toSighting(ac);
      if (!sighting.hex) continue;
      ranked.push({ ac, sighting, vis: scoreSighting(sighting, observer) });
    }
    ranked.sort((a, b) => compareVisibility(a.vis, b.vis));
    const top = ranked.slice(0, 16);
    await fetchRoutes(
      top.map(({ ac }) => ({
        callsign: trimCallsign(ac.flight) || ac.r,
        lat: ac.lat,
        lon: ac.lon,
      })),
    );

    const aircraft = top.map(({ ac, sighting, vis }) => {
      const callsign = trimCallsign(ac.flight) || ac.r || ac.hex?.toUpperCase();
      return normalizeAircraft(ac, sighting, routeForCallsign(callsign), vis);
    });

    cache = {
      data: {
        office: OFFICE,
        airports: parseRadarAirports(),
        aircraft,
        totalSeen: rawList.length,
        inViewCount: inView.length,
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
