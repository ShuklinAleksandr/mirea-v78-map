import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeCurrentRouteEndpoint } from "../src/data/current-route-origin.js";
import { isCurrentUserLocation } from "../src/data/user-location.js";
import { createRouteTracker } from "../src/data/route-tracking.js";
import { createRouteTrackingSurfaceGuard } from "../src/data/route-tracking-surface.js";
import { findNextPlaces } from "../src/data/next-place-search.js";
import {
  placeLocation,
  presentPlaceIdentity,
} from "../src/data/place-location.js";
import placeLandmarks from "../src/data/place-landmarks.json" with { type: "json" };
import { nextRouteReadout } from "../src/ui/next-route.js";
import { variantStorageKey } from "../src/ui/variant.js";
import { isCompactLandscape } from "../src/ui/map-viewport.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
  guidanceAnchorForStep,
} from "../src/map/route-guidance.js";

// Exercise production controller transitions with DOM/WebGL/Worker as boundaries.
// This does not emulate layout: browser and device visual checks remain separate.
function harness(file, exports, saved = {}, options = {}) {
  const elements = new Map();
  const store = new Map(Object.entries(saved));
  function element(selector) {
    if (elements.has(selector)) return elements.get(selector);
    const listeners = new Map(),
      classes = new Set();
    const el = {
      hidden: false,
      value: "",
      innerHTML: "",
      textContent: "",
      dataset: {},
      children: [],
      attributes: {},
      disabled: false,
      inert: false,
      style: {
        values: new Map(),
        setProperty(name, value) {
          this.values.set(name, value);
        },
        removeProperty(name) {
          this.values.delete(name);
        },
      },
      classList: {
        contains: (name) => classes.has(name),
        toggle(name, force) {
          const on = force ?? !classes.has(name);
          on ? classes.add(name) : classes.delete(name);
          return on;
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      dispatch(type, data = {}) {
        const event = {
          currentTarget: el,
          preventDefault() {},
          detail: 1,
          ...data,
        };
        listeners.get(type)?.(event);
        el[`on${type}`]?.(event);
      },
      focus() {},
      blur() {},
      setPointerCapture() {},
      hasPointerCapture() {
        return true;
      },
      releasePointerCapture() {},
      contains() {
        return false;
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect() {
        return { height: selector === "#sheet-toggle" ? 44 : 500 };
      },
    };
    elements.set(selector, el);
    return el;
  }
  const workerMessages = [];
  const animationFrames = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const resizeObservers = [];
  let nextAnimationFrame = 0;
  let currentWorker;
  let clock = null;
  class Worker {
    constructor() {
      currentWorker = this;
    }
    postMessage(message) {
      workerMessages.push(message);
    }
    terminate() {}
  }
  const sandbox = {
    $: element,
    escape: String,
    icon: () => "",
    shareView: () => {},
    makeCurrentRouteEndpoint,
    isCurrentUserLocation,
    createRouteTracker,
    createRouteTrackingSurfaceGuard,
    findNextPlaces,
    placeLocation,
    presentPlaceIdentity,
    placeLandmarks,
    nextRouteReadout,
    isNextInterface: () => options.nextInterface === true,
    variantStorageKey: (key) =>
      variantStorageKey(key, options.nextInterface ? "next" : "classic"),
    bindInterfaceControls: () => {},
    createRouteGuidance,
    sampleRouteGuidance,
    guidanceAnchorForStep,
    getBundledMapPackage: async () => null,
    nativeShareLink: () => "",
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    document: {
      body: { dataset: {} },
      documentElement: { dataset: {} },
      addEventListener() {},
    },
    window: new EventTarget(),
    Worker,
    URL,
    URLSearchParams,
    Date: class extends Date {
      static now() {
        return clock ?? Date.now();
      }
    },
    innerWidth: options.width ?? 390,
    innerHeight: options.height ?? 844,
    isCompactLandscape,
    location: { hash: "" },
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = ++nextAnimationFrame;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        resizeObservers.push({ target, callback: this.callback });
      }
    },
  };
  const source = readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/export /g, "")
    .replace(/import\.meta\.url/g, '"https://local.test/routes.js"');
  const api = vm.runInNewContext(
    `${source}\n;({${exports.join(",")}})`,
    sandbox,
  );
  return {
    ...api,
    window: sandbox.window,
    element,
    document: sandbox.document,
    store,
    workerMessages,
    setNow(value) {
      clock = value;
    },
    setViewport(width, height) {
      sandbox.innerWidth = width;
      sandbox.innerHeight = height;
      sandbox.document.documentElement.clientHeight = height;
      sandbox.window.dispatchEvent(new Event("resize"));
    },
    tick(timestamp) {
      const next = animationFrames.entries().next().value;
      if (!next) return false;
      animationFrames.delete(next[0]);
      next[1](timestamp);
      return true;
    },
    animationFrames,
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    resize() {
      for (const { target, callback } of resizeObservers)
        callback([{ target }]);
    },
    reply(result, id = workerMessages.at(-1).id) {
      currentWorker.onmessage({ data: { result, id } });
    },
  };
}
function experienceHarness(saved, visualViewport, options = {}) {
  const h = harness(
    "../src/ui/experience.js",
    ["bindExperience", "readSaved"],
    saved,
    options,
  );
  h.window.visualViewport = visualViewport;
  const qualityCalls = [];
  const api = h.bindExperience({
    state: { search: [] },
    scene: {
      setTheme() {},
      setQuality(value) {
        qualityCalls.push(value);
      },
      setReducedMotion() {},
    },
    navigateRoom() {},
    toast() {},
  });
  return { ...h, ...api, qualityCalls };
}
function routeHarness({
  nextInterface = false,
  chooseFloor: chooseFloorOverride,
  getUserOrigin,
  onLocate,
  onRefineLocation,
  onConfirmFloor,
  onPauseFollowing,
} = {}) {
  const h = harness(
    "../src/ui/routes.js",
    ["bindRoutes"],
    {},
    { nextInterface },
  );
  const state = {
    campus: { id: "a" },
    loading: 1,
    floor: { id: "a-floor1" },
    search: [],
    manifest: { campuses: [] },
  };
  const draws = [];
  const guidanceCalls = [];
  const guidanceOptions = [];
  const sheetCalls = [];
  const navigationModes = [];
  const overviewCalls = [];
  const scene = {
    setNavigationMode(active) {
      navigationModes.push(active);
    },
    clearRoute() {},
    setRoute(route) {
      draws.push(route);
    },
    setRouteOverview(value) {
      overviewCalls.push(value);
    },
    setRouteGuidance(sample, options) {
      guidanceCalls.push(sample);
      guidanceOptions.push(options);
    },
  };
  const api = h.bindRoutes({
    state,
    getUserOrigin,
    onLocate,
    onRefineLocation,
    onConfirmFloor,
    onPauseFollowing,
    scene,
    loadCampus: async (id) => {
      state.campus = { id };
      state.loading++;
      return true;
    },
    chooseFloor(id) {
      if (chooseFloorOverride) return chooseFloorOverride(id, state);
      state.floor = { id };
      state.loading++;
      return true;
    },
    closeRoom() {},
    toast() {},
    updateUI() {},
    saveView() {},
    experience: {
      expand(value) {
        sheetCalls.push(value ? "expanded" : "peek");
      },
      minimize() {
        sheetCalls.push("minimized");
      },
      remember() {},
    },
  });
  const room = (id, campusId = "a") => ({
    id,
    label: id,
    campusId,
    floorId: `${campusId}-floor1`,
  });
  api.setEndpoint("from", room("start"));
  api.setEndpoint("to", room("finish"));
  const result = {
    ok: true,
    campusId: "a",
    steps: [{ floorId: "a-floor1", text: "Пройдите к аудитории" }],
    segments: [{ floorId: "a-floor1", nodes: [{ physicalLevel: 1 }] }],
  };
  return {
    ...h,
    ...api,
    state,
    scene,
    draws,
    guidanceCalls,
    guidanceOptions,
    sheetCalls,
    navigationModes,
    overviewCalls,
    room,
    result,
  };
}

