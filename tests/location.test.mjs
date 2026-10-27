import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  GPS_MAX_AGE_MS,
  gpsErrorMessage,
  normalizeGpsPosition,
  pointInLocationPolygon,
  projectGpsToMap,
  requestGpsLocation,
} from "../src/location.js";
import registration from "../src/data/gps-registration.json" with { type: "json" };

const now = 1_800_000_000_000;
const position = (coords = {}, timestamp = now) => ({
  coords: { latitude: 55.669957, longitude: 37.480225, accuracy: 8, ...coords },
  timestamp,
});

test("GPS uses the existing source affine anchors and preserved campus boundary", () => {
  const sourceBytes = readFileSync(
    new URL("../source/maps/original/pulse/campus_v-78.json", import.meta.url),
  );
  const source = JSON.parse(sourceBytes).floors[0];
  const context = JSON.parse(
    readFileSync(
      new URL("../public/data/exterior-context.json", import.meta.url),
    ),
  );
  assert.equal(
    createHash("sha256").update(sourceBytes).digest("hex"),
    registration.sourceSha256,
  );
  assert.deepEqual(registration.anchors, source.anchors);
  assert.deepEqual(registration.campusBoundary, context.campusBoundary);
  assert.deepEqual(
    projectGpsToMap(source.anchors[0].longitude, source.anchors[0].latitude),
    [
      (-source.width / 2) * source.meters_per_unit,
      (-source.height / 2) * source.meters_per_unit,
    ],
  );
  const corner = projectGpsToMap(
    source.anchors[1].longitude,
    source.anchors[1].latitude,
  );
  assert.ok(
    Math.abs(corner[0] - (source.width / 2) * source.meters_per_unit) < 1e-8,
  );
  assert.ok(
    Math.abs(corner[1] + (source.height / 2) * source.meters_per_unit) < 1e-8,
  );
});

test("GPS has measured accuracy, approximate registration, and never assigns an indoor floor", () => {
  const result = normalizeGpsPosition(position(), now);
  assert.equal(result.campusId, "v-78");
  assert.equal(result.floorId, null);
  assert.equal(result.building, null);
  assert.equal(result.status, "inside");
  assert.equal(result.registrationStatus, "approximate");
  assert.equal(result.accuracyMeters, 8);
  assert.equal(result.expiresAt, now + GPS_MAX_AGE_MS);
  assert.ok(result.accuracyRadiusMap > 5 && result.accuracyRadiusMap < 12);
  assert.match(result.message, /Этаж неизвестен/);
  assert.ok(
    registration.campusBoundary.some((polygon) =>
      pointInLocationPolygon(result.point, polygon),
    ),
  );
});

test("outside and imprecise GPS cannot create a position on the V78 plan", () => {
  const outside = normalizeGpsPosition(
    position({ latitude: 59.93, longitude: 30.33 }),
    now,
  );
  assert.equal(outside.campusId, null);
  assert.equal(outside.point, null);
  assert.equal(outside.status, "outside");
  const imprecise = normalizeGpsPosition(position({ accuracy: 2000 }), now);
  assert.equal(imprecise.campusId, null);
  assert.equal(imprecise.point, null);
  assert.equal(imprecise.status, "uncertain");
  assert.throws(
    () => normalizeGpsPosition(position({}, now - GPS_MAX_AGE_MS - 1), now),
    /устарело/,
  );
  assert.throws(
    () => normalizeGpsPosition(position({ latitude: 1000 }), now),
    /некорректные/,
  );
  assert.throws(
    () => normalizeGpsPosition(position({ accuracy: NaN }), now),
    /некорректные/,
  );
});

