import test from "node:test";
import assert from "node:assert/strict";
import registration from "../src/data/gps-registration.json" with { type: "json" };
import { projectGpsToMap } from "../src/location.js";
import {
  GPS_CALIBRATION_SURVEY_STORAGE_KEY,
  GPS_CALIBRATION_SURVEY_LIMIT,
  createGpsCalibrationRecord,
  readGpsCalibrationSurvey,
  loadGpsCalibrationSurvey,
  appendGpsCalibrationRecord,
  saveGpsCalibrationSurvey,
  clearGpsCalibrationSurvey,
  exportGpsCalibrationSurvey,
} from "../src/data/gps-calibration-survey.js";

const now = 1_800_000_000_000;
const fix = (extra = {}) => ({
  source: "gps",
  campusId: "v-78",
  status: "inside",
  latitude: 55.669957,
  longitude: 37.480225,
  point: projectGpsToMap(37.480225, 55.669957),
  accuracyMeters: 8,
  timestamp: now - 1000,
  expiresAt: now + 59_000,
  ...extra,
});
const anchor = (extra = {}) => ({
  source: "manual",
  campusId: "v-78",
  floorId: "v-78-floor2",
  building: "Г",
  physicalLevel: 3,
  floorEvidence: "manual",
  point: [25.125, -28.987],
  label: "Коридор у лестницы",
  placeId: null,
  timestamp: now,
  ...extra,
});
const record = (id = "sample-1", options = {}) =>
  createGpsCalibrationRecord(anchor(), fix(), { now, id, ...options });
const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
};
const errorCode = (code) => (error) => error.code === code;

test("control point preserves exact manual position, original GPS and registration without applying a correction", () => {
  const a = anchor();
  const gps = fix();
  const before = JSON.stringify([a, gps, registration]);
  const result = createGpsCalibrationRecord(a, gps, { now, id: "exact-1" });
  assert.deepEqual(result.anchor.point, [25.125, -28.987]);
  assert.equal(result.anchor.physicalLevel, 3);
  assert.equal(result.anchor.floorId, "v-78-floor2");
  assert.equal(result.anchor.floorEvidence, "manual");
  assert.deepEqual(result.gps.point, gps.point);
  assert.equal(result.gps.latitude, gps.latitude);
  assert.equal(result.gps.longitude, gps.longitude);
  assert.equal(result.gps.timestamp, now - 1000);
  assert.equal(result.gps.accuracyMeters, 8);
  assert.deepEqual(
    result.deltaMap,
    a.point.map((n, i) => n - gps.point[i]),
  );
  assert.equal(result.registration.sourceSha256, registration.sourceSha256);
  assert.deepEqual(result.registration.anchors, registration.anchors);
  assert.equal(result.quality.classification, "candidate");
  assert.equal(result.quality.requiresFieldReview, true);
  assert.equal(result.quality.registrationErrorKnown, false);
  assert.equal(JSON.stringify([a, gps, registration]), before);
});

test("GPS sample cannot borrow the manually corrected position", () => {
  const gps = fix({ point: [1, 2], correction: { type: "manual-offset" } });
  assert.throws(
    () => createGpsCalibrationRecord(anchor(), gps, { now }),
    errorCode("corrected-gps"),
  );
  const realPoint = fix().point;
  const tracked = { ...gps, rawPoint: realPoint };
  const result = createGpsCalibrationRecord(anchor(), tracked, { now });
  assert.deepEqual(result.gps.point, realPoint);
  assert.notDeepEqual(result.gps.point, tracked.point);
});

test("a hall or corridor records the exact floor plan without inventing a building or physical floor", () => {
  const result = createGpsCalibrationRecord(
    anchor({ building: null, physicalLevel: null, placeId: null }),
    fix(),
    { now },
  );
  assert.equal(result.anchor.building, null);
  assert.equal(result.anchor.physicalLevel, null);
  assert.equal(result.anchor.placeId, null);
  assert.deepEqual(result.anchor.point, anchor().point);
});

test("a noisier but bounded provider fix is diagnostic evidence and not a promised correction", () => {
  for (const accuracy of [15, 15.1, 50, 200]) {
    const result = createGpsCalibrationRecord(
      anchor(),
      fix({ accuracyMeters: accuracy }),
      { now },
    );
    assert.equal(
      result.quality.classification,
      accuracy <= 15 ? "candidate" : "noisy",
    );
    assert.equal(result.gps.accuracyMeters, accuracy);
    assert.equal(result.quality.requiresFieldReview, true);
  }
});

test("invalid, poor, outside-campus and cross-campus GPS fixes are rejected", () => {
  for (const extra of [
    { source: "manual" },
    { status: "outside" },
    { campusId: "v-86" },
    { campusId: null },
    { accuracyMeters: 201 },
    { accuracyMeters: 0 },
    { accuracyMeters: Number.NaN },
    { latitude: 91 },
    { longitude: -181 },
  ])
    assert.throws(
      () => createGpsCalibrationRecord(anchor(), fix(extra), { now }),
      errorCode("invalid-gps"),
    );
});

test("a fresh temporally paired manual confirmation is required", () => {
  for (const gps of [
    fix({ timestamp: now - 10_001 }),
    fix({ timestamp: now + 1 }),
    fix({ expiresAt: now }),
    fix({ timestamp: undefined }),
  ])
    assert.throws(
      () => createGpsCalibrationRecord(anchor(), gps, { now }),
      errorCode("stale-pair"),
    );
  for (const a of [
    anchor({ timestamp: now - 10_001 }),
    anchor({ timestamp: now + 1 }),
  ])
    assert.throws(
      () => createGpsCalibrationRecord(a, fix(), { now }),
      errorCode("stale-pair"),
    );
  assert.doesNotThrow(() =>
    createGpsCalibrationRecord(anchor(), fix({ timestamp: now - 10_000 }), {
      now,
    }),
  );
});

