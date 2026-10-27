import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escape } from "../src/ui/dom.js";
import {
  manualPlaceLocation,
  manualMapLocation,
  describeUserLocation,
  isCurrentUserLocation,
} from "../src/data/user-location.js";
import {
  normalizeTrackingFloor,
  createLocationCalibration,
  applyLocationTracking,
} from "../src/data/location-tracking.js";

const floor = {
  id: "v-78-floor1",
  campusId: "v-78",
  level: 1,
  buildingLevels: { Г: 2, А: 1 },
};
const upperFloor = {
  id: "v-78-floor2",
  campusId: "v-78",
  level: 2,
  buildingLevels: { Г: 3, А: 2 },
};
const room = {
  id: "source-room",
  campusId: "v-78",
  floorId: floor.id,
  building: "Г",
  label: "Г-209",
  center: [12, -28],
  kind: "room",
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const fix = (
  point = [10, -20],
  timestamp = Date.now(),
  accuracyMeters = 8,
) => ({
  source: "gps",
  status: "inside",
  campusId: "v-78",
  floorId: null,
  building: null,
  physicalLevel: null,
  point,
  accuracyMeters,
  accuracyRadiusMap: accuracyMeters,
  timestamp,
  expiresAt: timestamp + 60_000,
  label: "Геопозиция",
});
const events = (target = {}) => {
  const handlers = new Map();
  return Object.assign(target, {
    addEventListener(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    dispatch(name, event = {}) {
      for (const handler of handlers.get(name) || [])
        handler({ type: name, target: this, ...event });
    },
  });
};

// Production controller and tracking policy; DOM, map rendering and OS watch
// registration/callbacks remain explicit boundaries, not radio/GPS evidence.
function harness({
  initial = null,
  canPick = true,
  pendingStart = false,
  now = Date.now,
} = {}) {
  const elements = new Map();
  function $(selector) {
    if (elements.has(selector)) return elements.get(selector);
    const classes = new Set();
    const element = events({
      hidden: false,
      disabled: false,
      checked: false,
      open: false,
      value: "",
      dataset: {},
      innerHTML: "",
      textContent: "",
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
      showModal() {
        this.open = true;
      },
      close() {
        if (this.open) {
          this.open = false;
          this.dispatch("close");
        }
      },
    });
    elements.set(selector, element);
    return element;
  }
  const state = {
    campus: { id: "v-78" },
    floor,
    floorData: [floor, upperFloor],
    search: [room],
    userLocation: initial,
    mode: "floor",
    building: "Г",
  };
  const window = events();
  const document = events({
    hidden: false,
    body: { dataset: {} },
    documentElement: { dataset: {} },
  });
  const watches = [],
    origins = [],
    points = [],
    surveyPoints = [],
    toasts = [];
  const timers = new Map();
  let nextTimer = 0,
    focuses = 0,
    follows = 0,
    centerPick = null;
  const headingWatches = [],
    headings = [];
  const scene = {
    locationPicking: false,
    getCenterLocationPick() {
      return centerPick;
    },
    followUserLocation() {
      follows++;
      return true;
    },
    setUserHeading(value) {
      headings.push(value);
    },
    setUserLocation(location) {
      points.push(location);
    },
    setSurveyLocation(location) {
      surveyPoints.push(location);
    },
    setLocationPicking(value) {
      this.locationPicking = canPick && Boolean(value);
      return this.locationPicking;
    },
    focusUserLocation() {
      focuses++;
      return true;
    },
  };
  function startWatching({ signal, onPosition, onError }) {
    const ready = deferred();
    const watch = {
      signal,
      stops: 0,
      emit: onPosition,
      fail: onError,
      ready() {
        ready.resolve(async () => {
          watch.stops++;
        });
      },
    };
    watches.push(watch);
    if (!pendingStart) watch.ready();
    return ready.promise;
  }
  const sandbox = {
    $,
    escape,
    document,
    window,
    AbortController,
    Date: class extends Date {
      static now() {
        return now();
      }
    },
    watchGpsLocation: startWatching,
    manualPlaceLocation,
    manualMapLocation,
    describeUserLocation,
    isCurrentUserLocation: (location) => isCurrentUserLocation(location, now()),
    normalizeTrackingFloor,
    createLocationCalibration(anchor, raw, options) {
      return createLocationCalibration(anchor, raw, { ...options, now: now() });
    },
    applyLocationTracking(raw, options) {
      return applyLocationTracking(raw, { ...options, now: now() });
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const source = readFileSync(
    new URL("../src/ui/location.js", import.meta.url),
    "utf8",
  )
    .replace(/^import[\s\S]*?from "[^\"]+";\n/gm, "")
    .replace(/export function bindLocation/, "function bindLocation");
  vm.runInNewContext(
    `${source}\nglobalThis.bindLocation = bindLocation;`,
    sandbox,
  );
  const controller = sandbox.bindLocation({
    state,
    scene,
    startWatching,
    startHeading: async ({ signal, onHeading, onError }) => {
      const watch = { signal, emit: onHeading, fail: onError, stops: 0 };
      headingWatches.push(watch);
      return async () => {
        watch.stops++;
      };
    },
    experience: { minimize() {} },
    routes: {
      setOrigin(place) {
        origins.push(place);
      },
      pauseGuidance() {},
    },
    closeRoom() {},
    chooseFloor(id) {
      state.floor = state.floorData.find((item) => item.id === id);
      return Boolean(state.floor);
    },
    toast(text) {
      toasts.push(text);
    },
    onChange() {},
  });
  return {
    $,
    state,
    scene,
    controller,
    watches,
    origins,
    points,
    surveyPoints,
    toasts,
    window,
    document,
    timers,
    headingWatches,
    headings,
    setPick(value) {
      centerPick = value;
    },
    browseFloor(building, floorId) {
      state.building = building;
      state.floor = state.floorData.find((f) => f.id === floorId);
    },
    get follows() {
      return follows;
    },
    get focuses() {
      return focuses;
    },
  };
}

test("manual place keeps its exact source identity and building's physical floor", () => {
  const location = manualPlaceLocation(room, floor, "v-78", 1000);
  assert.equal(location.placeId, room.id);
  assert.equal(location.floorId, floor.id);
  assert.equal(location.physicalLevel, 2);
  assert.deepEqual(location.point, room.center);
  assert.notEqual(
    location.point,
    room.center,
    "manual location owns its coordinate array",
  );
  assert.match(
    describeUserLocation(location, [floor]),
    /Г-209.*корпус Г.*2 этаж.*вручную/,
  );
  assert.equal(
    manualPlaceLocation({ ...room, center: [NaN, 2] }, floor, "v-78"),
    null,
  );
  assert.equal(manualPlaceLocation(room, null, "v-78"), null);
  assert.equal(
    manualPlaceLocation(
      { ...room, routingStatus: "display-only-no-source-transition" },
      floor,
      "v-78",
    ).placeId,
    null,
  );
});

test("manual map point never borrows a nearby room, wrong floor or campus", () => {
  const pick = {
    point: [12.01, -28],
    campusId: "v-78",
    floorId: floor.id,
    building: "А",
    areaId: "unlabelled-corridor",
  };
  const location = manualMapLocation(pick, floor, [room], 1000);
  assert.equal(
    location.placeId,
    null,
    "a geometrically nearby classroom is not the picked corridor",
  );
  assert.equal(location.building, "А");
  assert.equal(location.physicalLevel, 1);
  assert.equal(location.label, "Точка на карте");
  assert.equal(
    manualMapLocation({ ...pick, floorId: "other-floor" }, floor, [room]),
    null,
  );
  assert.equal(
    manualMapLocation({ ...pick, point: [Infinity, 0] }, floor, [room]),
    null,
  );
  const known = manualMapLocation(
    { ...pick, building: "Г", roomId: room.id },
    floor,
    [{ ...room, campusId: "other" }, room],
  );
  assert.equal(known.placeId, room.id);
  assert.equal(known.building, "Г");
});

test("an unclassified corridor retains the explicitly chosen building and its physical level", () => {
  const corridor = {
    id: "corridor",
    campusId: "v-78",
    floorId: floor.id,
    kind: "unclassified",
    building: null,
  };
  const location = manualMapLocation(
    {
      campusId: "v-78",
      floorId: floor.id,
      areaId: corridor.id,
      building: "Г",
      point: [9, -20],
    },
    floor,
    [corridor],
  );
  assert.equal(location.building, "Г");
  assert.equal(location.physicalLevel, 2);
});

test("quick location starts immediately without a building dialog and focuses once, then follows", async () => {
  const h = harness();
  h.$("#locate-open").onclick();
  await turn();
  assert.equal(h.$("#location-dialog").open, false);
  assert.equal(h.watches.length, 1);
  assert.equal(h.headingWatches.length, 1);
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now));
  h.watches[0].emit(fix([11, -21], now + 1000));
  assert.deepEqual(h.state.userLocation.point, [11, -21]);
  assert.equal(h.focuses, 1);
  assert.equal(h.follows, 1);
  assert.equal(
    h.state.userLocation.floorId,
    null,
    "viewing a floor is not a GPS measurement",
  );
  assert.equal(h.state.locationTracking.following, true);
});

test("recenter keeps an existing watch and map gestures pause only camera following", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now));
  h.controller.pauseFollowing();
  h.watches[0].emit(fix([11, -20], now + 1000));
  assert.equal(h.follows, 0);
  assert.deepEqual(h.state.userLocation.point, [11, -20]);
  h.$("#locate-open").onclick();
  assert.equal(h.watches.length, 1);
  assert.equal(h.focuses, 2);
  h.watches[0].emit(fix([12, -20], now + 2000));
  assert.equal(h.follows, 1);
});