async function buildPreview(h) {
  h.result.segments[0].points = [
    [0, 0],
    [20, 0],
  ];
  h.result.steps[0].position = [0, 0];
  const pending = h.build();
  h.reply(h.result);
  await pending;
}

test("dragging mobile sheet up/down keeps its position after the synthesized click", () => {
  const h = experienceHarness();
  const handle = h.element("#sheet-toggle"),
    sheet = h.element(".sidebar");
  handle.dispatch("pointerdown", { clientY: 300, pointerId: 1 });
  handle.dispatch("pointerup", { clientY: 200, pointerId: 1 });
  handle.dispatch("click");
  assert.equal(sheet.classList.contains("expanded"), true);
  handle.dispatch("pointerdown", { clientY: 200, pointerId: 2 });
  handle.dispatch("pointerup", { clientY: 300, pointerId: 2 });
  handle.dispatch("click");
  assert.equal(sheet.classList.contains("expanded"), false);
  handle.dispatch("click", { detail: 0 });
  assert.equal(
    sheet.classList.contains("expanded"),
    true,
    "keyboard activation still toggles",
  );
});

test("the sheet can be swiped to the bottom, reopened and revealed by search/navigation", () => {
  const h = experienceHarness();
  const handle = h.element("#sheet-toggle"),
    sheet = h.element(".sidebar"),
    content = h.element(".sidebar-scroll");
  handle.dispatch("pointerdown", { clientY: 400, pointerId: 1 });
  handle.dispatch("pointermove", { clientY: 530, pointerId: 1 });
  assert.equal(sheet.style.values.get("--sheet-drag"), "130px");
  handle.dispatch("pointerup", { clientY: 530, pointerId: 1 });
  handle.dispatch("click");
  assert.equal(sheet.classList.contains("minimized"), true);
  assert.equal(content.inert, true, "offscreen controls cannot receive focus");
  assert.equal(content.attributes["aria-hidden"], "true");
  assert.equal(handle.attributes["aria-label"], "Открыть поиск и маршрут");
  assert.equal(sheet.style.values.has("--sheet-drag"), false);
  handle.dispatch("click", { detail: 0 });
  assert.equal(sheet.classList.contains("minimized"), false);
  assert.equal(sheet.classList.contains("expanded"), true);
  assert.equal(content.inert, false);
  h.expand(true);
  handle.dispatch("pointerdown", { clientY: 200, pointerId: 2 });
  handle.dispatch("pointerup", { clientY: 650, pointerId: 2 });
  handle.dispatch("click");
  assert.equal(
    sheet.classList.contains("minimized"),
    true,
    "one long downward swipe can pass the middle position",
  );
  h.expand(false);
  assert.equal(
    sheet.classList.contains("minimized"),
    false,
    "a selected room or completed route reveals its card again",
  );
  assert.equal(content.inert, false);
});

test("canceled or unrelated pointers cannot collapse the sheet; keyboard arrows reach every position", () => {
  const h = experienceHarness();
  const handle = h.element("#sheet-toggle"),
    sheet = h.element(".sidebar");
  h.expand(true);
  handle.dispatch("pointerdown", { clientY: 200, pointerId: 1 });
  handle.dispatch("pointermove", { clientY: 600, pointerId: 2 });
  handle.dispatch("pointerup", { clientY: 600, pointerId: 2 });
  assert.equal(sheet.classList.contains("expanded"), true);
  handle.dispatch("pointercancel", { pointerId: 1 });
  handle.dispatch("click");
  assert.equal(sheet.classList.contains("expanded"), true);
  assert.equal(sheet.classList.contains("minimized"), false);
  handle.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(sheet.classList.contains("expanded"), false);
  handle.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(sheet.classList.contains("minimized"), true);
  handle.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(sheet.classList.contains("minimized"), false);
  handle.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(sheet.classList.contains("expanded"), true);
});

