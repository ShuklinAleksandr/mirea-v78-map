import test from "node:test";
import assert from "node:assert/strict";
import {
  createRouteLocationDisplay,
  ROUTE_LOCATION_HOLD_MS,
} from "../src/data/route-location-display.js";
import { createRouteTracker } from "../src/data/route-tracking.js";

const T = 1_800_000_000_000;
function observation(index, status = "tracking", extra = {}) {
  const timestamp = T + index * 1_000;
  return {
    now: timestamp,
    sourceSegmentIndex: 0,
    location: {
      source: "gps",
      campusId: "v-78",
      status: "inside",
      trackingStatus: "live",
      point: [index, 1],
      timestamp,
      accuracyMeters: 5,
      accuracyRadiusMap: 5,
      ...extra.location,
    },
    progress: {
      status,
      reason: null,
      floorId: "floor2",
      matchedPoint: status === "tracking" ? [index, 0] : null,
      locationTimestamp: timestamp,
      distance: index,
      stepIndex: 1,
      ...extra.progress,
    },
  };
}

test("a brief loss shows the last confirmed point without changing the GPS or route progress", () => {
  for (const status of ["off-route", "low-accuracy", "stale", "acquiring"]) {
    const display = createRouteLocationDisplay();
    display.update(observation(1));
    const input = observation(2, status, {
      location: { point: [8, 6], accuracyMeters: 14 },
      progress: { distance: 1 },
    });
    const original = structuredClone(input);
    const match = display.update(input);
    assert.deepEqual(match.point, [1, 0]);
    assert.equal(match.held, true);
    assert.equal(match.status, "uncertain");
    assert.equal(match.confirmedAt, T + 1_000);
    assert.equal(match.expiresAt, T + 1_000 + ROUTE_LOCATION_HOLD_MS);
    assert.equal(display.expiresAt, match.expiresAt);
    assert.deepEqual(
      input,
      original,
      "display cannot advance steps or edit a fix",
    );
  }
});

test("repeated poor fixes, duplicate callbacks and reads cannot renew the hold deadline", () => {
  const display = createRouteLocationDisplay();
  display.update(observation(1));
  const firstHold = display.update(observation(2, "off-route"));
  for (let index = 3; index <= 12; index++) {
    const input = observation(index, "off-route");
    for (let repeat = 0; repeat < 3; repeat++) {
      const held = display.update(input);
      assert.equal(held.heldSince, firstHold.heldSince);
      assert.equal(held.expiresAt, T + 13_000);
      assert.deepEqual(held.point, [1, 0]);
    }
  }
  assert.equal(
    display.read(T + 13_000),
    null,
    "read expires even without a callback",
  );
  assert.equal(display.update(observation(13, "off-route")), null);
  assert.equal(display.update(observation(14, "off-route")), null);
  assert.equal(display.expiresAt, null);
});

test("a first acquisition cannot invent a held position", () => {
  const display = createRouteLocationDisplay();
  assert.equal(display.update(observation(1, "acquiring")), null);
  assert.equal(display.update(observation(2, "low-accuracy")), null);
  assert.equal(display.expiresAt, null);
});

test("tentative matched motion passes through but never renews a confirmed anchor", () => {
  const display = createRouteLocationDisplay();
  display.update(observation(1));
  const tentative = display.update(
    observation(8, "uncertain", { progress: { matchedPoint: [8, 0] } }),
  );
  assert.equal(tentative.held, false);
  assert.deepEqual(tentative.point, [8, 0]);
  assert.equal(display.expiresAt, null);
  assert.deepEqual(display.update(observation(9, "off-route")).point, [1, 0]);
  assert.equal(display.update(observation(13, "off-route")), null);
});

test("confirmed reverse movement and stair/end boundaries retain their actual matched point", () => {
  for (const status of ["wrong-way", "floor-change", "arrived"]) {
    const display = createRouteLocationDisplay();
    const point = [3, 2];
    const match = display.update(
      observation(1, status, { progress: { matchedPoint: point } }),
    );
    assert.equal(match.held, false);
    assert.equal(match.status, status);
    assert.deepEqual(display.update(observation(2, "stale")).point, point);
  }
});

test("manual steps, mismatched floors and an explicit campus departure clear the hold", () => {
  for (const [status, reason] of [
    ["waiting", "manual-step"],
    ["floor-mismatch", "confirm-route-floor"],
    ["floor-mismatch", "confirm-route-physical-floor"],
    ["off-route", "outside-route-campus"],
    ["waiting", "missing-route-geometry"],
    ["waiting", "gps-required"],
  ]) {
    const display = createRouteLocationDisplay();
    display.update(observation(1));
    assert.equal(
      display.update(observation(2, status, { progress: { reason } })),
      null,
    );
    assert.equal(display.update(observation(3, "off-route")), null);
  }
});