test("closing location options does not stop location or heading, while explicit stop rejects late callbacks", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  h.watches[0].emit(fix());
  h.$("#location-options").onclick();
  assert.equal(h.$("#location-dialog").open, true);
  h.$("#location-close").onclick();
  assert.equal(h.watches[0].signal.aborted, false);
  const heading = {
    degrees: 90,
    timestamp: Date.now(),
    accuracy: 12,
    reference: "magnetic",
  };
  h.headingWatches[0].emit(heading);
  assert.equal(h.headings.at(-1), heading);
  const point = [...h.state.userLocation.point];
  h.controller.stopTracking();
  await turn();
  assert.equal(h.watches[0].stops, 1);
  assert.equal(h.headingWatches[0].stops, 1);
  assert.equal(h.headings.at(-1), null);
  h.watches[0].emit(fix([50, 50], Date.now() + 1000));
  h.headingWatches[0].emit(heading);
  assert.deepEqual(h.state.userLocation.point, point);
  assert.equal(h.headings.at(-1), null);
  assert.equal(h.state.locationTracking.enabled, false);
});

test("a heading failure does not disable GPS or draw an invented arrow", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  h.headingWatches[0].fail(new Error("No sensor"));
  assert.equal(h.headings.at(-1), null);
  assert.equal(h.state.headingStatus, "unavailable");
  assert.equal(h.state.locationTracking.enabled, true);
  h.watches[0].emit(fix());
  assert.equal(h.state.locationTracking.status, "live");
});

