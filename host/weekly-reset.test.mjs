import test from "node:test";
import assert from "node:assert/strict";
import { formatWeeklyReset, parseWeeklyReset, weeklyResetLabel } from "./weekly-reset.mjs";

test("parses 24h weekday time", () => {
  assert.deepEqual(parseWeeklyReset("Thu 21:00"), { weekday: 4, hour: 21, minute: 0 });
  assert.deepEqual(parseWeeklyReset("friday 3:30"), { weekday: 5, hour: 3, minute: 30 });
});

test("parses 12h am/pm", () => {
  assert.deepEqual(parseWeeklyReset("Thu 9:00 PM"), { weekday: 4, hour: 21, minute: 0 });
  assert.deepEqual(parseWeeklyReset("Sun 12am"), { weekday: 0, hour: 0, minute: 0 });
  assert.deepEqual(parseWeeklyReset("Sun 12:15 pm"), { weekday: 0, hour: 12, minute: 15 });
});

test("rejects junk", () => {
  assert.equal(parseWeeklyReset(""), null);
  assert.equal(parseWeeklyReset("tomorrow"), null);
  assert.equal(parseWeeklyReset("Thu 25:00"), null);
  assert.equal(parseWeeklyReset("Thu 13:00 PM"), null);
});

test("formats a readable schedule, not a countdown", () => {
  assert.equal(formatWeeklyReset({ weekday: 4, hour: 21, minute: 0 }), "Thursday 9 PM");
  assert.equal(formatWeeklyReset({ weekday: 1, hour: 9, minute: 5 }), "Monday 9:05 AM");
  assert.equal(weeklyResetLabel("Thu 21:00"), "Resets Thursday 9 PM");
  assert.equal(weeklyResetLabel(""), "");
});
