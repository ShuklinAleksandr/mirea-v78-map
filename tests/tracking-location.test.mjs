import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCATION_CALIBRATION_REVIEW_MS,
  normalizeTrackingFloor,
  createLocationCalibration,
  applyLocationTracking,
} from "../src/data/location-tracking.js";

const now = 1_800_000_000_000;
const floors = [
  {
    id: "v-78-floor2",
    campusId: "v-78",
    level: 2,
    buildingLevels: { А: 2, Г: 3 },
  },
];
const selection = {
  campusId: "v-78",
  floorId: "v-78-floor2",
  building: "Г",
  physicalLevel: 3,
};
const floor = normalizeTrackingFloor(selection, floors);
const fix = (options = {}) => ({
  source: "gps",
  campusId: "v-78",
  floorId: null,
  building: null,
  point: [12, 20],
  accuracyMeters: 8,
  accuracyRadiusMap: 9,
  latitude: 55.669957,
  longitude: 37.480225,
  timestamp: now,
  expiresAt: now + 60_000,
  status: "inside",
  registrationStatus: "approximate",
  ...options,
});
const anchor = () => ({
  source: "manual",
  ...selection,
  point: [30, 25],
  timestamp: now,
  label: "Коридор",
});

test("physical floor assignment requires an explicit matching building and physical floor", () => {
  assert.deepEqual(floor, { ...selection, floorEvidence: "manual" });
  assert.equal(
    normalizeTrackingFloor(
      { campusId: "v-78", floorId: "v-78-floor2" },
      floors,
    ),
    null,
  );
  assert.equal(
    normalizeTrackingFloor({ ...selection, physicalLevel: 2 }, floors),
    null,
    "source level 2 is not physical floor 2 in Г",
  );
  assert.equal(
    normalizeTrackingFloor({ ...selection, building: "Б" }, floors),
    null,
  );
  assert.equal(
    normalizeTrackingFloor({ ...selection, campusId: "v-86" }, floors),
    null,
  );
  assert.equal(
    normalizeTrackingFloor({ ...selection, floorId: "not-loaded" }, floors),
    null,
  );
});

test("uncalibrated GPS keeps an unknown floor until the user's explicit confirmation", () => {
  const unknown = applyLocationTracking(fix(), { now });
  assert.equal(unknown.status, "tracking");
  assert.equal(unknown.location.floorEvidence, "unknown");
  assert.equal(unknown.location.floorId, null);
  assert.equal(unknown.location.physicalLevel, null);
  const assigned = applyLocationTracking(fix(), { now, floor });
  assert.equal(assigned.location.building, "Г");
  assert.equal(assigned.location.physicalLevel, 3);
  assert.equal(assigned.location.floorEvidence, "manual");
  assert.deepEqual(assigned.location.point, fix().point);
  const unconfirmed = applyLocationTracking(fix(), { now, floor: selection });
  assert.equal(
    unconfirmed.location.floorId,
    null,
    "unvalidated view state is not floor evidence",
  );
});

test("manual alignment preserves measured uncertainty and only transfers later actual GPS displacement", () => {
  const raw = fix();
  const manual = anchor();
  const calibration = createLocationCalibration(manual, raw, { now, floor });
  assert.deepEqual(calibration.offset, [18, 5]);
  const first = applyLocationTracking(raw, { now, floor, calibration });
  assert.deepEqual(first.location.point, manual.point);
  assert.equal(first.location.source, "gps");
  assert.equal(first.location.floorEvidence, "manual");
  assert.equal(first.location.correction.approximate, true);
  const nextFix = fix({
    point: [14, 23],
    timestamp: now + 3000,
    accuracyMeters: 4,
    accuracyRadiusMap: 5,
  });
  const next = applyLocationTracking(nextFix, {
    now: now + 3000,
    floor,
    calibration: first.calibration,
    previous: first.location,
  });
  assert.deepEqual(next.location.point, [32, 28]);
  assert.deepEqual(next.location.rawPoint, [14, 23]);
  assert.equal(next.location.timestamp, nextFix.timestamp);
  assert.equal(
    next.location.accuracyMeters,
    8,
    "manual correction cannot advertise better accuracy",
  );
  assert.equal(next.location.accuracyRadiusMap, 9);
  assert.equal(
    next.location.latitude,
    nextFix.latitude,
    "latitude remains the real provider measurement",
  );
  assert.deepEqual(raw.point, [12, 20]);
  assert.deepEqual(manual.point, [30, 25]);
  assert.deepEqual(
    calibration.lastRawPoint,
    [12, 20],
    "helper does not mutate previous calibration",
  );
});

