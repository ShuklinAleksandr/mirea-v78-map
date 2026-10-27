import test from "node:test";
import assert from "node:assert/strict";
import { watchGpsLocation } from "../src/location.js";

const now = 1_800_000_000_000;
const position = (timestamp = now, coords = {}) => ({
  coords: { latitude: 55.669957, longitude: 37.480225, accuracy: 8, ...coords },
  timestamp,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const surfaces = () => ({
  lifecycleTarget: new EventTarget(),
  documentTarget: Object.assign(new EventTarget(), { hidden: false }),
});
const appState = (target, isActive) =>
  target.dispatchEvent(
    new CustomEvent("atlas:app-state", { detail: { isActive } }),
  );

test("foreground browser watch streams new observations and clears ID zero exactly once", async () => {
  const fixes = [],
    errors = [],
    cleared = [];
  let emit,
    fail,
    calls = 0;
  const stop = await watchGpsLocation({
    ...surfaces(),
    native: false,
    now: () => now + 5000,
    onPosition: (fix) => fixes.push(fix),
    onError: (error) => errors.push(error),
    browser: {
      geolocation: {
        watchPosition(success, error, options) {
          calls++;
          emit = success;
          fail = error;
          assert.equal(options.maximumAge, 0);
          assert.equal(options.enableHighAccuracy, true);
          return 0;
        },
        clearWatch(id) {
          cleared.push(id);
        },
      },
    },
  });
  emit(position());
  emit(position(now + 3000));
  emit(position(now + 1000));
  emit(position(now + 3000));
  assert.equal(calls, 1);
  assert.deepEqual(
    fixes.map((fix) => fix.timestamp),
    [now, now + 3000],
  );
  assert.equal(fixes[1].floorId, null);
  fail({ code: 2, message: "Provider temporarily unavailable" });
  emit(position(now + 5000));
  assert.equal(
    fixes.length,
    3,
    "temporary sensor error does not kill the watch",
  );
  assert.equal(errors.length, 1);
  await stop();
  await stop();
  emit(position(now + 6000));
  assert.deepEqual(cleared, [0]);
  assert.equal(
    fixes.length,
    3,
    "late queued callback cannot restart a stopped watch",
  );
});

test("native watch accepts coarse permission and uses Capacitor callback/clear signatures", async () => {
  const fixes = [],
    errors = [],
    cleared = [];
  let callback;
  const stop = await watchGpsLocation({
    ...surfaces(),
    native: true,
    now: () => now,
    onPosition: (fix) => fixes.push(fix),
    onError: (error) => errors.push(error),
    plugin: {
      async checkPermissions() {
        return { location: "denied", coarseLocation: "granted" };
      },
      async requestPermissions() {
        assert.fail("already granted coarse permission must not prompt again");
      },
      async watchPosition(options, receive) {
        assert.equal(options.minimumUpdateInterval, 2000);
        callback = receive;
        return "native-watch";
      },
      async clearWatch(options) {
        cleared.push(options);
      },
    },
  });
  callback(position());
  callback(position(now - 61_000));
  callback(position(now, { accuracy: 2000 }));
  assert.equal(
    fixes.length,
    1,
    "duplicate timestamp cannot replace a newer fix",
  );
  assert.equal(
    errors.length,
    1,
    "stale provider fix is rejected, not a fresh position",
  );
  await stop();
  assert.deepEqual(cleared, [{ id: "native-watch" }]);
});

test("native watch ID arriving after abort is cleared and queued fixes are suppressed", async () => {
  const controller = new AbortController();
  let resolveId, callback;
  const cleared = [],
    fixes = [];
  const task = watchGpsLocation({
    ...surfaces(),
    native: true,
    signal: controller.signal,
    now: () => now,
    onPosition: (fix) => fixes.push(fix),
    plugin: {
      async checkPermissions() {
        return { location: "granted" };
      },
      watchPosition(_options, receive) {
        callback = receive;
        return new Promise((resolve) => {
          resolveId = resolve;
        });
      },
      async clearWatch(options) {
        cleared.push(options);
      },
    },
  });
  await tick();
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  callback(position());
  resolveId("late-native-watch");
  await tick();
  assert.deepEqual(cleared, [{ id: "late-native-watch" }]);
  assert.equal(fixes.length, 0);
});

test("Android permission sheet pause is transient but a later background stops the sensor", async () => {
  const { lifecycleTarget, documentTarget } = surfaces();
  const cleared = [],
    errors = [],
    fixes = [];
  let callback;
  const stop = await watchGpsLocation({
    native: true,
    lifecycleTarget,
    documentTarget,
    now: () => now,
    onPosition: (fix) => fixes.push(fix),
    onError: (error) => errors.push(error),
    plugin: {
      async checkPermissions() {
        return { location: "prompt", coarseLocation: "prompt" };
      },
      async requestPermissions() {
        appState(lifecycleTarget, false);
        await tick();
        appState(lifecycleTarget, true);
        return { location: "granted" };
      },
      async watchPosition(_options, receive) {
        callback = receive;
        return "foreground";
      },
      async clearWatch(options) {
        cleared.push(options);
      },
    },
  });
  callback(position());
  assert.equal(fixes.length, 1);
  assert.equal(errors.length, 0);
  appState(lifecycleTarget, false);
  await tick();
  assert.deepEqual(cleared, [{ id: "foreground" }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "AbortError");
  appState(lifecycleTarget, true);
  callback(position(now + 1));
  assert.equal(
    fixes.length,
    1,
    "foreground event alone cannot resurrect the old watch",
  );
  await stop();
});

for (const action of ["pagehide", "hidden"]) {
  test(`real ${action} during native permission does not start a watch after late grant`, async () => {
    const { lifecycleTarget, documentTarget } = surfaces();
    let grant,
      watches = 0;
    const task = watchGpsLocation({
      native: true,
      lifecycleTarget,
      documentTarget,
      onPosition() {},
      plugin: {
        async checkPermissions() {
          return { location: "prompt" };
        },
        requestPermissions() {
          return new Promise((resolve) => {
            grant = resolve;
          });
        },
        async watchPosition() {
          watches++;
          return "never";
        },
        async clearWatch() {},
      },
    });
    await tick();
    if (action === "pagehide")
      lifecycleTarget.dispatchEvent(new Event("pagehide"));
    else {
      documentTarget.hidden = true;
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    }
    await assert.rejects(task, { name: "AbortError" });
    grant({ location: "granted" });
    await tick();
    assert.equal(watches, 0);
  });
}

test("permission errors terminate a running browser watch without accepting later callbacks", async () => {
  let fail, emit;
  const errors = [],
    cleared = [],
    fixes = [];
  await watchGpsLocation({
    ...surfaces(),
    native: false,
    now: () => now,
    onPosition: (fix) => fixes.push(fix),
    onError: (error) => errors.push(error),
    browser: {
      geolocation: {
        watchPosition(success, error) {
          emit = success;
          fail = error;
          return 37;
        },
        clearWatch(id) {
          cleared.push(id);
        },
      },
    },
  });
  fail({ code: 1 });
  await tick();
  emit(position());
  assert.equal(fixes.length, 0);
  assert.deepEqual(cleared, [37]);
  assert.match(errors[0].message, /Доступ.*запрещён/);
});

test("synchronous browser permission failure still clears the ID returned afterwards", async () => {
  const cleared = [];
  await assert.rejects(
    watchGpsLocation({
      ...surfaces(),
      native: false,
      onPosition() {},
      browser: {
        geolocation: {
          watchPosition(_success, error) {
            error({ code: 1 });
            return 51;
          },
          clearWatch(id) {
            cleared.push(id);
          },
        },
      },
    }),
    /Доступ.*запрещён/,
  );
  assert.deepEqual(cleared, [51]);
});

test("watch never requests permission on a hidden page or an already canceled start", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const options = {
    ...surfaces(),
    native: true,
    onPosition() {},
    plugin: {
      async checkPermissions() {
        calls++;
        return { location: "granted" };
      },
    },
  };
  await assert.rejects(
    watchGpsLocation({ ...options, signal: controller.signal }),
    { name: "AbortError" },
  );
  options.documentTarget.hidden = true;
  await assert.rejects(watchGpsLocation(options), { name: "AbortError" });
  assert.equal(calls, 0);
});
