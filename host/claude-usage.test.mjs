import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsage } from "./claude-usage.mjs";

const creds = { claudeAiOauth: { subscriptionType: "pro" } };

test("legacy five_hour utilization is a 0-1 fraction", () => {
  const u = normalizeUsage(
    {
      five_hour: { utilization: 0.35, resets_at: "2026-08-31T08:00:00Z" },
      seven_day: { utilization: 0.14, resets_at: "2026-09-06T20:00:00Z" },
    },
    creds,
  );
  assert.equal(u.session.percent, 35);
  assert.equal(u.weekly.percent, 14);
  assert.equal(u.session.id, "session");
  assert.equal(u.weekly.id, "weekly");
});

test("limits[] percent is already 0-100", () => {
  const u = normalizeUsage(
    {
      limits: [
        { kind: "session", percent: 4, resets_at: "t", is_active: true },
        { kind: "weekly_all", percent: 2, resets_at: "w" },
      ],
    },
    creds,
  );
  assert.equal(u.session.percent, 4);
  assert.equal(u.weekly.percent, 2);
});

test("limits[] utilization fraction plus kind aliases", () => {
  const u = normalizeUsage(
    {
      limits: [
        { kind: "five_hour", utilization: 0.5, resets_at: "t" },
        { kind: "seven_day", utilization: 0.2, resets_at: "w" },
      ],
    },
    creds,
  );
  assert.equal(u.session.percent, 50);
  assert.equal(u.weekly.percent, 20);
});

test("rate_limits used_percentage is already 0-100", () => {
  const u = normalizeUsage(
    {
      rate_limits: {
        five_hour: { used_percentage: 41, resets_at: "t" },
        seven_day: { used_percentage: 9, resets_at: "w" },
      },
    },
    creds,
  );
  assert.equal(u.session.percent, 41);
  assert.equal(u.weekly.percent, 9);
});

test("1.0 utilization is 1 percent, not 100", () => {
  const u = normalizeUsage({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }, creds);
  assert.equal(u.session.percent, 1);
  assert.equal(u.weekly.percent, 1);
});