test("manual corridor anchor can use a separately confirmed building and floor", () => {
  const manual = { ...anchor(), building: null, physicalLevel: null };
  const calibration = createLocationCalibration(manual, fix(), { now, floor });
  const result = applyLocationTracking(fix(), { now, calibration });
  assert.equal(result.location.physicalLevel, 3);
  assert.equal(result.location.building, "Г");
  assert.throws(
    () =>
      createLocationCalibration(manual, fix(), {
        now,
        floor: { ...floor, floorId: "different" },
      }),
    /не совпадают/,
  );
});

test("known anchor identity cannot inherit an incompatible earlier floor selection on the same source plan", () => {
  // Source floor2 includes the entrance hall's physical floor 2 and Г's floor 3.
  // Matching only floorId would incorrectly label the hall as Г/3.
  for (const manual of [
    { ...anchor(), building: null, physicalLevel: 2 },
    { ...anchor(), building: "А", physicalLevel: null },
    { ...anchor(), building: "А", physicalLevel: 2 },
  ]) {
    assert.throws(
      () => createLocationCalibration(manual, fix(), { now, floor }),
      /Корпус или этаж.*не совпадают/,
    );
    assert.equal(
      manual.floorId,
      floor.floorId,
      "the source level alone is insufficient evidence",
    );
  }
  const compatiblePartial = createLocationCalibration(
    { ...anchor(), building: null, physicalLevel: 3 },
    fix(),
    { now, floor },
  );
  assert.equal(compatiblePartial.floor.physicalLevel, 3);
  assert.equal(compatiblePartial.floor.building, "Г");
});

test("alignment needs a fresh manual anchor and a fresh sufficiently precise GPS observation", () => {
  for (const raw of [
    fix({ timestamp: now - 10_001 }),
    fix({ accuracyMeters: 51 }),
    fix({ campusId: "v-86" }),
    fix({ status: "outside", point: null }),
  ])
    assert.throws(
      () => createLocationCalibration(anchor(), raw, { now }),
      /свежий GPS/,
    );
  assert.throws(
    () =>
      createLocationCalibration(
        { ...anchor(), timestamp: now - 10_001 },
        fix(),
        { now },
      ),
    /укажите/,
  );
  assert.throws(
    () =>
      createLocationCalibration({ ...anchor(), source: "gps" }, fix(), { now }),
    /укажите/,
  );
});

test("poor or missing GPS holds the anchor without refreshing its timestamp, then actual good fixes may resume", () => {
  const calibration = createLocationCalibration(anchor(), fix(), { now });
  const initial = applyLocationTracking(fix(), { now, calibration });
  const lost = applyLocationTracking(
    fix({ accuracyMeters: 150, timestamp: now + 3000 }),
    {
      now: now + 3000,
      calibration: initial.calibration,
      previous: initial.location,
    },
  );
  assert.equal(lost.status, "signal-lost");
  assert.equal(lost.location.timestamp, now);
  assert.deepEqual(lost.location.point, anchor().point);
  assert.equal(lost.calibration.valid, true);
  const missing = applyLocationTracking(null, {
    now: now + 4000,
    calibration,
    previous: lost.location,
  });
  assert.equal(missing.location.timestamp, now);
  assert.equal(missing.status, "signal-lost");
  const cached = applyLocationTracking(fix({ timestamp: now + 2000 }), {
    now: now + 15_000,
    calibration,
    previous: initial.location,
  });
  assert.equal(cached.status, "signal-lost");
  assert.equal(cached.reason, "stale-fix");
  assert.equal(cached.location.timestamp, now);
  const resumed = applyLocationTracking(
    fix({ point: [14, 20], timestamp: now + 6000 }),
    { now: now + 6000, calibration: lost.calibration, previous: lost.location },
  );
  assert.equal(resumed.status, "tracking");
  assert.deepEqual(resumed.location.point, [32, 25]);
});