test("route sections, correction changes and manual floor contexts cannot reuse an old anchor", () => {
  const cases = [
    (input) => {
      input.sourceSegmentIndex = 1;
    },
    (input) => {
      input.progress.floorId = "floor3";
    },
    (input) => {
      input.location.campusId = "another-campus";
    },
    (input) => {
      input.location.correction = { createdAt: T + 1_500 };
    },
    (input) => {
      input.location.floorEvidence = "manual";
    },
    (input) => {
      input.location.floorEvidence = "manual";
      input.location.floorId = "floor3";
    },
    (input) => {
      input.location.floorEvidence = "manual";
      input.location.floorId = "floor2";
      input.location.building = "Г";
      input.location.physicalLevel = 3;
    },
  ];
  for (const change of cases) {
    const display = createRouteLocationDisplay();
    display.update(observation(1));
    const input = observation(2, "off-route");
    change(input);
    assert.equal(display.update(input), null);
  }
});

test("disabled navigation and reset cannot later revive a frozen marker", () => {
  for (const reset of [
    (display) => display.reset(),
    (display) => display.update({ enabled: false }),
  ]) {
    const display = createRouteLocationDisplay();
    display.update(observation(1));
    display.update(observation(2, "off-route"));
    reset(display);
    assert.equal(display.read(T + 3_000), null);
    assert.equal(display.update(observation(3, "acquiring")), null);
  }
});

test("replayed and future-dated fixes neither renew the hold nor block subsequent recovery", () => {
  const display = createRouteLocationDisplay();
  display.update(observation(1));
  display.update(observation(2, "off-route"));
  const replay = observation(1);
  replay.now = T + 3_000;
  assert.equal(display.update(replay).held, true);
  const future = observation(100);
  future.now = T + 4_000;
  assert.equal(display.update(future).held, true);
  const recovered = display.update(observation(5));
  assert.equal(recovered.held, false);
  assert.deepEqual(recovered.point, [5, 0]);
});

test("an expired manual correction clears a held point immediately", () => {
  const display = createRouteLocationDisplay();
  const correction = { createdAt: T, expiresAt: T + 3_000 };
  display.update(observation(1, "tracking", { location: { correction } }));
  assert.equal(
    display.update(observation(2, "stale", { location: { correction } })).held,
    true,
  );
  assert.equal(
    display.update(observation(3, "stale", { location: { correction } })),
    null,
  );
});

test("returned coordinates cannot mutate the retained confirmed position", () => {
  const display = createRouteLocationDisplay();
  const input = observation(1);
  const match = display.update(input);
  match.point[0] = 100;
  input.progress.matchedPoint[0] = 200;
  const held = display.update(observation(2, "off-route"));
  assert.deepEqual(held.point, [1, 0]);
  held.point[0] = 300;
  assert.deepEqual(display.read(T + 3_000).point, [1, 0]);
});

test("the real tracker still needs its existing two good fixes to recover, without display-driven progress", () => {
  const tracker = createRouteTracker({
    campusId: "v-78",
    distanceMeters: 30,
    segments: [
      {
        floorId: "floor2",
        points: [
          [0, 0],
          [30, 0],
        ],
      },
    ],
    steps: [
      { kind: "start", floorId: "floor2", position: [0, 0] },
      { kind: "arrive", floorId: "floor2", position: [30, 0] },
    ],
  });
  const display = createRouteLocationDisplay();
  function observe(index, point) {
    const input = observation(index, "tracking", { location: { point } });
    input.progress = tracker.update(input.location, {
      now: input.now,
      floorId: "floor2",
    });
    const before = structuredClone(tracker.snapshot());
    const match = display.update(input);
    assert.deepEqual(tracker.snapshot(), before);
    return { match, progress: before };
  }
  assert.equal(observe(0, [0, 0]).match, null);
  assert.equal(observe(1, [1, 0]).match.held, false);
  const loss = observe(2, [2, 8]);
  assert.equal(loss.progress.status, "off-route");
  assert.equal(loss.match.held, true);
  const first = observe(3, [3, 0]);
  assert.equal(first.progress.status, "acquiring");
  assert.equal(first.progress.distance, loss.progress.distance);
  assert.equal(first.match.held, true);
  const second = observe(4, [4, 0]);
  assert.equal(second.progress.status, "tracking");
  assert.equal(second.match.held, false);
  assert.deepEqual(second.match.point, [4, 0]);
});