test("a canceled registration cannot replace or stop a newer location watch", async () => {
  const h = harness({ pendingStart: true });
  h.controller.startTracking();
  const old = h.watches[0];
  h.controller.stopTracking();
  h.controller.startTracking();
  const current = h.watches[1];
  old.ready();
  await turn();
  assert.equal(old.stops, 1);
  assert.equal(current.signal.aborted, false);
  current.ready();
  await turn();
  old.emit(fix([50, 50]));
  assert.equal(h.state.userLocation, null);
  current.emit(fix([12, -22]));
  assert.deepEqual(h.state.userLocation.point, [12, -22]);
});

test("foreground resumes enabled sensors but never re-enables an explicit stop", async () => {
  const h = harness();
  h.controller.startTracking();
  await turn();
  h.watches[0].emit(fix());
  h.document.hidden = true;
  h.document.dispatch("visibilitychange");
  await turn();
  assert.equal(h.watches[0].stops, 1);
  assert.equal(h.headingWatches[0].stops, 1);
  assert.equal(h.state.locationTracking.status, "paused");
  h.document.hidden = false;
  h.document.dispatch("visibilitychange");
  await turn();
  assert.equal(h.watches.length, 2);
  assert.equal(h.headingWatches.length, 2);
  h.controller.stopTracking();
  h.window.dispatch("atlas:app-state", { detail: { isActive: true } });
  await turn();
  assert.equal(h.watches.length, 2);
});