test("expired calibration, long gaps, spikes and floor changes require explicit realignment", () => {
  for (const [reason, timestamp, raw, nextFloor] of [
    ["correction-expired", now + LOCATION_CALIBRATION_REVIEW_MS, {}, floor],
    ["signal-gap", now + 31_000, {}, floor],
    ["position-jump", now + 3000, { point: [100, 100] }, floor],
    [
      "floor-changed",
      now + 3000,
      {},
      { ...floor, building: "А", physicalLevel: 2 },
    ],
  ]) {
    const calibration = createLocationCalibration(anchor(), fix(), {
      now,
      floor,
    });
    if (reason === "correction-expired") calibration.expiresAt = timestamp;
    const previous = applyLocationTracking(fix(), {
      now,
      floor,
      calibration,
    }).location;
    const result = applyLocationTracking(
      fix({ ...raw, timestamp, expiresAt: timestamp + 60_000 }),
      { now: timestamp, floor: nextFloor, previous, calibration },
    );
    assert.equal(result.status, "needs-refinement", reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.location.point, previous.point, reason);
    assert.equal(result.location.timestamp, now, reason);
    assert.equal(result.calibration.valid, false);
    const later = applyLocationTracking(
      fix({ timestamp: timestamp + 1, expiresAt: timestamp + 60_000 }),
      {
        now: timestamp + 1,
        previous: result.location,
        calibration: result.calibration,
      },
    );
    assert.equal(
      later.status,
      "needs-refinement",
      "later GPS must not silently drop an invalid manual correction",
    );
    assert.deepEqual(later.location.point, previous.point);
  }
});

test("a map-surface guard freezes a rejected correction without snapping or inventing a walk through walls", () => {
  const calibration = createLocationCalibration(anchor(), fix(), {
    now,
    floor,
  });
  const initial = applyLocationTracking(fix(), { now, calibration });
  let checked;
  const result = applyLocationTracking(
    fix({ point: [15, 20], timestamp: now + 3000 }),
    {
      now: now + 3000,
      calibration: initial.calibration,
      previous: initial.location,
      allowPoint(point, selectedFloor) {
        checked = { point, selectedFloor };
        return false;
      },
    },
  );
  assert.deepEqual(checked.point, [33, 25]);
  assert.equal(checked.selectedFloor.physicalLevel, 3);
  assert.equal(result.status, "needs-refinement");
  assert.equal(result.reason, "point-not-on-known-surface");
  assert.deepEqual(result.location.point, anchor().point);
  assert.equal(result.location.timestamp, now);
});

test("stale, outside and out-of-order fixes never refresh the last-known timestamp", () => {
  const previous = applyLocationTracking(fix(), { now }).location;
  for (const raw of [
    null,
    fix({ status: "outside", point: null }),
    fix({ timestamp: now - 61_000 }),
  ]) {
    const result = applyLocationTracking(raw, { now, previous });
    assert.equal(result.status, "signal-lost");
    assert.equal(result.location.timestamp, now);
    assert.deepEqual(result.location.point, previous.point);
  }
  const older = applyLocationTracking(fix({ timestamp: now - 1000 }), {
    now,
    previous,
  });
  assert.equal(older.status, "tracking");
  assert.equal(older.reason, "out-of-order-fix");
  assert.equal(older.location.timestamp, now);
});

test("a confirmed map pin keeps its source floor and a known hall level without inventing a building", () => {
  const hall = { ...anchor(), building: null, physicalLevel: 2 };
  const calibration = createLocationCalibration(hall, fix(), { now });
  const result = applyLocationTracking(
    fix({ point: [13, 20], timestamp: now + 1000 }),
    { calibration, now: now + 1000 },
  );
  assert.equal(result.location.floorId, hall.floorId);
  assert.equal(result.location.physicalLevel, 2);
  assert.equal(result.location.building, null);
  assert.equal(result.location.floorEvidence, "manual");
  assert.deepEqual(result.location.point, [31, 25]);
  const unknown = { ...hall, physicalLevel: null };
  const second = applyLocationTracking(fix(), {
    calibration: createLocationCalibration(unknown, fix(), { now }),
    now,
  });
  assert.equal(second.location.floorId, unknown.floorId);
  assert.equal(
    second.location.physicalLevel,
    null,
    "source plan number is never promoted to physical level",
  );
});

test("fresh continuous provider observations keep a manual offset moving beyond the review time", () => {
  let calibration = createLocationCalibration(anchor(), fix(), { now, floor });
  let previous = null;
  let result;
  for (
    let elapsed = 0;
    elapsed <= LOCATION_CALIBRATION_REVIEW_MS + 20000;
    elapsed += 20000
  ) {
    const timestamp = now + elapsed;
    result = applyLocationTracking(
      fix({
        point: [12 + elapsed / 20000, 20],
        timestamp,
        expiresAt: timestamp + 60000,
      }),
      { calibration, previous, floor, now: timestamp },
    );
    assert.equal(result.status, "tracking");
    assert.equal(result.location.timestamp, timestamp);
    calibration = result.calibration;
    previous = result.location;
  }
  assert.equal(result.location.correction.reviewRecommended, true);
  assert.deepEqual(result.location.point, [37, 25]);
  assert.equal(
    result.location.accuracyMeters,
    8,
    "a persistent offset never improves measured accuracy",
  );
});