test("web GPS is requested once, permission denial is actionable, and browser fallback has no watcher", async () => {
  let calls = 0;
  const result = await requestGpsLocation({
    native: false,
    now: () => now,
    browser: {
      geolocation: {
        getCurrentPosition(resolve, _reject, options) {
          calls++;
          assert.equal(options.maximumAge, 0);
          assert.equal(options.enableHighAccuracy, true);
          resolve(position());
        },
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.source, "gps");
  await assert.rejects(
    requestGpsLocation({
      native: false,
      browser: {
        geolocation: {
          getCurrentPosition(_resolve, reject) {
            reject({ code: 1 });
          },
        },
      },
    }),
    /Доступ.*запрещён/,
  );
  assert.match(gpsErrorMessage({ code: "OS-PLUG-GLOC-0007" }), /выключена/);
});

test("native GPS requests foreground permission and ignores late results after cancellation", async () => {
  const controller = new AbortController();
  let completePermission,
    calls = 0;
  const request = requestGpsLocation({
    native: true,
    signal: controller.signal,
    plugin: {
      async checkPermissions() {
        return { location: "prompt", coarseLocation: "prompt" };
      },
      requestPermissions({ permissions }) {
        assert.deepEqual(permissions, ["location"]);
        return new Promise((resolve) => (completePermission = resolve));
      },
      async getCurrentPosition() {
        calls++;
        return position();
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  completePermission({ location: "granted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    calls,
    0,
    "canceled permission flow cannot start a new sensor request",
  );
});

test("Android permission sheet pause/resume can grant access and return the first actual GPS fix", async () => {
  const lifecycleTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { hidden: false });
  const events = [];
  let scans = 0;
  const result = await requestGpsLocation({
    native: true,
    now: () => now,
    lifecycleTarget,
    documentTarget,
    plugin: {
      async checkPermissions() {
        return { location: "prompt", coarseLocation: "prompt" };
      },
      async requestPermissions() {
        events.push("permission-pause");
        lifecycleTarget.dispatchEvent(
          new CustomEvent("atlas:app-state", { detail: { isActive: false } }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        events.push("permission-resume");
        lifecycleTarget.dispatchEvent(
          new CustomEvent("atlas:app-state", { detail: { isActive: true } }),
        );
        return { location: "granted", coarseLocation: "granted" };
      },
      async getCurrentPosition() {
        scans++;
        events.push("gps-fix");
        return position();
      },
    },
  });
  assert.equal(scans, 1);
  assert.equal(result.status, "inside");
  assert.equal(result.timestamp, now);
  assert.deepEqual(events, [
    "permission-pause",
    "permission-resume",
    "gps-fix",
  ]);
});

test("real app-state background after the permission phase still abandons a pending GPS fix", async () => {
  const lifecycleTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { hidden: false });
  let reply;
  const task = requestGpsLocation({
    native: true,
    lifecycleTarget,
    documentTarget,
    plugin: {
      async checkPermissions() {
        return { location: "prompt", coarseLocation: "prompt" };
      },
      async requestPermissions() {
        return { location: "granted" };
      },
      getCurrentPosition() {
        return new Promise((resolve) => (reply = resolve));
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    typeof reply,
    "function",
    "sensor request has begun after permission was granted",
  );
  lifecycleTarget.dispatchEvent(
    new CustomEvent("atlas:app-state", { detail: { isActive: false } }),
  );
  await assert.rejects(task, { name: "AbortError" });
  reply(position());
});

for (const eventType of ["visibilitychange", "pagehide"]) {
  test(`${eventType} during a permission sheet always cancels GPS and ignores a late grant`, async () => {
    const lifecycleTarget = new EventTarget();
    const documentTarget = Object.assign(new EventTarget(), { hidden: false });
    let grant,
      scans = 0;
    const task = requestGpsLocation({
      native: true,
      lifecycleTarget,
      documentTarget,
      plugin: {
        async checkPermissions() {
          return { location: "prompt", coarseLocation: "prompt" };
        },
        requestPermissions() {
          return new Promise((resolve) => (grant = resolve));
        },
        async getCurrentPosition() {
          scans++;
          return position();
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    lifecycleTarget.dispatchEvent(
      new CustomEvent("atlas:app-state", { detail: { isActive: false } }),
    );
    if (eventType === "visibilitychange") {
      documentTarget.hidden = true;
      documentTarget.dispatchEvent(new Event(eventType));
    } else lifecycleTarget.dispatchEvent(new Event(eventType));
    await assert.rejects(task, { name: "AbortError" });
    grant({ location: "granted" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scans, 0);
  });
}

test("native approximate permission is respected and never escalated to background", async () => {
  let calls = 0;
  const result = await requestGpsLocation({
    native: true,
    now: () => now,
    plugin: {
      async checkPermissions() {
        return { location: "denied", coarseLocation: "granted" };
      },
      async requestPermissions() {
        assert.fail("existing approximate permission must be respected");
      },
      async getCurrentPosition() {
        calls++;
        return position({ accuracy: 1200 });
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "uncertain");
  assert.equal(result.point, null);
});

test("backgrounding abandons the pending one-shot GPS result", async () => {
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { hidden: false });
  let reply;
  const request = requestGpsLocation({
    native: false,
    lifecycleTarget: windowTarget,
    documentTarget,
    browser: {
      geolocation: {
        getCurrentPosition(resolve) {
          reply = resolve;
        },
      },
    },
  });
  documentTarget.hidden = true;
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await assert.rejects(request, { name: "AbortError" });
  reply(position());
});

test("manual placement containment excludes holes and arbitrary map background", () => {
  const polygon = {
    points: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
    holes: [
      [
        [8, 8],
        [12, 8],
        [12, 12],
        [8, 12],
      ],
    ],
  };
  assert.equal(pointInLocationPolygon([5, 5], polygon), true);
  assert.equal(pointInLocationPolygon([10, 10], polygon), false);
  assert.equal(pointInLocationPolygon([-1, 5], polygon), false);
});
