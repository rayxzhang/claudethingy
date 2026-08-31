const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function parseWeeklyReset(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const match = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  const dayIdx = DAYS.indexOf(match[1].toLowerCase().slice(0, 3));
  if (dayIdx < 0) return null;

  const rawHour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const ampm = (match[4] || "").toLowerCase();
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  let hour = rawHour;
  if (ampm) {
    if (rawHour < 1 || rawHour > 12) return null;
    if (ampm === "pm" && rawHour < 12) hour = rawHour + 12;
    if (ampm === "am" && rawHour === 12) hour = 0;
  } else if (rawHour < 0 || rawHour > 23) {
    return null;
  }

  return { weekday: dayIdx, hour, minute };
}

export function formatWeeklyReset(spec) {
  if (!spec) return "";
  const hour12 = spec.hour % 12 || 12;
  const meridian = spec.hour >= 12 ? "PM" : "AM";
  const minutes =
    spec.minute === 0 ? "" : `:${String(spec.minute).padStart(2, "0")}`;
  return `${DAY_LABELS[spec.weekday]} ${hour12}${minutes} ${meridian}`;
}

export function weeklyResetLabel(raw = process.env.WEEKLY_RESET) {
  const spec = parseWeeklyReset(raw);
  return spec ? `Resets ${formatWeeklyReset(spec)}` : "";
}