test("Android Back closes search suggestions before collapsing the sheet or leaving the app", () => {
  const h = experienceHarness();
  const back = () => {
    const event = new Event("atlas:back", { cancelable: true });
    h.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  h.element("#results").hidden = false;
  h.element("#route-results").hidden = true;
  h.expand(true);
  assert.equal(back(), true);
  assert.equal(h.element("#results").hidden, true);
  assert.equal(h.element("#search").attributes["aria-expanded"], "false");
  assert.equal(h.element(".sidebar").classList.contains("expanded"), false);
  assert.equal(back(), false);
  h.element("#route-results").hidden = false;
  h.expand(true);
  assert.equal(back(), true);
  assert.equal(h.element("#route-results").hidden, true);
  assert.equal(h.element("#route-from").attributes["aria-expanded"], "false");
  assert.equal(h.element("#route-to").attributes["aria-expanded"], "false");
  assert.equal(h.element(".sidebar").classList.contains("expanded"), true);
  assert.equal(back(), true);
  assert.equal(h.element(".sidebar").classList.contains("expanded"), false);
});

test("the expanded sheet follows an overlay keyboard and releases its viewport offsets when collapsed", () => {
  const visualViewport = Object.assign(new EventTarget(), {
    scale: 1,
    height: 500,
    offsetTop: 24,
  });
  const h = experienceHarness(undefined, visualViewport);
  const bounds = h.element(".sidebar").style.values;
  h.expand(true);
  assert.equal(bounds.get("--sheet-viewport-top"), "24px");
  assert.equal(bounds.get("--sheet-viewport-bottom"), "320px");
  visualViewport.height = 844;
  visualViewport.offsetTop = 0;
  visualViewport.dispatchEvent(new Event("resize"));
  assert.equal(bounds.get("--sheet-viewport-bottom"), "0px");
  h.expand(false);
  assert.equal(bounds.has("--sheet-viewport-top"), false);
  assert.equal(bounds.has("--sheet-viewport-bottom"), false);
});

test("malformed saved arrays/settings cannot prevent startup or favorite/history controls", () => {
  for (const value of ["{}", '"broken"', "12", "null"]) {
    const h = experienceHarness({
      "atlas:favorites": value,
      "atlas:recent": value,
      "atlas:settings": value,
    });
    assert.doesNotThrow(() => h.renderSaved());
    assert.doesNotThrow(() => h.remember({ id: "a" }));
    assert.equal(h.favorite({ id: "a" }), true);
  }
  const h = experienceHarness({
    "atlas:favorites": '[1,null,"a"]',
    "atlas:settings": '{"theme":7,"motion":"bad","quality":"unknown"}',
  });
  assert.equal(JSON.stringify(h.readSaved("favorites", [])), '["a"]');
  const settings = JSON.parse(h.store.get("atlas:settings"));
  assert.deepEqual(settings, {
    theme: "system",
    quality: "balanced",
    frameRate: "auto",
    motion: false,
    headingFollow: true,
  });
  h.element("#heading-follow-setting").onchange({ target: { checked: false } });
  assert.equal(JSON.parse(h.store.get("atlas:settings")).headingFollow, false);
});

test("canceling a route during worker calculation cannot restore its path", async () => {
  const h = routeHarness();
  const pending = h.build();
  assert.equal(h.workerMessages.length, 1);
  h.element("#route-clear").onclick();
  h.reply(h.result);
  await pending;
  assert.equal(h.getRoute(), null);
  assert.equal(h.draws.length, 0);
  assert.equal(h.element("#route-build").disabled, false);
});

test("manual floor navigation during calculation cancels result and resolves loading status", async () => {
  const h = routeHarness();
  const pending = h.build();
  h.state.loading++;
  h.reply(h.result);
  await pending;
  assert.equal(h.getRoute(), null);
  assert.match(h.element("#route-status").textContent, /изменилась|отмен/);
  assert.equal(h.element("#route-build").disabled, false);
});

test("an older worker result cannot overwrite a newer endpoint selection", async () => {
  const h = routeHarness();
  const first = h.build();
  const firstId = h.workerMessages[0].id;
  h.setEndpoint("to", h.room("new-finish"));
  const second = h.build();
  h.reply({ ...h.result, marker: "new" });
  await second;
  h.reply({ ...h.result, marker: "old" }, firstId);
  await first;
  assert.equal(h.getRoute().marker, "new");
  assert.equal(h.draws.length, 1);
});

test("cross-campus endpoints never start an indoor worker calculation", async () => {
  const h = routeHarness();
  h.setEndpoint("to", h.room("other-campus", "b"));
  await h.build();
  assert.equal(h.workerMessages.length, 0);
  assert.match(h.element("#route-status").textContent, /внешний маршрут/);
});

test("editing a built route retains both validated endpoints and recalculates changed destination", async () => {
  const h = routeHarness();
  const first = h.build();
  h.reply(h.result);
  await first;
  h.element("#route-edit").onclick();
  assert.equal(h.getRoute(), null);
  assert.equal(h.element("#route-panel").dataset.complete, "false");
  assert.equal(h.element("#route-from").value, "start");
  assert.equal(h.element("#route-to").value, "finish");
  const params = new URLSearchParams();
  h.appendURL(params);
  assert.equal(params.get("from"), "start");
  assert.equal(params.get("to"), "finish");
  h.setEndpoint("to", h.room("new-finish"));
  const second = h.build();
  assert.equal(h.workerMessages.at(-1).from.id, "start");
  assert.equal(h.workerMessages.at(-1).to.id, "new-finish");
  h.reply({ ...h.result, marker: "edited" });
  await second;
  assert.equal(h.getRoute().marker, "edited");
});

test("a saved route never replaces the header of an explicitly selected place or wing", async () => {
  const h = routeHarness();
  h.result.segments[0].nodes[0] = {
    physicalLevel: 2,
    sourceLevel: 1,
    building: "Г",
  };
  const pending = h.build();
  h.reply(h.result);
  await pending;
  const header = h.element("#focus-floor-status");
  h.state.selected = { id: "А-146", building: "А" };
  header.innerHTML = "1 этаж · корпус А";
  h.syncView();
  assert.equal(header.innerHTML, "1 этаж · корпус А");
  h.state.selected = null;
  h.state.building = "А";
  h.syncView();
  assert.equal(header.innerHTML, "1 этаж · корпус А");
  h.state.building = null;
  h.syncView();
  assert.match(
    header.innerHTML,
    /2 этаж · корпус Г/,
    "route focus still provides its header when the map returns to the route",
  );
});

test("route build focuses its first local section and preview pauses before a manual floor hand-off", async () => {
  const h = routeHarness();
  h.result.steps = [
    {
      kind: "start",
      floorId: "a-floor1",
      position: [0, 0],
      text: "Начните здесь",
    },
    {
      kind: "stairs",
      floorId: "a-floor1",
      targetFloorId: "a-floor2",
      position: [0.44, 0],
      text: "Поднимитесь по лестнице",
    },
    {
      kind: "arrive",
      floorId: "a-floor2",
      position: [20.44, 20],
      text: "Назначение",
    },
  ];
  h.result.segments = [
    {
      floorId: "a-floor1",
      points: [
        [0, 0],
        [0.44, 0],
      ],
      nodes: [{ physicalLevel: 1 }],
    },
    {
      floorId: "a-floor2",
      points: [
        [20, 20],
        [20.44, 20],
      ],
      nodes: [{ physicalLevel: 2 }],
    },
  ];
  h.result.transitions = [
    {
      fromFloorId: "a-floor1",
      toFloorId: "a-floor2",
      point: [0.44, 0],
      targetPoint: [20, 20],
      label: "Поднимитесь на 2 этаж",
    },
  ];
  const pending = h.build();
  h.reply(h.result);
  await pending;
  assert.equal(h.guidanceCalls.at(-1).floorId, "a-floor1");
  assert.deepEqual(Array.from(h.guidanceCalls.at(-1).position), [0, 0]);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  h.tick(0);
  h.tick(100);
  assert.ok(h.guidanceCalls.at(-1).distance > 0);
  h.tick(200);
  assert.equal(h.guidanceCalls.at(-1).atEnd, true);
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(h.animationFrames.size, 0, "no frame crosses the stair gap");
  assert.equal(h.element("#route-next-section").hidden, false);
  h.element("#route-next-section").dispatch("click");
  assert.equal(h.state.floor.id, "a-floor2");
  assert.deepEqual(Array.from(h.guidanceCalls.at(-1).position), [20, 20]);
  assert.equal(
    h.animationFrames.size,
    0,
    "the next section waits for its own preview action",
  );
});

test("manual guidance slider and map interaction pause preview, while cancellation clears its marker", async () => {
  const h = routeHarness();
  h.result.segments[0].points = [
    [0, 0],
    [20, 0],
  ];
  h.result.steps[0].position = [0, 0];
  const pending = h.build();
  h.reply(h.result);
  await pending;
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  h.tick(0);
  h.tick(100);
  h.pauseGuidance();
  assert.equal(h.animationFrames.size, 0);
  const slider = h.element("#route-progress-position");
  slider.value = "500";
  slider.dispatch("input");
  assert.deepEqual(Array.from(h.guidanceCalls.at(-1).position), [10, 0]);
  assert.equal(h.animationFrames.size, 0);
  h.element("#route-clear").onclick();
  assert.equal(h.guidanceCalls.at(-1), null);
  assert.equal(h.getRoute(), null);
});

test("external overview, floor or place navigation pauses preview without returning to its section", async () => {
  for (const navigate of [
    (state) => {
      state.mode = "overview";
      state.floor = null;
    },
    (state) => (state.floor = { id: "a-floor2" }),
    (state) => (state.selected = { id: "a-room", floorId: "a-floor1" }),
    (state) => state.loading++,
  ]) {
    const h = routeHarness();
    await buildPreview(h);
    h.element("#route-dock-next").dispatch("click");
    h.element("#route-preview-play").dispatch("click");
    const drawCount = h.draws.length;
    navigate(h.state);
    const selectedFloor = h.state.floor;
    h.tick(100);
    assert.equal(h.animationFrames.size, 0);
    assert.equal(h.draws.length, drawCount, "no preview floor rebuild occurs");
    assert.equal(h.state.floor, selectedFloor);
    assert.equal(h.guidanceCalls.at(-1), null);
  }
});

test("a canceled animation callback cannot move or schedule frames for a newer preview", async () => {
  const h = routeHarness();
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  const oldCallback = h.animationFrames.values().next().value;
  h.pauseGuidance();
  h.element("#route-preview-play").dispatch("click");
  const callCount = h.guidanceCalls.length;
  oldCallback(1000);
  assert.equal(h.guidanceCalls.length, callCount);
  assert.equal(h.animationFrames.size, 1);
  h.tick(1000);
  h.tick(1100);
  assert.ok(h.guidanceCalls.at(-1).distance > 0);
});

test("a projection change preserves a manually selected route floor", async () => {
  const h = routeHarness();
  h.result.segments.push({
    floorId: "a-floor2",
    points: [
      [30, 0],
      [40, 0],
    ],
    nodes: [{ physicalLevel: 2 }],
  });
  await buildPreview(h);
  h.showFloor("a-floor2");
  h.projectionChanged();
  assert.equal(h.state.floor.id, "a-floor2");
  assert.equal(h.guidanceCalls.at(-1), null);
  assert.equal(h.animationFrames.size, 0);
});

test("an unavailable floor never receives a route marker or a false floor header", async () => {
  const h = routeHarness({
    chooseFloor(id, state) {
      if (id === "a-floor2") return false;
      state.floor = { id };
      state.loading++;
      return true;
    },
  });
  await buildPreview(h);
  const drawCount = h.draws.length;
  const oldHeader = h.element("#focus-floor-status").innerHTML;
  assert.equal(h.showFloor("a-floor2"), false);
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(h.draws.length, drawCount);
  assert.equal(h.element("#focus-floor-status").innerHTML, oldHeader);
  assert.equal(h.guidanceCalls.at(-1), null);
  h.element("#route-clear").onclick();
  assert.equal(h.showFloor("a-floor2"), false);
});

test("choosing steps at an identical anchor retains the explicitly selected instruction", async () => {
  const h = routeHarness();
  h.result.steps = [
    { floorId: "a-floor1", position: [0, 0], text: "Начните у двери" },
    { floorId: "a-floor1", position: [0, 0], text: "Пройдите по коридору" },
    { floorId: "a-floor1", position: [20, 0], text: "Прибытие" },
  ];
  const firstStep = h.element("#first-step");
  firstStep.dataset.step = "0";
  h.element("#route-steps").children = [firstStep];
  await buildPreview(h);
  firstStep.onclick();
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Начните у двери",
  );
  h.element("#route-dock-next").dispatch("click");
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Пройдите по коридору",
  );
});

