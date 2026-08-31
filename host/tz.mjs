import fs from "node:fs";

function zoneFromLocaltime() {
  try {
    const target = fs.readlinkSync("/etc/localtime");
    const marker = "zoneinfo/";
    const i = target.lastIndexOf(marker);
    if (i >= 0) return target.slice(i + marker.length);
  } catch {
    /* copied file, not a symlink */
  }
  return null;
}

export function hostTimeZone() {
  const explicit = process.env.CARTHINGY_TZ;
  if (explicit) return explicit;
  return zoneFromLocaltime() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function wallParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type) => {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === type) return parts[i].value;
    }
    return "";
  };
  const weekdayName = get("weekday");
  const weekdayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayMap[weekdayName] ?? 0,
  };
}

export function localParts(ms, timeZone) {
  const p = wallParts(ms, timeZone || hostTimeZone());
  return {
    date: p.year + "-" + pad2(p.month) + "-" + pad2(p.day),
    hour: p.hour,
    weekday: p.weekday,
  };
}

export function tzOffsetMinutesAt(ms, timeZone) {
  const p = wallParts(ms, timeZone || hostTimeZone());
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((ms - wallAsUtc) / 60000);
}
