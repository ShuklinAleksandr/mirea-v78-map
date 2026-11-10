import test from "node:test";
import assert from "node:assert/strict";
import { projectGpsToMap } from "../src/location.js";
import {
  GPS_MEASUREMENTS_KEY,
  createGpsMeasurement,
  appendGpsMeasurementSample,
  finishGpsMeasurement,
  readGpsMeasurements,
  saveGpsMeasurement,
  exportGpsMeasurements,
  prepareGpsMeasurementExport,
} from "../src/data/gps-measurements.js";
import { startGpsMeasurementSession } from "../src/data/gps-measurement-session.js";
import { bindGpsSurvey, gpsSurveyAvailable } from "../src/ui/gps-survey.js";

const now = 1_800_000_000_000;
const anchor = {
  source: "manual",
  campusId: "v-78",
  floorId: "v-78-floor2",
  point: [10, 20],
  label: "Точка на карте",
  landmark: "Угол у буфета",
  building: "А",
  physicalLevel: 2,
};
const metadata = { appVersion: "0.5.18", userAgent: "Android WebView test" };
const create = () =>
  createGpsMeasurement(anchor, { ...metadata, now, id: "measurement-1" });
const fix = (timestamp = now + 1000, extra = {}) => ({
  source: "gps",
  latitude: 55.669957,
  longitude: 37.480225,
  accuracyMeters: 8,
  timestamp,
  ...extra,
});
function storage() {
  const saved = new Map();
  return {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
}

test("stationary records keep raw coordinates even when displayed GPS is corrected, snapped or outside campus", () => {
  const base = create();
  const raw = fix(now + 1000, {
    campusId: null,
    status: "outside",
    point: [400, 500],
    rawPoint: [300, 300],
    routeMatched: true,
    correction: { offset: [1, 1] },
  });
  const before = JSON.stringify([base, raw, anchor]);
  const record = appendGpsMeasurementSample(base, raw, { now: now + 1000 });
  assert.equal(record.samples.length, 1);
  assert.deepEqual(
    record.samples[0].projectedPoint,
    projectGpsToMap(raw.longitude, raw.latitude),
  );
  assert.notDeepEqual(record.samples[0].projectedPoint, raw.point);
  assert.equal(record.samples[0].latitude, raw.latitude);
  assert.deepEqual(record.anchor.point, anchor.point);
  assert.equal(record.anchor.physicalLevel, 2);
  assert.equal(record.registration.status, "approximate");
  assert.equal(JSON.stringify([base, raw, anchor]), before);
});

test("cached, duplicate, future and out-of-order samples do not pretend to be fresh measurements", () => {
  const record = appendGpsMeasurementSample(create(), fix(), {
    now: now + 1000,
  });
  for (const sample of [
    fix(now - 1),
    fix(now + 1000),
    fix(now + 500),
    fix(now + 3000),
    fix(now + 1500, { source: "manual" }),
    fix(now + 1500, { accuracyMeters: -1 }),
    fix(now + 1500, { latitude: NaN }),
  ])
    assert.equal(
      appendGpsMeasurementSample(record, sample, { now: now + 2000 }),
      record,
    );
  assert.equal(
    appendGpsMeasurementSample(record, fix(now + 2000), { now: now + 20_000 }),
    record,
  );
});

test("a completed timer does not advertise usable evidence when it received no samples", () => {
  const record = finishGpsMeasurement(create(), { now: now + 30_000 });
  assert.equal(record.status, "complete");
  assert.equal(record.summary.sampleCount, 0);
  assert.equal(record.summary.usableForReview, false);
  assert.equal(record.summary.medianReportedAccuracyMeters, null);
  assert.equal(
    appendGpsMeasurementSample(record, fix(), { now: now + 1000 }),
    record,
  );
});

test("one-pass locations need no repeat and preserve sample spread and reported uncertainty", () => {
  let record = create();
  for (let i = 1; i <= 10; i++)
    record = appendGpsMeasurementSample(
      record,
      fix(now + i * 3000, { accuracyMeters: i * 3 }),
      { now: now + i * 3000 },
    );
  record = finishGpsMeasurement(record, { now: now + 30_000 });
  assert.equal(record.summary.usableForReview, true);
  assert.equal(record.summary.sampleCount, 10);
  assert.equal(record.summary.observedSpanMs, 27_000);
  assert.equal(record.summary.maxReportedAccuracyMeters, 30);
  assert.equal(record.summary.registrationErrorKnown, false);
  assert.equal(record.summary.requiresFieldReview, true);
});

test("partial and interrupted drafts survive restart and exporting one bundle preserves legacy records", () => {
  const store = storage();
  let record = appendGpsMeasurementSample(create(), fix(), { now: now + 1000 });
  saveGpsMeasurement(store, record);
  record = finishGpsMeasurement(readGpsMeasurements(store)[0], {
    now: now + 1000,
    reason: "app-restart",
  });
  saveGpsMeasurement(store, record);
  const restored = readGpsMeasurements(store);
  assert.equal(restored[0].status, "interrupted");
  assert.equal(restored[0].samples.length, 1);
  const legacy = { records: [{ id: "old-pair" }] };
  const exported = JSON.parse(
    exportGpsMeasurements(restored, { now: now + 2000, legacyPairs: legacy }),
  );
  assert.equal(exported.measurements.length, 1);
  assert.deepEqual(exported.legacyCalibration, legacy);
  assert.equal(exported.privacy.automaticUpload, false);
  assert.equal(readGpsMeasurements(store).length, 1);
});

test("corrupt prior data or storage failures never silently overwrite stored observations", () => {
  const store = storage();
  store.setItem(GPS_MEASUREMENTS_KEY, "broken");
  assert.throws(() => saveGpsMeasurement(store, create()), /повреждены/);
  assert.equal(store.getItem(GPS_MEASUREMENTS_KEY), "broken");
  assert.throws(
    () =>
      saveGpsMeasurement(
        {
          getItem: () => null,
          setItem() {
            throw new Error("quota");
          },
        },
        create(),
      ),
    /сохранить/,
  );
});

test("export can include the latest in-memory record after an interrupted disk write", () => {
  const old = create();
  const pending = finishGpsMeasurement(
    appendGpsMeasurementSample(old, fix(), { now: now + 1000 }),
    { now: now + 2000, reason: "storage-error" },
  );
  const bundle = JSON.parse(
    exportGpsMeasurements([old], { pendingRecord: pending }),
  );
  assert.equal(bundle.measurements.length, 1);
  assert.equal(bundle.measurements[0].samples.length, 1);
  assert.equal(bundle.measurements[0].status, "interrupted");
});

test("website and iOS do not mount the Android survey or request permission", () => {
  for (const config of [
    { native: false, platform: "web" },
    { native: true, platform: "ios" },
  ]) {
    assert.equal(gpsSurveyAvailable(config), false);
    assert.equal(bindGpsSurvey(config), null);
  }
  assert.equal(gpsSurveyAvailable({ native: true, platform: "android" }), true);
});

function sessionHarness({ pendingStart = false, saveFails = false } = {}) {
  let time = now,
    callbacks,
    resolveStart,
    stops = 0,
    timer,
    saved = [];
  const states = [];
  const session = startGpsMeasurementSession({
    anchor,
    metadata,
    now: () => time,
    startWatching(options) {
      callbacks = options;
      return new Promise((resolve) => {
        resolveStart = () =>
          resolve(async () => {
            stops++;
          });
        if (!pendingStart) resolveStart();
      });
    },
    setTimer(callback, delay) {
      timer = { callback, delay };
      return 1;
    },
    clearTimer() {
      timer = null;
    },
    onRecord(record) {
      if (saveFails && record.samples.length) throw new Error("quota");
      saved.push(record);
    },
    onState(...state) {
      states.push(state);
    },
  });
  return {
    session,
    states,
    get saved() {
      return saved;
    },
    get stops() {
      return stops;
    },
    get timer() {
      return timer;
    },
    get callbacks() {
      return callbacks;
    },
    setTime(value) {
      time = value;
    },
    ready() {
      resolveStart();
    },
  };
}

test("measurement starts its 30 seconds after permission/watch registration, not while the permission sheet is open", async () => {
  const h = sessionHarness({ pendingStart: true });
  assert.equal(h.session.record, null);
  assert.equal(h.timer, undefined);
  h.setTime(now + 20_000);
  h.ready();
  await h.session.ready;
  assert.equal(h.session.record.startedAt, now + 20_000);
  assert.equal(h.timer.delay, 30_000);
  h.callbacks.onPosition(fix(now + 21_000));
  assert.equal(
    h.session.record.samples.length,
    0,
    "future provider fix is ignored",
  );
  h.setTime(now + 21_000);
  h.callbacks.onPosition(fix(now + 21_000));
  h.setTime(now + 50_000);
  h.timer.callback();
  assert.equal(h.session.record.status, "complete");
  assert.equal(h.session.record.samples.length, 1);
  assert.equal(h.callbacks.signal.aborted, true);
  assert.equal(h.stops, 1);
});

test("cancel during permission setup clears a late watch and never creates a false measurement", async () => {
  const h = sessionHarness({ pendingStart: true });
  h.session.stop("dialog-closed");
  h.ready();
  await h.session.ready;
  assert.equal(h.session.record, null);
  assert.equal(h.saved.length, 0);
  assert.equal(h.stops, 1);
});

test("background abort preserves partial samples and late callbacks cannot extend the session", async () => {
  const h = sessionHarness();
  await h.session.ready;
  h.setTime(now + 1000);
  h.callbacks.onPosition(fix());
  h.callbacks.onError(new DOMException("background", "AbortError"));
  assert.equal(h.session.record.status, "interrupted");
  h.setTime(now + 2000);
  h.callbacks.onPosition(fix(now + 2000));
  assert.equal(h.session.record.samples.length, 1);
  assert.equal(h.stops, 1);
});

test("failed sample persistence stops the watch but keeps its last raw sample available for file export", async () => {
  const h = sessionHarness({ saveFails: true });
  await h.session.ready;
  h.setTime(now + 1000);
  h.callbacks.onPosition(fix());
  assert.equal(h.session.record.status, "interrupted");
  assert.equal(h.session.record.samples.length, 1);
  assert.equal(h.callbacks.signal.aborted, true);
  assert.equal(h.stops, 1);
  assert.ok(
    h.states.some(
      ([status, error]) => status === "error" && error.message === "quota",
    ),
  );
});

test("file export rescues memory samples despite unreadable storage and explicitly flags missing older data", () => {
  const pendingRecord = finishGpsMeasurement(
    appendGpsMeasurementSample(create(), fix(), { now: now + 1000 }),
    { now: now + 2000, reason: "storage-error" },
  );
  const broken = {
    getItem() {
      throw new Error("read failed");
    },
  };
  const output = prepareGpsMeasurementExport(broken, {
    pendingRecord,
    now: now + 3000,
  });
  const bundle = JSON.parse(output.json);
  assert.equal(bundle.measurements[0].samples.length, 1);
  assert.equal(bundle.measurements[0].status, "interrupted");
  assert.equal(bundle.completeCollection, false);
  assert.equal(bundle.exportWarnings.length, 2);
});

test("unreadable legacy pairs do not prevent exporting healthy new sessions", () => {
  const store = storage();
  saveGpsMeasurement(store, create());
  const mixed = {
    getItem(key) {
      return key === GPS_MEASUREMENTS_KEY
        ? store.getItem(key)
        : "corrupt legacy";
    },
  };
  const output = prepareGpsMeasurementExport(mixed);
  const bundle = JSON.parse(output.json);
  assert.equal(bundle.measurements.length, 1);
  assert.equal(bundle.legacyCalibration, null);
  assert.equal(bundle.completeCollection, false);
  assert.equal(output.warnings.length, 1);
});