test("an explicit route action uses the selected view as context without changing the GPS floor", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  h.watches[0].emit(fix());
  h.browseFloor("Г", upperFloor.id);
  const origin = h.controller.routeOrigin();
  assert.equal(origin.floorId, upperFloor.id);
  assert.equal(origin.physicalLevel, 3);
  assert.equal(origin.floorEvidence, "manual-view-selection");
  assert.equal(h.state.userLocation.floorId, null);
  assert.equal(h.state.userLocation.building, null);
  h.state.mode = "overview";
  assert.equal(h.controller.routeOrigin(), null);
  h.controller.stopTracking();
  assert.equal(h.controller.routeOrigin(), null);
});

test("a confirmed own floor remains the route origin while viewing another floor", () => {
  const h = harness();
  h.controller.setPlace(room);
  h.browseFloor("Г", upperFloor.id);
  assert.equal(h.controller.routeOrigin().floorId, floor.id);
  assert.equal(h.controller.routeOrigin().physicalLevel, 2);
});

test("a fresh manual alignment starts at the point and transfers actual subsequent GPS displacement", async () => {
  const h = harness();
  h.controller.startTracking();
  await turn();
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now));
  assert.equal(h.controller.setPlace(room), true);
  assert.deepEqual(h.state.userLocation.point, room.center);
  assert.equal(h.state.userLocation.correction.type, "manual-offset");
  assert.equal(h.origins[0], room);
  h.watches[0].emit(fix([12, -19], now + 1000));
  assert.deepEqual(h.state.userLocation.point, [14, -27]);
  assert.equal(h.state.userLocation.accuracyMeters, 8);
  h.browseFloor("Г", upperFloor.id);
  h.controller.refresh();
  assert.equal(
    h.state.userLocation.floorId,
    floor.id,
    "map browsing never reassigns a confirmed point",
  );
});

test("poor GPS preserves a manual point without inventing subsequent movement", async () => {
  const h = harness();
  h.controller.startTracking();
  await turn();
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now, 100));
  h.controller.setPlace(room);
  assert.equal(h.state.userLocation.source, "manual");
  assert.equal(h.state.locationTracking.status, "needs-refinement");
  h.watches[0].emit(fix([11, -21], now + 1000));
  assert.deepEqual(h.state.userLocation.point, room.center);
});

const corridorPick = (point = [9, -19], sourceFloor = floor) => ({
  campusId: "v-78",
  floorId: sourceFloor.id,
  point,
  building: "Г",
  kind: "circulation",
});

test("a center pin waits for confirmation and keeps exact corridor coordinates instead of a room center", () => {
  const h = harness();
  h.setPick(corridorPick());
  assert.equal(h.controller.beginPicking(), true);
  assert.equal(h.state.userLocation, null);
  assert.equal(h.$("#location-pick-confirm").disabled, false);
  h.setPick(corridorPick([9.75, -19.25]));
  h.$("#location-pick-confirm").onclick();
  assert.deepEqual(h.state.userLocation.point, [9.75, -19.25]);
  assert.equal(h.state.userLocation.placeId, null);
  assert.equal(h.state.userLocation.physicalLevel, 2);
  assert.equal(h.origins.length, 0);
  assert.equal(h.scene.locationPicking, false);
  assert.equal(h.$("#location-crosshair").hidden, true);
});