test("dragging progress updates the paused state and finish action without replacing the slider", async () => {
  const h = routeHarness();
  h.result.steps = [
    { floorId: "a-floor1", position: [0, 0], text: "Начало" },
    { floorId: "a-floor1", position: [20, 0], text: "Прибытие" },
  ];
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  const slider = h.element("#route-progress-position");
  slider.value = "1000";
  slider.dispatch("input");
  assert.equal(h.animationFrames.size, 0);
  assert.match(h.element("#route-guidance-status").textContent, /вручную/);
  assert.match(h.element("#route-dock-next").innerHTML, /Завершить/);
  slider.value = "0";
  slider.dispatch("input");
  assert.match(h.element("#route-dock-next").innerHTML, /Далее/);
  assert.deepEqual(Array.from(h.guidanceCalls.at(-1).position), [0, 0]);
});

test("native pause and pagehide cancel movement, and returning never advances or restarts preview", async () => {
  for (const eventName of ["atlas:app-state", "pagehide"]) {
    const h = routeHarness();
    await buildPreview(h);
    h.element("#route-dock-next").dispatch("click");
    h.element("#route-preview-play").dispatch("click");
    h.tick(0);
    h.tick(100);
    const distance = h.guidanceCalls.at(-1).distance;
    const progress = h.element("#route-progress-position").value;
    const callCount = h.guidanceCalls.length;
    assert.ok(distance > 0);
    h.window.dispatchEvent(
      Object.assign(new Event(eventName), { detail: { isActive: false } }),
    );
    assert.equal(h.animationFrames.size, 0);
    h.window.dispatchEvent(
      Object.assign(new Event("atlas:app-state"), {
        detail: { isActive: true },
      }),
    );
    assert.equal(h.tick(60000), false, "returning never restarts preview");
    assert.equal(h.guidanceCalls.length, callCount);
    assert.equal(h.element("#route-progress-position").value, progress);
    h.element("#route-preview-play").dispatch("click");
    h.tick(60000);
    assert.equal(h.guidanceCalls.at(-1).distance, distance);
    h.tick(60100);
    assert.ok(h.guidanceCalls.at(-1).distance > distance);
  }
});

test("guidance supplies the actual mobile panel occupation after its controls expand", async () => {
  const h = routeHarness();
  const panel = h.element("#route-panel");
  h.element(".sidebar").getBoundingClientRect = () =>
    panel.dataset.guiding === "true"
      ? { height: 590, top: 254 }
      : { height: 340, top: 504 };
  await buildPreview(h);
  assert.equal(panel.dataset.guiding, "false");
  assert.equal(h.guidanceOptions.at(-1).padding.bottom, 356);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  assert.equal(panel.dataset.guiding, "true");
  h.tick(0);
  assert.deepEqual(
    { ...h.guidanceOptions.at(-1).padding },
    { top: 164, bottom: 606, left: 64, right: 64 },
  );
  h.element("#route-clear").onclick();
  assert.equal(panel.dataset.guiding, "false");
});

test("resizing a paused guidance panel updates padding without returning from another place or floor", async () => {
  const h = routeHarness();
  h.scene.mode = "floor";
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-preview-play").dispatch("click");
  h.tick(0);
  h.tick(100);
  h.pauseGuidance();
  const distance = h.guidanceCalls.at(-1).distance;
  h.element(".sidebar").getBoundingClientRect = () => ({
    top: 400,
    height: 444,
  });
  h.resize();
  assert.equal(h.guidanceOptions.at(-1).padding.bottom, 460);
  assert.equal(h.guidanceCalls.at(-1).distance, distance);
  assert.equal(h.animationFrames.size, 0);
  const callCount = h.guidanceCalls.length;
  h.state.floor = { id: "a-floor2" };
  h.resize();
  assert.equal(h.state.floor.id, "a-floor2");
  assert.equal(h.guidanceCalls.length, callCount);
  h.state.floor = { id: "a-floor1" };
  h.state.selected = { id: "another-place" };
  h.resize();
  assert.equal(h.guidanceCalls.length, callCount);
  h.state.selected = null;
  h.scene.routeOverview = true;
  h.resize();
  assert.equal(h.guidanceCalls.length, callCount);
});

test("compact navigation stays on the map, advances floors only on explicit next and supports back/finish", async () => {
  const h = routeHarness();
  h.result.steps = [
    {
      kind: "start",
      floorId: "a-floor1",
      position: [0, 0],
      text: "От входа к лестнице",
    },
    {
      kind: "stairs",
      floorId: "a-floor1",
      position: [10, 0],
      targetFloorId: "a-floor2",
      text: "Поднимитесь на 2 этаж",
    },
    {
      kind: "arrive",
      floorId: "a-floor2",
      position: [15, 20],
      text: "Вы у аудитории",
    },
  ];
  h.result.segments = [
    {
      floorId: "a-floor1",
      points: [
        [0, 0],
        [10, 0],
      ],
      nodes: [{ physicalLevel: 1 }],
    },
    {
      floorId: "a-floor2",
      points: [
        [10, 20],
        [15, 20],
      ],
      nodes: [{ physicalLevel: 2 }],
    },
  ];
  const pending = h.build();
  h.reply(h.result);
  await pending;
  assert.equal(h.element("#route-guidance-dock").hidden, false);
  assert.match(h.element("#route-dock-next").innerHTML, /В путь/);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.sheetCalls.at(-1), "minimized");
  assert.equal(h.document.body.dataset.routeNavigation, "true");
  assert.equal(
    h.animationFrames.size,
    0,
    "starting a real walk never starts a demonstration",
  );
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "От входа к лестнице",
  );
  assert.equal(h.element("#route-dock-meta").textContent, "Шаг 1 из 3");
  assert.equal(h.element("#route-dock-previous").hidden, true);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Поднимитесь на 2 этаж",
  );
  assert.equal(
    h.state.floor.id,
    "a-floor1",
    "the stair instruction remains on its source floor",
  );
  h.element("#route-dock-next").dispatch("click");
  assert.equal(
    h.state.floor.id,
    "a-floor2",
    "only explicit completion of the stair step changes floors",
  );
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Вы у аудитории",
  );
  h.element("#route-dock-previous").dispatch("click");
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(h.element("#route-dock-meta").textContent, "Шаг 2 из 3");
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.getRoute(), null);
  assert.equal(h.element("#route-guidance-dock").hidden, true);
  assert.equal(h.document.body.dataset.routeNavigation, "false");
  assert.equal(h.guidanceCalls.at(-1), null);
  assert.equal(h.sheetCalls.at(-1), "minimized");
});

test("the route camera reserves the compact card's actual area, and a manual origin does not open the sheet", async () => {
  const h = routeHarness();
  h.element("#route-guidance-dock").getBoundingClientRect = () => ({
    top: 630,
    bottom: 780,
    height: 150,
  });
  h.element(".sidebar").getBoundingClientRect = () => ({
    top: 800,
    height: 44,
  });
  const calls = h.sheetCalls.length;
  h.setOrigin(h.room("I am here"));
  assert.equal(h.sheetCalls.length, calls);
  assert.equal(h.getEndpoints().from.label, "I am here");
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.guidanceOptions.filter(Boolean).at(-1).padding.bottom, 226);
  assert.equal(h.guidanceOptions.filter(Boolean).at(-1).showMarker, false);
  assert.equal(h.sheetCalls.at(-1), "minimized");
  assert.equal(h.animationFrames.size, 0);
  h.element("#route-dock-close").dispatch("click");
  assert.equal(h.getRoute(), null);
  assert.equal(h.getEndpoints().from, null);
});

