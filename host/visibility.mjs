const NM_FT = 6076.12;
const KTS_TO_FPS = 1.68781;
const OBSERVER_ALT_FT = 50;
const ELEV_MIN_DEG = -2;
const ELEV_MAX_DEG = 45;
const ELEV_SIGMA_DEG = 12;
const CLOSING_REF_FPS = 400;
const CLOSING_GAIN_MIN = -0.15;
const CLOSING_GAIN_MAX = 0.35;
const EMERGENCY_PIN = 1e9;
const EMERGENCY_SQUAWKS = { "7500": true, "7600": true, "7700": true };

const CATEGORY_SPAN = {
  A0: 70,
  A1: 38,
  A2: 55,
  A3: 115,
  A4: 160,
  A5: 200,
  A6: 40,
  A7: 42,
  B0: 70,
  B1: 70,
  B2: 70,
  B3: 70,
  B4: 70,
  B5: 70,
  B6: 8,
  B7: 70,
};

const TYPE_SPAN = {
  A388: 262,
  B77W: 213,
  A359: 212,
  B789: 197,
  B738: 113,
  A320: 112,
  A321: 117,
  B39M: 118,
  E75L: 94,
};

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function spanFt(typeCode, categoryCode) {
  return TYPE_SPAN[typeCode] || CATEGORY_SPAN[categoryCode] || 70;
}

function isEmergencySighting(sighting) {
  const squawk = sighting.squawk == null ? "" : String(sighting.squawk);
  if (EMERGENCY_SQUAWKS[squawk]) return true;
  return Boolean(sighting.emergency);
}

export function createObserver(office) {
  const alt = office && Number.isFinite(office.observerAltFt) ? office.observerAltFt : OBSERVER_ALT_FT;
  return {
    lat: office.lat,
    lon: office.lon,
    radiusNm: office.radiusNm,
    altFt: alt,
  };
}

export function scoreSighting(sighting, observer) {
  const altFt = Number.isFinite(sighting.altFt) ? sighting.altFt : 0;
  const observerAlt = observer && Number.isFinite(observer.altFt) ? observer.altFt : OBSERVER_ALT_FT;
  const groundFt = (Number.isFinite(sighting.distanceNm) ? sighting.distanceNm : 0) * NM_FT;
  const dAltFt = altFt - observerAlt;
  const slantFt = Math.max(Math.hypot(groundFt, dAltFt), 1);
  const span = spanFt(sighting.typeCode, sighting.categoryCode);
  const thetaMrad = (span / slantFt) * 1000;
  const elevDeg = (Math.atan2(dAltFt, groundFt) * 180) / Math.PI;

  let elevWeight = 1;
  if (elevDeg < ELEV_MIN_DEG || elevDeg > ELEV_MAX_DEG) {
    const excess = elevDeg > ELEV_MAX_DEG ? elevDeg - ELEV_MAX_DEG : ELEV_MIN_DEG - elevDeg;
    elevWeight = Math.exp(-((excess / ELEV_SIGMA_DEG) ** 2));
  }

  let closingFps = 0;
  if (
    Number.isFinite(sighting.gsKts) &&
    Number.isFinite(sighting.trackDeg) &&
    Number.isFinite(sighting.bearingDeg)
  ) {
    const radialKts =
      -sighting.gsKts * Math.cos(((sighting.trackDeg - sighting.bearingDeg) * Math.PI) / 180);
    closingFps = radialKts * KTS_TO_FPS;
  }

  const closingGain = 1 + clamp(closingFps / CLOSING_REF_FPS, CLOSING_GAIN_MIN, CLOSING_GAIN_MAX);
  let score = thetaMrad * elevWeight * closingGain;
  const emergency = isEmergencySighting(sighting);
  if (emergency) score += EMERGENCY_PIN;

  return {
    score,
    thetaMrad,
    slantNm: slantFt / NM_FT,
    elevDeg,
    closingFps,
    emergency,
  };
}

export function compareVisibility(a, b) {
  if (a.emergency !== b.emergency) return a.emergency ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.thetaMrad !== b.thetaMrad) return b.thetaMrad - a.thetaMrad;
  return a.slantNm - b.slantNm;
}
