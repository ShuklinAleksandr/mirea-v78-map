import test from "node:test";
import assert from "node:assert/strict";
import {
  watchHeading,
  normalizeHeading,
  absoluteOrientationHeading,
} from "../src/heading.js";

const now = 1_800_000_000_000;
const observation = (more = {}) => ({
  id: "test",
  degrees: 90,
  timestamp: now,
  reference: "magnetic",
  accuracyDegrees: 12,
  ...more,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const surfaces = () => ({
  windowTarget: new EventTarget(),
  documentTarget: Object.assign(new EventTarget(), { hidden: false }),
});
const dispatch = (target, type, value) => {
  const e = new Event(type);
  Object.assign(e, value);
  target.dispatchEvent(e);
};
function nativeHarness() {
  let emit,
    removes = 0;
  const starts = [],
    stops = [];
  return {
    plugin: {
      async addListener(name, receive) {
        assert.equal(name, "heading");
        emit = receive;
        return {
          async remove() {
            removes++;
          },
        };
      },
      async start(options) {
        starts.push(options);
      },
      async stop(options) {
        stops.push(options);
      },
    },
    emit: (v) => emit(v),
    starts,
    stops,
    get removes() {
      return removes;
    },
  };
}

test("heading rejects course, relative angles, stale values and explicitly unreliable compass", () => {
  assert.equal(
    normalizeHeading({ degrees: 90, timestamp: now, reference: "course" }, now),
    null,
  );
  for (const more of [
    { timestamp: now - 5001 },
    { timestamp: now + 1001 },
    { accuracyDegrees: -1 },
    { accuracyDegrees: 90 },
    { accuracyStatus: "low" },
    { degrees: NaN },
    { degrees: -1 },
  ])
    assert.equal(normalizeHeading(observation(more), now), null);
  assert.equal(
    normalizeHeading(
      observation({
        degrees: 360,
        accuracyDegrees: null,
        accuracyStatus: "high",
      }),
      now,
    ).degrees,
    0,
  );
  assert.equal(normalizeHeading(observation(), now).source, "compass");
});

test("absolute browser orientation projects screen-top correctly and discards unstable vertical or relative data", () => {
  const value = (alpha, beta = 0, gamma = 0) => ({
    absolute: true,
    alpha,
    beta,
    gamma,
  });
  assert.equal(absoluteOrientationHeading(value(0)), 0);
  assert.equal(absoluteOrientationHeading(value(90)), 270);
  assert.equal(absoluteOrientationHeading(value(0), 90), 90);
  assert.equal(absoluteOrientationHeading(value(90), 90), 0);
  assert.equal(absoluteOrientationHeading(value(0, 180)), 180);
  assert.equal(absoluteOrientationHeading(value(0, 90)), null);
  assert.equal(
    absoluteOrientationHeading({
      alpha: 0,
      beta: 0,
      gamma: 0,
      absolute: false,
    }),
    null,
  );
  assert.equal(absoluteOrientationHeading({ alpha: 0, absolute: true }), null);
});

test("native compass streams only matching real observations and stop removes the sensor once", async () => {
  const h = nativeHarness(),
    values = [],
    errors = [];
  const stop = await watchHeading({
    ...surfaces(),
    native: true,
    plugin: h.plugin,
    now: () => now,
    onHeading: (v) => values.push(v),
    onError: (e) => errors.push(e),
    makeId: () => "test",
  });
  h.emit(observation({ id: "older-watcher" }));
  h.emit(observation());
  h.emit(observation({ timestamp: now - 100 }));
  h.emit(observation({ timestamp: now + 100, degrees: 91 }));
  assert.deepEqual(
    values.map((v) => v.degrees),
    [90, 91],
  );
  assert.equal(values[1].reference, "magnetic");
  assert.deepEqual(h.starts, [{ id: "test" }]);
  await stop();
  await stop();
  h.emit(observation({ timestamp: now + 200 }));
  assert.equal(h.removes, 1);
  assert.deepEqual(h.stops, [{ id: "test" }]);
  assert.equal(values.length, 2);
  assert.equal(errors.length, 0);
});

test("a nonfatal unreliable compass hides direction but accepts a later reliable observation", async () => {
  const h = nativeHarness(),
    values = [],
    errors = [];
  const stop = await watchHeading({
    ...surfaces(),
    native: true,
    plugin: h.plugin,
    now: () => now,
    onHeading: (v) => values.push(v),
    onError: (e) => errors.push(e),
    makeId: () => "test",
  });
  h.emit(
    observation({
      error: { code: "HEADING_UNRELIABLE", message: "low", fatal: false },
    }),
  );
  h.emit(observation({ degrees: 120, reference: "true" }));
  assert.equal(errors[0].fatal, false);
  assert.equal(values[0].degrees, 120);
  assert.equal(h.removes, 0);
  await stop();
});

for (const background of ["hidden", "pagehide", "native-background"])
  test(`heading sensors stop on ${background} and late events cannot restart them`, async () => {
    const h = nativeHarness(),
      surface = surfaces(),
      values = [],
      errors = [];
    const stop = await watchHeading({
      ...surface,
      native: true,
      plugin: h.plugin,
      now: () => now,
      onHeading: (v) => values.push(v),
      onError: (e) => errors.push(e),
      makeId: () => "test",
    });
    if (background === "hidden") {
      surface.documentTarget.hidden = true;
      surface.documentTarget.dispatchEvent(new Event("visibilitychange"));
    } else if (background === "pagehide")
      surface.windowTarget.dispatchEvent(new Event("pagehide"));
    else
      dispatch(surface.windowTarget, "atlas:app-state", {
        detail: { isActive: false },
      });
    await tick();
    h.emit(observation());
    await stop();
    assert.equal(errors[0].name, "AbortError");
    assert.equal(errors[0].fatal, true);
    assert.equal(h.removes, 1);
    assert.equal(values.length, 0);
  });

test("aborting registration removes a listener that arrives late and does not start a sensor", async () => {
  const surface = surfaces(),
    controller = new AbortController();
  let resolveListener,
    removes = 0,
    starts = 0;
  const promise = watchHeading({
    ...surface,
    native: true,
    signal: controller.signal,
    plugin: {
      addListener() {
        return new Promise((resolve) => {
          resolveListener = resolve;
        });
      },
      async start() {
        starts++;
      },
    },
    makeId: () => "test",
  });
  controller.abort();
  resolveListener({
    async remove() {
      removes++;
    },
  });
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(removes, 1);
  assert.equal(starts, 0);
});

test("browser absolute compass is independent from GPS and permission is requested only on explicit watch", async () => {
  const surface = surfaces(),
    values = [];
  let permissions = 0;
  surface.windowTarget.DeviceOrientationEvent = {
    async requestPermission() {
      permissions++;
      return "granted";
    },
  };
  surface.windowTarget.screen = { orientation: { angle: 90 } };
  assert.equal(permissions, 0);
  const stop = await watchHeading({
    ...surface,
    native: false,
    now: () => now,
    onHeading: (v) => values.push(v),
  });
  dispatch(surface.windowTarget, "deviceorientation", {
    alpha: 10,
    beta: 0,
    gamma: 0,
    absolute: false,
  });
  assert.equal(values.length, 0);
  dispatch(surface.windowTarget, "deviceorientation", {
    webkitCompassHeading: 350,
    webkitCompassAccuracy: 10,
  });
  assert.equal(values[0].degrees, 80);
  assert.equal(permissions, 1);
  await stop();
  dispatch(surface.windowTarget, "deviceorientationabsolute", {
    alpha: 0,
    beta: 0,
    gamma: 0,
    absolute: true,
  });
  assert.equal(values.length, 1);
});

test("unsupported and denied browser compass fail without inventing an arrow", async () => {
  const surface = surfaces();
  await assert.rejects(watchHeading({ ...surface, native: false }), {
    code: "HEADING_UNAVAILABLE",
    fatal: true,
  });
  surface.windowTarget.DeviceOrientationEvent = {
    async requestPermission() {
      return "denied";
    },
  };
  await assert.rejects(watchHeading({ ...surface, native: false }), {
    code: "HEADING_PERMISSION_DENIED",
    fatal: true,
  });
});

test("sensor silence makes a previous heading stale without fabricating new timestamps", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = nativeHarness(),
    values = [],
    errors = [];
  const stop = await watchHeading({
    ...surfaces(),
    native: true,
    plugin: h.plugin,
    now: () => now,
    onHeading: (v) => values.push(v),
    onError: (e) => errors.push(e),
    makeId: () => "test",
  });
  h.emit(observation());
  t.mock.timers.tick(5001);
  assert.equal(values.length, 1);
  assert.equal(values[0].timestamp, now);
  assert.equal(errors.at(-1).code, "HEADING_STALE");
  assert.equal(errors.at(-1).fatal, false);
  await stop();
});