test("Next dock opens route details without discarding the path and enables navigation visuals only while guiding", async () => {
  const h = routeHarness({ nextInterface: true });
  await buildPreview(h);
  const route = h.getRoute();
  const endpoints = h.getEndpoints();
  assert.equal(h.document.body.dataset.routeAvailable, "true");
  assert.equal(h.navigationModes.at(-1), false);
  h.element("#route-dock-open").dispatch("click");
  assert.equal(h.sheetCalls.at(-1), "expanded");
  assert.equal(h.getRoute(), route);
  assert.deepEqual(h.getEndpoints(), endpoints);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.navigationModes.at(-1), true);
  h.clear();
  assert.equal(h.navigationModes.at(-1), false);
  assert.equal(h.document.body.dataset.routeAvailable, "false");
});

test("Next route endpoint search shares food categories while Classic preserves its label-only candidates", () => {
  for (const nextInterface of [false, true]) {
    const h = routeHarness({ nextInterface });
    h.state.search = [
      {
        id: "food",
        label: "Буфет",
        kind: "cafeteria",
        campusId: "a",
        floorId: "a-floor1",
        building: "Г",
      },
      {
        id: "room",
        label: "Г-209",
        kind: "room",
        campusId: "a",
        floorId: "a-floor1",
        building: "Г",
      },
    ];
    h.state.manifest.campuses = [
      {
        id: "a",
        title: "Кампус",
        floors: [{ id: "a-floor1", buildingLevels: { Г: 2 } }],
      },
    ];
    h.element("#route-to").value = "еда";
    h.element("#route-to").oninput();
    const markup = h.element("#route-results").innerHTML;
    if (nextInterface) {
      assert.match(markup, /Буфет/);
      assert.match(markup, /Корпус Г · 2 этаж/);
      assert.doesNotMatch(markup, /Г-209/);
    } else assert.match(markup, /Ничего не найдено/);
  }
});

test("a step with an unavailable destination floor cannot claim arrival or discard the previous instruction", async () => {
  const h = routeHarness({
    chooseFloor(id, state) {
      if (id === "a-floor2") return false;
      state.floor = { id };
      state.loading++;
      return true;
    },
  });
  h.result.steps = [
    {
      kind: "start",
      floorId: "a-floor1",
      position: [0, 0],
      text: "Оставайтесь у лестницы",
    },
    {
      kind: "arrive",
      floorId: "a-floor2",
      position: [20, 20],
      text: "Вы пришли",
    },
  ];
  h.result.segments.push({
    floorId: "a-floor2",
    points: [
      [20, 20],
      [25, 20],
    ],
    nodes: [{ physicalLevel: 2 }],
  });
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(h.element("#route-dock-meta").textContent, "Шаг 1 из 2");
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Оставайтесь у лестницы",
  );
  assert.equal(h.guidanceCalls.filter(Boolean).at(-1).floorId, "a-floor1");
});

test("changing 2D/3D preserves an explicitly selected instruction at a shared anchor", async () => {
  const h = routeHarness();
  h.result.steps = [
    { floorId: "a-floor1", position: [0, 0], text: "Начните у двери" },
    { floorId: "a-floor1", position: [0, 0], text: "Далее по коридору" },
  ];
  await buildPreview(h);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Начните у двери",
  );
  h.projectionChanged();
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Начните у двери",
  );
  assert.equal(h.element("#route-dock-meta").textContent, "Шаг 1 из 2");
});

test("the small current-origin button waits for one fix, then snapshots and builds without following later GPS", async () => {
  let position = null,
    requests = 0;
  const h = routeHarness({
    getUserOrigin: () => position,
    onLocate: () => requests++,
  });
  h.clear();
  h.setEndpoint("to", h.room("finish"));
  h.element("#route-use-location").onclick();
  assert.equal(requests, 1);
  assert.equal(h.getEndpoints().from, null);
  position = {
    source: "manual",
    campusId: "a",
    floorId: "a-floor1",
    point: [2, 3],
    physicalLevel: 1,
    building: "Г",
    timestamp: Date.now(),
  };
  h.state.userLocation = position;
  h.locationChanged();
  const snapshot = h.getEndpoints().from;
  assert.equal(snapshot.kind, "user-location");
  assert.deepEqual(snapshot.location.point, [2, 3]);
  assert.equal(h.workerMessages.length, 1);
  position = { ...position, point: [8, 9] };
  h.state.userLocation = position;
  h.locationChanged();
  assert.equal(h.getEndpoints().from, snapshot);
  assert.equal(h.workerMessages.length, 1);
  h.reply(h.result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.element("#route-share").hidden, true);
  const params = new URLSearchParams("from=old-room");
  h.appendURL(params);
  assert.equal(params.has("from"), false);
  assert.equal(params.get("to"), "finish");
});

test("a fresh GPS point without usable selected-plan context asks to refine instead of guessing a nearby room", () => {
  let refinements = 0,
    requests = 0;
  const h = routeHarness({
    getUserOrigin: () => null,
    onLocate: () => requests++,
    onRefineLocation: () => refinements++,
  });
  h.clear();
  h.state.userLocation = {
    source: "gps",
    campusId: "a",
    point: [2, 3],
    timestamp: Date.now(),
    trackingStatus: "live",
  };
  assert.equal(h.useCurrentLocation({ open: false }), false);
  assert.equal(refinements, 1);
  assert.equal(requests, 0);
  assert.equal(h.getEndpoints().from, null);
});

test("a manually selected origin cancels a pending current-location action", () => {
  let position = null;
  const h = routeHarness({ getUserOrigin: () => position, onLocate() {} });
  h.clear();
  h.useCurrentLocation({ open: false });
  h.setOrigin(h.room("chosen-room"));
  position = {
    source: "manual",
    campusId: "a",
    floorId: "a-floor1",
    point: [2, 3],
    timestamp: Date.now(),
  };
  h.state.userLocation = position;
  h.locationChanged();
  assert.equal(h.getEndpoints().from.id, "chosen-room");
  assert.equal(h.workerMessages.length, 0);
});

test("typing a different origin cancels a pending GPS selection before a late fix arrives", () => {
  let position = null;
  const h = routeHarness({ getUserOrigin: () => position, onLocate() {} });
  h.clear();
  h.useCurrentLocation({ open: false });
  h.element("#route-from").value = "Г-1";
  h.element("#route-from").oninput();
  position = {
    source: "manual",
    campusId: "a",
    floorId: "a-floor1",
    point: [2, 3],
    timestamp: Date.now(),
  };
  h.state.userLocation = position;
  h.locationChanged();
  assert.equal(h.getEndpoints().from, null);
  assert.equal(h.element("#route-from").value, "Г-1");
  assert.equal(h.workerMessages.length, 0);
});

async function liveRouteHarness(options = {}) {
  const h = routeHarness({ onLocate() {}, ...options });
  h.state.mode = "floor";
  h.state.locationTracking = { enabled: true, status: "live", following: true };
  const points = [
    [-5, -5],
    [40, -5],
    [40, 30],
    [-5, 30],
  ];
  h.state.floorData = [
    {
      id: "a-floor1",
      campusId: "a",
      units: "meters",
      polygons: [{ id: "hall", kind: "corridor", points }],
      footprints: [{ points }],
      walls: [],
      doors: [],
    },
  ];
  h.result.distanceMeters = 28;
  h.result.segments = [
    {
      floorId: "a-floor1",
      points: [
        [0, 0],
        [12, 0],
        [12, 16],
      ],
      nodes: [{ physicalLevel: 1, building: "Г" }],
    },
  ];
  h.result.steps = [
    {
      kind: "start",
      floorId: "a-floor1",
      position: [0, 0],
      text: "Начните здесь",
    },
    {
      kind: "walk",
      floorId: "a-floor1",
      position: [0, 0],
      text: "По коридору",
    },
    {
      kind: "turn",
      floorId: "a-floor1",
      position: [12, 0],
      text: "Поверните налево",
    },
    {
      kind: "arrive",
      floorId: "a-floor1",
      position: [12, 16],
      text: "У аудитории",
    },
  ];
  const pending = h.build();
  h.reply(h.result);
  await pending;
  const base = Date.now();
  h.setNow(base);
  let tick = 0;
  h.emitGps = (point, overrides = {}) => {
    const now = base + ++tick * 1000;
    h.setNow(now);
    h.state.userLocation = {
      source: "gps",
      status: "inside",
      campusId: "a",
      point,
      timestamp: now,
      accuracyMeters: 3,
      accuracyRadiusMap: 3,
      floorEvidence: "unknown",
      trackingStatus: "live",
      ...overrides,
    };
    h.locationChanged();
  };
  h.element("#route-dock-next").dispatch("click");
  return h;
}