test("an invalid center cannot be confirmed and cancel leaves the current point unchanged", () => {
  const h = harness();
  h.controller.setPlace(room);
  const point = h.state.userLocation;
  h.setPick(null);
  assert.equal(h.controller.beginPicking(), true);
  assert.equal(h.$("#location-pick-confirm").disabled, true);
  h.$("#location-pick-confirm").onclick();
  assert.equal(h.state.userLocation, point);
  h.$("#location-pick-cancel").onclick();
  assert.equal(h.scene.locationPicking, false);
  assert.equal(h.$("#location-pick-banner").hidden, true);
});

test("survey center pin is independent of GPS and contains a precise point on the chosen map floor", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now));
  const current = h.state.userLocation;
  h.browseFloor("Г", upperFloor.id);
  h.setPick(corridorPick([9.5, -19.125], upperFloor));
  let complete;
  h.controller.beginPicking({
    purpose: "survey",
    onPicked: (value) => (complete = value),
  });
  h.$("#location-pick-confirm").onclick();
  assert.equal(h.state.userLocation, current);
  assert.equal(h.state.userLocation.floorId, null);
  assert.deepEqual(h.state.surveyLocation.point, [9.5, -19.125]);
  assert.equal(h.state.surveyLocation.physicalLevel, 3);
  assert.equal(h.state.surveyLocation.placeId, null);
  assert.equal(complete.floorId, upperFloor.id);
  h.watches[0].emit(fix([11, -21], now + 1000));
  assert.deepEqual(h.state.surveyLocation.point, [9.5, -19.125]);
  assert.equal(h.origins.length, 0);
});

test("survey confirmation rejects an unestablished physical floor rather than borrowing an adjacent classroom", () => {
  const h = harness();
  h.setPick({ ...corridorPick(), building: null });
  h.controller.beginPicking({ purpose: "survey" });
  h.$("#location-pick-confirm").onclick();
  assert.equal(h.state.surveyLocation, undefined);
  assert.equal(h.scene.locationPicking, true);
  assert.match(h.toasts.at(-1), /этаж/);
});

test("failed map placement never leaves a misleading crosshair or banner", () => {
  const h = harness({ canPick: false });
  assert.equal(h.controller.beginPicking(), false);
  assert.equal(h.scene.locationPicking, false);
  assert.equal(h.$("#location-crosshair").hidden, true);
  assert.equal(h.$("#location-pick-banner").hidden, true);
});

test("permission denial and outside GPS preserve a useful manual point", async () => {
  const h = harness();
  h.controller.setPlace(room);
  h.controller.startTracking();
  await turn();
  h.watches[0].fail(Object.assign(new Error("Denied"), { code: 1 }));
  assert.deepEqual(h.state.userLocation.point, room.center);
  assert.equal(h.state.locationTracking.enabled, false);
  h.controller.startTracking();
  await turn();
  h.watches[1].emit({
    source: "gps",
    status: "outside",
    message: "За пределами карты",
  });
  assert.deepEqual(h.state.userLocation.point, room.center);
});

test("resetting a correction restores the raw point without fabricating a new observation", async () => {
  const h = harness();
  h.controller.startTracking();
  await turn();
  const now = Date.now();
  const raw = fix([10, -20], now);
  h.watches[0].emit(raw);
  h.controller.setPlace(room);
  h.$("#location-reset-correction").onclick();
  assert.deepEqual(h.state.userLocation.point, raw.point);
  assert.equal(h.state.userLocation.timestamp, now);
  assert.equal(h.state.userLocation.expiresAt, raw.expiresAt);
  assert.equal(h.state.userLocation.correction, null);
  assert.equal(h.watches.length, 1);
});