test("manual coordinates and floor evidence are validated rather than borrowed from GPS", () => {
  for (const extra of [
    { source: "gps" },
    { campusId: "v-86" },
    { floorId: null },
    { floorId: "v-78-floor999" },
    { floorEvidence: "unknown" },
    { point: [Number.NaN, 1] },
    { point: [1, 2, 3] },
    { point: [1e99, 0] },
    { building: "X".repeat(200) },
    { physicalLevel: 2.5 },
    { label: "bad\u0000label" },
  ])
    assert.throws(
      () => createGpsCalibrationRecord(anchor(extra), fix(), { now }),
      errorCode("invalid-anchor"),
    );
});

test("local storage round trip exports provenance and explicit privacy metadata only", () => {
  const db = storage();
  assert.equal(readGpsCalibrationSurvey(db), null);
  const saved = appendGpsCalibrationRecord(db, record(), { now });
  assert.equal(saved.records.length, 1);
  assert.deepEqual(loadGpsCalibrationSurvey(db), saved);
  const exported = JSON.parse(exportGpsCalibrationSurvey(saved, { now }));
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.coordinateSystem, "v78-source-map-meters");
  assert.equal(exported.records[0].gps.coordinateSystem, "WGS84");
  assert.equal(exported.privacy.automaticUpload, false);
  assert.equal(exported.privacy.continuousRecording, false);
  assert.equal(exported.privacy.storage, "local-only");
  assert.equal(exported.exportedAt, now);
  assert.match(exported.purpose, /not-applied/u);
  saved.records[0].anchor.point[0] = 999;
  assert.notEqual(readGpsCalibrationSurvey(db).records[0].anchor.point[0], 999);
});

test("damaged or malicious stored collections are not overwritten by another observation", () => {
  const db = storage();
  const valid = appendGpsCalibrationRecord(db, record(), { now });
  const invalidCollections = [
    "{broken",
    JSON.stringify({ ...valid, schemaVersion: 900 }),
    JSON.stringify({ ...valid, records: [valid.records[0], valid.records[0]] }),
    JSON.stringify({
      ...valid,
      records: [{ ...valid.records[0], deltaMap: [0, 0] }],
    }),
    JSON.stringify({
      ...valid,
      records: [{ ...valid.records[0], id: '<script>alert("x")</script>' }],
    }),
    " ".repeat(1_000_001),
  ];
  for (const data of invalidCollections) {
    db.setItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY, data);
    assert.throws(
      () => appendGpsCalibrationRecord(db, record("new-id"), { now }),
      errorCode("storage-invalid"),
    );
    assert.equal(db.getItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY), data);
  }
});

test("stored quality and imported extra keys cannot change diagnostic semantics", () => {
  const db = storage();
  const saved = appendGpsCalibrationRecord(db, record(), { now });
  const manipulated = JSON.parse(JSON.stringify(saved));
  manipulated.privacy = { automaticUpload: true };
  manipulated.records[0].quality = { classification: "surveyed-centimetres" };
  manipulated.records[0].gps.apiKey = "not-kept";
  manipulated.records[0].registration.apiKey = "not-kept";
  manipulated.records[0].registration.anchors[0].unexpected = "not-kept";
  manipulated.records[0].__proto__ = { polluted: true };
  db.setItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY, JSON.stringify(manipulated));
  const loaded = readGpsCalibrationSurvey(db);
  assert.equal(loaded.privacy.automaticUpload, false);
  assert.equal(loaded.records[0].quality.classification, "candidate");
  assert.equal("apiKey" in loaded.records[0].gps, false);
  assert.equal("apiKey" in loaded.records[0].registration, false);
  assert.equal(
    "unexpected" in loaded.records[0].registration.anchors[0],
    false,
  );
  assert.equal("polluted" in loaded.records[0], false);
});

test("duplicates and capacity overflow fail without silently discarding earlier records", () => {
  const db = storage();
  let survey = appendGpsCalibrationRecord(db, record("same"), { now });
  assert.throws(
    () => appendGpsCalibrationRecord(db, record("same"), { now }),
    errorCode("duplicate-record"),
  );
  survey.records = Array.from(
    { length: GPS_CALIBRATION_SURVEY_LIMIT },
    (_, i) => record(`point-${i}`),
  );
  saveGpsCalibrationSurvey(db, survey);
  const before = db.getItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY);
  assert.throws(
    () => appendGpsCalibrationRecord(db, record("overflow"), { now }),
    errorCode("survey-full"),
  );
  assert.equal(db.getItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY), before);
});

test("unavailable or full storage has a clear error and does not pretend a record was saved", () => {
  assert.throws(
    () =>
      readGpsCalibrationSurvey({
        getItem() {
          throw new Error("denied");
        },
      }),
    errorCode("storage-unavailable"),
  );
  const db = storage();
  db.setItem = () => {
    throw new Error("quota");
  };
  assert.throws(
    () => appendGpsCalibrationRecord(db, record(), { now }),
    errorCode("storage-unavailable"),
  );
  assert.equal(readGpsCalibrationSurvey(db), null);
});

test("explicit clearing removes only GPS calibration data, including corrupted content", () => {
  const db = storage();
  db.setItem("unrelated", "kept");
  db.setItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY, "bad");
  clearGpsCalibrationSurvey(db);
  assert.equal(readGpsCalibrationSurvey(db), null);
  assert.equal(db.getItem("unrelated"), "kept");
});