test("route heading is paused with map following and restored by recenter", async () => {
  let state;
  const h = await liveRouteHarness({
    onLocate() {
      if (state) state.locationTracking.following = true;
    },
  });
  state = h.state;
  assert.equal(h.isFollowingHeading(), true);
  state.locationTracking.following = false;
  assert.equal(h.isFollowingHeading(), false);
  h.element("#route-dock-recenter").dispatch("click");
  assert.equal(h.isFollowingHeading(), true);
  state.floor = { id: "off-route-floor" };
  assert.equal(h.isFollowingHeading(), false);
  h.clear();
  assert.equal(h.isFollowingHeading(), false);
});

test("Next tracking hides manual controls only for reliable GPS and surfaces a working refinement action", async () => {
  let refinements = 0;
  const h = await liveRouteHarness({
    nextInterface: true,
    onRefineLocation() {
      refinements++;
    },
  });
  h.emitGps([0, 0]);
  h.emitGps([1, 0]);
  assert.equal(h.element("#route-dock-next").hidden, true);
  assert.equal(h.element("#route-dock-recenter").hidden, true);
  assert.equal(h.element("#route-dock-context").hidden, true);
  assert.equal(h.element("#route-dock-previous").hidden, true);
  assert.match(h.element("#route-dock-distance").textContent, /м/);
  const instruction = h.element("#route-dock-instruction").textContent;
  h.emitGps([2, 0], { accuracyMeters: 40, accuracyRadiusMap: 40 });
  assert.equal(h.element("#route-dock-next").hidden, false);
  assert.equal(h.element("#route-dock-context").textContent, "Уточнить точку");
  assert.equal(h.element("#route-dock-context").hidden, false);
  assert.equal(h.element("#route-dock-distance").hidden, true);
  assert.equal(h.element("#route-dock-instruction").textContent, instruction);
  h.element("#route-dock-context").dispatch("click");
  assert.equal(refinements, 1);
  assert.ok(h.getRoute());
});

test("live GPS advances to upcoming instructions and arrival without opening the sheet or creating a demonstration", async () => {
  const h = await liveRouteHarness();
  const sheetCount = h.sheetCalls.length;
  h.emitGps([0, 0]);
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Начните здесь",
  );
  h.locationChanged();
  h.locationChanged();
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Начните здесь",
    "refreshes are not fresh evidence",
  );
  h.emitGps([1, 0]);
  assert.equal(
    h.element("#route-dock-instruction").textContent,
    "Поверните налево",
  );
  assert.match(h.element("#route-dock-note").textContent, /автоматически/);
  assert.match(h.element("#route-dock-meta").textContent, /м до шага/);
  for (const point of [
    [2, 0],
    [6, 0],
    [10, 0],
    [12, 0],
    [12, 2],
    [12, 6],
    [12, 10],
    [12, 14],
    [12, 15],
    [12, 16],
    [12, 16],
  ])
    h.emitGps(point);
  assert.match(h.element("#route-dock-instruction").textContent, /Вы пришли/);
  assert.equal(h.sheetCalls.length, sheetCount);
  assert.equal(
    h.guidanceCalls.at(-1),
    null,
    "GPS never gains an orange preview marker",
  );
  assert.equal(h.animationFrames.size, 0);
  assert.deepEqual(h.state.userLocation.point, [12, 16]);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.getRoute(), null);
});

test("live navigation holds poor or stale positions and retains actual GPS coordinates", async () => {
  const h = await liveRouteHarness();
  h.emitGps([0, 0]);
  h.emitGps([1, 0]);
  const instruction = h.element("#route-dock-instruction").textContent;
  h.emitGps([12, 16], { accuracyMeters: 40 });
  assert.equal(h.element("#route-dock-instruction").textContent, instruction);
  assert.match(
    h.element("#route-dock-note").textContent,
    /Точности GPS недостаточно/,
  );
  assert.deepEqual(h.state.userLocation.point, [12, 16]);
  h.setNow(h.state.userLocation.timestamp + 11_000);
  h.locationChanged();
  assert.match(h.element("#route-dock-note").textContent, /Нет свежего GPS/);
  assert.equal(h.element("#route-dock-instruction").textContent, instruction);
});

test("a GPS stair handoff waits for explicit floor confirmation and never switches floors from coordinates alone", async () => {
  const confirmations = [];
  const h = routeHarness({
    onLocate() {},
    onConfirmFloor: (floor) => confirmations.push(floor),
  });
  h.state.mode = "floor";
  const points = [
    [-5, -5],
    [30, -5],
    [30, 20],
    [-5, 20],
  ];
  h.state.floorData = [1, 2].map((n) => ({
    id: `a-floor${n}`,
    campusId: "a",
    polygons: [{ id: `hall${n}`, kind: "corridor", points }],
    footprints: [{ points }],
    walls: [],
    doors: [],
  }));
  h.result.distanceMeters = 22;
  h.result.segments = [
    {
      floorId: "a-floor1",
      points: [
        [0, 0],
        [12, 0],
      ],
      nodes: [{ physicalLevel: 1, building: "Г" }],
    },
    {
      floorId: "a-floor2",
      points: [
        [12, 0],
        [12, 10],
      ],
      nodes: [{ physicalLevel: 2, building: "Г" }],
    },
  ];
  h.result.transitions = [
    {
      fromFloorId: "a-floor1",
      toFloorId: "a-floor2",
      point: [12, 0],
      targetPoint: [12, 0],
      label: "Лестница",
    },
  ];
  h.result.steps = [
    { kind: "start", floorId: "a-floor1", position: [0, 0], text: "Начало" },
    {
      kind: "stairs",
      floorId: "a-floor1",
      targetFloorId: "a-floor2",
      position: [12, 0],
      text: "Поднимитесь на 2 этаж",
    },
    {
      kind: "walk",
      floorId: "a-floor2",
      position: [12, 0],
      text: "По 2 этажу",
    },
    {
      kind: "arrive",
      floorId: "a-floor2",
      position: [12, 10],
      text: "У двери",
    },
  ];
  const pending = h.build();
  h.reply(h.result);
  await pending;
  const base = Date.now();
  h.setNow(base);
  h.element("#route-dock-next").dispatch("click");
  for (const [i, x] of [0, 1, 5, 9, 11, 12, 12].entries()) {
    const now = base + i * 1000;
    h.setNow(now);
    h.state.userLocation = {
      source: "gps",
      status: "inside",
      campusId: "a",
      point: [x, 0],
      timestamp: now,
      accuracyMeters: 3,
      trackingStatus: "live",
    };
    h.locationChanged();
  }
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(confirmations.length, 0);
  assert.match(h.element("#route-dock-next").innerHTML, /Я на следующем этаже/);
  h.element("#route-dock-next").dispatch("click");
  assert.equal(h.state.floor.id, "a-floor2");
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].floorId, "a-floor2");
  assert.equal(confirmations[0].physicalLevel, 2);
});

test("live guidance does not refit the route after manual pan or a dock resize, and waits for new GPS after resume", async () => {
  const h = await liveRouteHarness();
  h.emitGps([0, 0]);
  h.emitGps([1, 0]);
  h.state.locationTracking.following = false;
  const calls = h.guidanceCalls.length;
  h.resize();
  assert.equal(
    h.guidanceCalls.length,
    calls,
    "automatic route framing cannot override manual map view",
  );
  const pause = new Event("atlas:app-state");
  Object.defineProperty(pause, "detail", { value: { isActive: false } });
  h.window.dispatchEvent(pause);
  assert.match(h.element("#route-dock-note").textContent, /Нет свежего GPS/);
  const resume = new Event("atlas:app-state");
  Object.defineProperty(resume, "detail", { value: { isActive: true } });
  h.window.dispatchEvent(resume);
  assert.match(h.element("#route-dock-note").textContent, /Нет свежего GPS/);
  h.emitGps([2, 0]);
  assert.match(h.element("#route-dock-note").textContent, /автоматически/);
});