test("a new hall without known identity cannot inherit a previous room's building and floor", async () => {
  const h = harness();
  const hall = {
    ...room,
    id: "hall",
    label: "Холл",
    building: null,
    center: [20, -25],
  };
  h.state.search.push(hall);
  h.controller.startTracking();
  await turn();
  h.watches[0].emit(fix());
  h.controller.setPlace(room);
  h.controller.setPlace(hall);
  assert.notEqual(h.state.userLocation.building, "Г");
  assert.notEqual(h.state.userLocation.physicalLevel, 2);
});

test("current GPS excludes stopped signals and expired corrections even when the raw fix is fresh", () => {
  const now = Date.now(),
    raw = fix([10, -20], now);
  for (const trackingStatus of [
    "paused",
    "stopped",
    "signal-lost",
    "needs-refinement",
    "error",
  ])
    assert.equal(isCurrentUserLocation({ ...raw, trackingStatus }, now), false);
  assert.equal(
    isCurrentUserLocation({ ...raw, correction: { expiresAt: now - 1 } }, now),
    false,
  );
});

test("reapplying an old fix retains the last known point and its actual observation time", () => {
  const now = 100000,
    old = fix([10, -20], now - 61000);
  const result = applyLocationTracking(old, {
    previous: old,
    reapply: true,
    now,
  });
  assert.deepEqual(result.location.point, old.point);
  assert.equal(result.location.timestamp, old.timestamp);
  assert.equal(result.status, "signal-lost");
});

test("old GPS can still be recentered without becoming current or borrowing the visible floor", async () => {
  let time = Date.now();
  const h = harness({ now: () => time });
  h.controller.startTracking();
  await turn();
  const raw = fix([10, -20], time);
  h.watches[0].emit(raw);
  time += 61000;
  h.browseFloor("Г", upperFloor.id);
  h.controller.refresh();
  h.controller.locate();
  assert.deepEqual(h.state.userLocation.point, raw.point);
  assert.equal(h.state.userLocation.timestamp, raw.timestamp);
  assert.equal(h.controller.routeOrigin(), null);
  assert.equal(h.state.userLocation.floorId, null);
});

test("reset after lost GPS clears correction but preserves old timestamps until a real fresh fix", async () => {
  let time = Date.now();
  const h = harness({ now: () => time });
  h.controller.startTracking();
  await turn();
  const raw = fix([10, -20], time);
  h.watches[0].emit(raw);
  h.controller.setPlace(room);
  time += 61000;
  h.$("#location-reset-correction").onclick();
  assert.deepEqual(h.state.userLocation.point, raw.point);
  assert.equal(h.state.userLocation.correction, null);
  assert.equal(h.state.userLocation.timestamp, raw.timestamp);
  assert.equal(h.state.locationTracking.status, "signal-lost");
  h.watches[0].emit(fix([11, -21], time));
  assert.deepEqual(h.state.userLocation.point, [11, -21]);
  assert.equal(h.state.userLocation.correction, null);
});

test("confirming my precise pin resumes following while a survey pin keeps GPS independent", async () => {
  const h = harness();
  h.controller.locate();
  await turn();
  const now = Date.now();
  h.watches[0].emit(fix([10, -20], now));
  h.setPick(corridorPick([12, -28]));
  h.controller.beginPicking();
  assert.equal(h.state.locationTracking.following, false);
  h.$("#location-pick-confirm").onclick();
  assert.equal(h.state.locationTracking.following, true);
  assert.equal(h.state.userLocation.correction.type, "manual-offset");
  const prior = h.follows;
  h.watches[0].emit(fix([11, -20], now + 1000));
  assert.equal(h.follows, prior + 1);
  h.controller.beginPicking({ purpose: "survey" });
  h.$("#location-pick-confirm").onclick();
  assert.equal(h.state.locationTracking.following, false);
  assert.equal(h.state.userLocation.source, "gps");
});
