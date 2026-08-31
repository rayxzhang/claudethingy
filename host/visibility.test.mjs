import test from "node:test";
import assert from "node:assert/strict";
import { createObserver, scoreSighting, compareVisibility } from "./visibility.mjs";

const observer = createObserver({ lat: 37.4, lon: -122.05, radiusNm: 7 });

function sighting(over) {
  return {
    hex: "a00000",
    lat: 37.45,
    lon: -122.05,
    altFt: 2000,
    gsKts: 250,
    trackDeg: 180,
    categoryCode: "A5",
    typeCode: "",
    distanceNm: 3,
    bearingDeg: 0,
    squawk: "",
    emergency: "",
    ...over,
  };
}

function run(name, fn) {
  test(name, () => {
    fn();
    console.log("pass " + name);
  });
}

run("heavy at 3nm / 2000ft beats Cessna at 0.8nm / 9000ft", () => {
  const heavy = scoreSighting(
    sighting({
      hex: "heavy",
      categoryCode: "A5",
      typeCode: "",
      distanceNm: 3,
      altFt: 2000,
      gsKts: 250,
      bearingDeg: 0,
      trackDeg: 180,
    }),
    observer,
  );
  const cessna = scoreSighting(
    sighting({
      hex: "cessna",
      categoryCode: "A1",
      typeCode: "",
      distanceNm: 0.8,
      altFt: 9000,
      gsKts: 120,
      bearingDeg: 0,
      trackDeg: 180,
    }),
    observer,
  );
  assert.ok(heavy.score > cessna.score, `heavy ${heavy.score} vs cessna ${cessna.score}`);
});

run("closing scores higher than receding twin", () => {
  const closing = scoreSighting(
    sighting({ hex: "in", trackDeg: 180, bearingDeg: 0 }),
    observer,
  );
  const receding = scoreSighting(
    sighting({ hex: "out", trackDeg: 0, bearingDeg: 0 }),
    observer,
  );
  assert.ok(closing.closingFps > 0);
  assert.ok(receding.closingFps < 0);
  assert.ok(closing.score > receding.score, `closing ${closing.score} vs receding ${receding.score}`);
});

run("7700 at 6nm pins over a normal A5 at 2nm", () => {
  const emer = scoreSighting(
    sighting({
      hex: "emer",
      distanceNm: 6,
      altFt: 4000,
      categoryCode: "A5",
      squawk: "7700",
      emergency: "",
    }),
    observer,
  );
  const nearby = scoreSighting(
    sighting({
      hex: "nearby",
      distanceNm: 2,
      altFt: 2000,
      categoryCode: "A5",
      squawk: "",
      emergency: "",
    }),
    observer,
  );
  assert.equal(emer.emergency, true);
  assert.equal(nearby.emergency, false);
  assert.ok(emer.score >= 1e9);
  assert.ok(emer.score > nearby.score);
  assert.ok(compareVisibility(emer, nearby) < 0);
});

run("alt 0 still scores; host isInView drops ground before the scorer", () => {
  const vis = scoreSighting(sighting({ hex: "taxi", altFt: 0, distanceNm: 1 }), observer);
  assert.ok(Number.isFinite(vis.score));
});