test("an unavailable destination keeps the honest graph explanation visible instead of leaving an empty minimized route", async () => {
  const h = routeHarness();
  const pending = h.build();
  h.reply({
    ok: false,
    code: "no-path",
    message: "У Г-424-1 не задан подтверждённый вход в графе проходов.",
  });
  await pending;
  assert.equal(h.getRoute(), null);
  assert.match(h.element("#route-status").textContent, /Г-424-1.*вход/);
  assert.equal(h.sheetCalls.at(-1), "expanded");
  assert.equal(h.element("#route-guidance-dock").hidden, true);
});

test("both interface profiles use balanced quality and migrate legacy auto only once", () => {
  for (const nextInterface of [false, true]) {
    const variant = nextInterface ? "next" : "classic";
    const settingsKey = variantStorageKey("atlas:settings", variant);
    const versionKey = variantStorageKey(
      "atlas:quality-default-version",
      variant,
    );
    const options = { nextInterface };
    const fresh = experienceHarness({}, undefined, options);
    assert.deepEqual(fresh.qualityCalls, ["balanced"]);
    assert.equal(fresh.element("#quality-setting").value, "balanced");
    assert.equal(fresh.store.get(versionKey), "1");

    const preferences = {
      quality: "auto",
      theme: "dark",
      frameRate: "30",
      motion: true,
      headingFollow: false,
    };
    const migrated = experienceHarness(
      { [settingsKey]: JSON.stringify(preferences) },
      undefined,
      options,
    );
    assert.deepEqual(migrated.qualityCalls, ["balanced"]);
    assert.deepEqual(JSON.parse(migrated.store.get(settingsKey)), {
      ...preferences,
      quality: "balanced",
    });
    assert.equal(migrated.store.get(versionKey), "1");

    migrated
      .element("#quality-setting")
      .onchange({ target: { value: "auto" } });
    const restarted = experienceHarness(
      Object.fromEntries(migrated.store),
      undefined,
      options,
    );
    assert.deepEqual(
      restarted.qualityCalls,
      ["auto"],
      "explicit auto after migration survives restart",
    );
    assert.equal(restarted.element("#quality-setting").value, "auto");

    for (const quality of ["low", "balanced", "high"]) {
      const existing = experienceHarness(
        { [settingsKey]: JSON.stringify({ ...preferences, quality }) },
        undefined,
        options,
      );
      assert.deepEqual(existing.qualityCalls, [quality]);
      assert.deepEqual(JSON.parse(existing.store.get(settingsKey)), {
        ...preferences,
        quality,
      });
    }
  }
});

test("quality migration does not change the other interface profile", () => {
  const classic = "atlas:settings",
    next = "atlas:next:atlas:settings";
  const h = experienceHarness({
    [classic]: '{"quality":"auto"}',
    [next]: '{"quality":"auto"}',
  });
  assert.equal(JSON.parse(h.store.get(classic)).quality, "balanced");
  assert.equal(JSON.parse(h.store.get(next)).quality, "auto");
  assert.equal(h.store.has("atlas:next:atlas:quality-default-version"), false);
  const newUI = experienceHarness(Object.fromEntries(h.store), undefined, {
    nextInterface: true,
  });
  assert.equal(JSON.parse(newUI.store.get(next)).quality, "balanced");
  assert.equal(
    newUI.store.get("atlas:next:atlas:quality-default-version"),
    "1",
  );
});

test("both route interfaces keep individual floors and transitions without an all-floor control", async () => {
  for (const nextInterface of [false, true]) {
    const h = routeHarness({ nextInterface });
    const chips = ["a-floor1", "a-floor2"].map((floor) => ({
      dataset: { routeFloor: floor },
    }));
    h.element("#route-floor-chips").children = chips;
    h.result.segments = [1, 2].map((level) => ({
      floorId: `a-floor${level}`,
      points: [
        [0, 0],
        [10, 0],
      ],
      nodes: [{ physicalLevel: level }],
    }));
    h.result.steps = [
      {
        kind: "stairs",
        floorId: "a-floor1",
        position: [10, 0],
        targetFloorId: "a-floor2",
        text: "Поднимитесь на 2 этаж",
      },
      {
        kind: "arrive",
        floorId: "a-floor2",
        position: [10, 0],
        text: "Вы у аудитории",
      },
    ];
    const pending = h.build();
    h.reply(h.result);
    await pending;
    const content = h.element("#route-floor-chips").innerHTML;
    assert.doesNotMatch(content, /route-all-floors|Все этажи/);
    assert.match(content, /data-route-floor="a-floor1"/);
    assert.match(content, /data-route-floor="a-floor2"/);
    chips[1].onclick();
    assert.equal(h.state.floor.id, "a-floor2");
    chips[0].onclick();
    assert.equal(h.state.floor.id, "a-floor1");
    h.startGuidance();
    h.element("#route-dock-next").dispatch("click");
    assert.equal(
      h.state.floor.id,
      "a-floor2",
      "the explicit staircase transition remains available",
    );
    assert.ok(h.overviewCalls.length > 0);
    assert.ok(
      h.overviewCalls.every((value) => value === false),
      "no route action enables a stacked view",
    );
  }
});

test("search and route inputs keep suggestions within the visual viewport in both mobile orientations and variants", () => {
  for (const nextInterface of [false, true]) {
    for (const [width, height, keyboardHeight] of [
      [390, 844, 344],
      [844, 390, 190],
    ]) {
      for (const selector of ["#search", "#route-from", "#route-to"]) {
        const viewport = Object.assign(new EventTarget(), {
          scale: 1,
          height,
          offsetTop: 0,
        });
        const h = experienceHarness(undefined, viewport, {
          nextInterface,
          width,
          height,
        });
        const sidebar = h.element(".sidebar");
        const content = h.element(".sidebar-scroll");
        content.scrollTop = 240;
        h.minimize();
        h.element(selector).dispatch("focus");
        assert.equal(h.getSheetState(), "expanded");
        assert.equal(
          content.scrollTop,
          0,
          "sheet-local scroll reveals field and list",
        );
        assert.equal(sidebar.dataset.inputEditing, "true");
        viewport.height = height - keyboardHeight;
        viewport.offsetTop = 12;
        viewport.dispatchEvent(new Event("resize"));
        assert.equal(sidebar.style.values.get("--sheet-viewport-top"), "12px");
        assert.equal(
          sidebar.style.values.get("--sheet-viewport-bottom"),
          `${keyboardHeight - 12}px`,
        );
        assert.equal(
          sidebar.style.values.get("--sheet-viewport-height"),
          `${height - keyboardHeight}px`,
        );
        assert.equal(sidebar.dataset.keyboardOpen, "true");
        viewport.scale = 1.5;
        viewport.dispatchEvent(new Event("resize"));
        assert.equal(
          sidebar.dataset.keyboardOpen,
          "false",
          "pinch zoom is not a keyboard",
        );
        assert.equal(
          sidebar.style.values.has("--sheet-viewport-bottom"),
          false,
        );
        viewport.scale = 1;
        viewport.height = height;
        viewport.offsetTop = 0;
        h.element(selector).dispatch("blur");
        viewport.dispatchEvent(new Event("resize"));
        assert.equal(sidebar.dataset.inputEditing, "false");
        assert.equal(sidebar.dataset.keyboardOpen, "false");
        assert.equal(
          sidebar.style.values.get("--sheet-viewport-bottom"),
          "0px",
        );
        h.minimize();
        assert.equal(
          sidebar.style.values.has("--sheet-viewport-height"),
          false,
        );
      }
    }
  }
});

test("native layout resize reserves the remaining input area without double-counting the keyboard", () => {
  const h = experienceHarness(undefined, undefined);
  const sidebar = h.element(".sidebar");
  h.element("#search").dispatch("focus");
  h.setViewport(390, 440);
  assert.equal(h.getSheetState(), "expanded");
  assert.equal(sidebar.dataset.keyboardOpen, "true");
  assert.equal(sidebar.style.values.get("--sheet-viewport-bottom"), "0px");
  assert.equal(sidebar.style.values.get("--sheet-viewport-height"), "440px");
  h.element("#search").dispatch("blur");
  h.setViewport(844, 390);
  h.element("#route-to").dispatch("focus");
  assert.equal(sidebar.dataset.inputEditing, "true");
  assert.equal(
    sidebar.dataset.keyboardOpen,
    "false",
    "rotation alone is not a keyboard",
  );
  h.setViewport(844, 180);
  assert.equal(sidebar.dataset.keyboardOpen, "true");
  assert.equal(sidebar.style.values.get("--sheet-viewport-height"), "180px");
});

test("keyboard suggestion navigation retains only its active field until leaving or choosing a result", () => {
  for (const nextInterface of [false, true]) {
    for (const field of ["search", "route-from", "route-to"]) {
      const h = experienceHarness(undefined, undefined, {
        nextInterface,
        width: 844,
        height: 390,
      });
      const input = h.element(`#${field}`);
      const list = h.element(
        field === "search" ? "#results" : "#route-results",
      );
      const firstResult = {};
      list.contains = (node) => node === firstResult;
      input.dispatch("focus");
      input.dispatch("blur", { relatedTarget: firstResult });
      const sidebar = h.element(".sidebar");
      assert.equal(sidebar.dataset.inputEditing, "true");
      assert.equal(sidebar.dataset.editingField, field);
      list.dispatch("focusout", { relatedTarget: {} });
      assert.equal(sidebar.dataset.inputEditing, "false");
      assert.equal(sidebar.dataset.editingField, "");
      input.dispatch("focus");
      input.dispatch("blur", { relatedTarget: firstResult });
      h.expand(false);
      assert.equal(
        sidebar.dataset.inputEditing,
        "false",
        "choosing a removed result cannot leave an editing layout behind",
      );
      assert.equal(sidebar.dataset.editingField, "");
    }
  }
});

test("a very short Safari keyboard viewport keeps its active field through rotation and clears compact editing on blur", () => {
  for (const nextInterface of [false, true]) {
    const viewport = Object.assign(new EventTarget(), {
      scale: 1,
      height: 844,
      offsetTop: 0,
    });
    const h = experienceHarness(undefined, viewport, { nextInterface });
    const sidebar = h.element(".sidebar");
    h.element("#route-to").dispatch("focus");
    viewport.height = 52;
    h.setViewport(844, 390);
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(h.getSheetState(), "expanded");
    assert.equal(sidebar.dataset.editingField, "route-to");
    assert.equal(sidebar.dataset.shortViewport, "true");
    assert.equal(sidebar.dataset.keyboardOpen, "true");
    assert.equal(sidebar.style.values.get("--sheet-viewport-height"), "52px");
    viewport.scale = 1.5;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(
      sidebar.dataset.shortViewport,
      "false",
      "pinch zoom must not activate the tiny-keyboard layout",
    );
    viewport.scale = 1;
    viewport.height = 180;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(sidebar.dataset.shortViewport, "false");
    viewport.height = 52;
    viewport.dispatchEvent(new Event("resize"));
    assert.equal(sidebar.dataset.shortViewport, "true");
    h.element("#route-to").dispatch("blur");
    assert.equal(sidebar.dataset.shortViewport, "false");
    assert.equal(sidebar.dataset.inputEditing, "false");
  }
});

test("Safari null-target blur cannot move a touched suggestion before its click in either interface", () => {
  for (const nextInterface of [false, true]) {
    for (const field of ["search", "route-from", "route-to"]) {
      const viewport = Object.assign(new EventTarget(), {
        scale: 1,
        height: 52,
        offsetTop: 0,
      });
      const h = experienceHarness(undefined, viewport, {
        nextInterface,
        width: 844,
        height: 390,
      });
      const sidebar = h.element(".sidebar");
      const input = h.element(`#${field}`);
      const list = h.element(
        field === "search" ? "#results" : "#route-results",
      );
      input.dispatch("focus");
      let prevented = false;
      list.scrollTop = 75;
      list.dispatch("pointerdown", {
        pointerId: 7,
        preventDefault() {
          prevented = true;
        },
      });
      input.dispatch("blur", { relatedTarget: null });
      viewport.height = 390;
      viewport.dispatchEvent(new Event("resize"));
      assert.equal(sidebar.dataset.inputEditing, "true");
      assert.equal(sidebar.dataset.shortViewport, "true");
      assert.equal(
        sidebar.style.values.get("--sheet-viewport-height"),
        "52px",
        "keyboard dismissal must not move the tapped row",
      );
      assert.equal(list.scrollTop, 75);
      assert.equal(
        prevented,
        false,
        "native vertical scrolling is never prevented",
      );
      h.window.dispatchEvent(
        Object.assign(new Event("pointerup"), { pointerId: 7 }),
      );
      assert.equal(
        sidebar.dataset.editingField,
        field,
        "pointerup precedes the native click",
      );
      let clicked = false;
      list.onclick = () => {
        clicked = true;
        h.expand(false);
      };
      list.dispatch("click");
      h.flushTimers();
      assert.equal(clicked, true);
      assert.equal(sidebar.dataset.inputEditing, "false");
      assert.equal(sidebar.dataset.shortViewport, "false");
    }
  }
});

test("suggestion pointer cleanup preserves route handoff and canceled native scrolling", () => {
  const h = experienceHarness(undefined, undefined, {
    width: 844,
    height: 390,
  });
  const from = h.element("#route-from"),
    to = h.element("#route-to");
  const list = h.element("#route-results"),
    sidebar = h.element(".sidebar");
  from.dispatch("focus");
  list.dispatch("pointerdown", { pointerId: 1 });
  from.dispatch("blur", { relatedTarget: null });
  h.window.dispatchEvent(
    Object.assign(new Event("pointerup"), { pointerId: 1 }),
  );
  to.dispatch("focus");
  h.document.activeElement = to;
  h.flushTimers();
  assert.equal(
    sidebar.dataset.editingField,
    "route-to",
    "late cleanup cannot clear the next endpoint field",
  );
  list.scrollTop = 140;
  list.dispatch("pointerdown", { pointerId: 2 });
  h.window.dispatchEvent(
    Object.assign(new Event("pointercancel"), { pointerId: 2 }),
  );
  h.flushTimers();
  assert.equal(
    sidebar.dataset.editingField,
    "route-to",
    "scroll cancellation leaves the focused input active",
  );
  assert.equal(list.scrollTop, 140);
  list.dispatch("pointerdown", { pointerId: 3 });
  to.dispatch("blur", { relatedTarget: null });
  h.document.activeElement = null;
  h.window.dispatchEvent(
    Object.assign(new Event("pointercancel"), { pointerId: 3 }),
  );
  h.flushTimers();
  assert.equal(
    sidebar.dataset.inputEditing,
    "false",
    "an abandoned touch must not leave frozen editing state",
  );
});

test("suggestion compatibility mousedown preserves input focus but leaves touch scrolling and other mouse buttons alone", () => {
  for (const nextInterface of [false, true]) {
    const h = experienceHarness(undefined, undefined, { nextInterface });
    for (const selector of ["#results", "#route-results"]) {
      const list = h.element(selector);
      const button = {};
      list.contains = (node) => node === button;
      const target = { closest: (tag) => (tag === "button" ? button : null) };
      let prevented = 0;
      const preventDefault = () => prevented++;
      list.dispatch("mousedown", { button: 0, target, preventDefault });
      assert.equal(
        prevented,
        1,
        "primary completed tap keeps the text input focused until click",
      );
      list.dispatch("mousedown", { button: 2, target, preventDefault });
      list.dispatch("mousedown", {
        button: 0,
        target: { closest: () => null },
        preventDefault,
      });
      list.dispatch("pointerdown", {
        button: 0,
        pointerId: 1,
        target,
        preventDefault,
      });
      list.dispatch("touchstart", { target, preventDefault });
      assert.equal(
        prevented,
        1,
        "right click, empty space and scroll initiation remain native",
      );
      let clicked = false;
      list.onclick = () => {
        clicked = true;
      };
      list.dispatch("click", { target });
      assert.equal(clicked, true);
    }
  }
});
