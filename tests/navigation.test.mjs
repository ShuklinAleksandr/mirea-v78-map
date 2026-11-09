import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolveInitialView } from "../src/data/navigation.js";
import { mergedFloorView } from "../src/data/floor-view.js";
import { geometryEvidence, resolveRoom } from "../src/data/utils.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import { entranceHint } from "../src/data/entrance-hints.js";
import {
  isCompactLandscape,
  measuredPortraitPadding,
  measuredLandscapePadding,
} from "../src/ui/map-viewport.js";
import { isNextInterface } from "../src/ui/variant.js";
import {
  resolveFloorContext,
  resolveRouteFloorContext,
} from "../src/data/floor-context.js";
import {
  placeDescription,
  placeLocation,
  presentPlaceIdentity,
} from "../src/data/place-location.js";
import {
  getMapStairMarkers,
  presentStairIdentity,
  resolveStairTarget,
  withConfirmedStairSearch,
} from "../src/map/stairs.js";

const manifest = JSON.parse(
  readFileSync(new URL("../public/data/manifest.json", import.meta.url)),
);

test("shared links restore a valid physical building floor and projection", () => {
  assert.deepEqual(
    resolveInitialView(
      "campus=v-78&building=Г&floor=v-78-floor1&view=floor&projection=2d",
      manifest,
    ),
    {
      campusId: "v-78",
      building: "Г",
      floorId: "v-78-floor1",
      mode: "floor",
      projection: "2d",
    },
  );
});

test("unknown buildings and floors from another campus restore a usable overview", () => {
  for (const hash of [
    "campus=v-78&building=missing&floor=v-78-floor1&view=floor",
    "campus=v-78&floor=s-20-floor1&view=floor",
    "campus=missing&floor=s-20-floor1&view=floor",
  ]) {
    const view = resolveInitialView(hash, manifest);
    assert.equal(view.campusId, "v-78");
    assert.equal(view.mode, "overview");
    assert.equal(view.floorId, null);
    assert.equal(view.building, null);
  }
});

test("a valid source level cannot be restored for a building absent on that level", () => {
  const view = resolveInitialView(
    "campus=v-78&building=Г&floor=v-78-floor4&view=floor",
    manifest,
  );
  assert.equal(view.building, "Г");
  assert.equal(view.mode, "overview");
  assert.equal(view.floorId, null);
  assert.equal(
    resolveInitialView("campus=v-78&floor=v-78-floor1&view=overview", manifest)
      .mode,
    "overview",
  );
});

// Run the actual controller functions with deferred network responses. DOM and
// WebGL are boundaries here; the asynchronous state transitions are production code.
const appSource = readFileSync(
  new URL("../src/app.js", import.meta.url),
  "utf8",
);
function section(start, end) {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Controller section ${start} exists`);
  return appSource.slice(from, to);
}
const controller = [
  section("function floorPhysical(", "function renderFloors("),
  section("function cancelPendingNavigation(", "function saveView("),
  section("function roomPadding(", "const kindNames"),
  section("function stairTargetsFor(", '$("#campus-overview").onclick'),
].join("\n");

function harness({
  stairMarkers = [],
  actualUI = false,
  landmarks = {},
  nextInterface = false,
  withExperience = false,
  width = 390,
  height = 844,
} = {}) {
  const campuses = ["a", "b", "c"].map((id) => ({
    id,
    title: id,
    address: id,
    floors: [
      {
        id: `${id}-floor1`,
        level: 1,
        url: `/${id}.json`,
        buildingLevels: { [id]: 1 },
      },
    ],
  }));
  const roomFor = (id) => ({
    id: `${id}-room`,
    label: `${id}-101`,
    campusId: id,
    floorId: `${id}-floor1`,
    building: id,
    kind: "room",
    center: [0, 0],
  });
  const floorFor = (id) => ({
    ...campuses.find((c) => c.id === id).floors[0],
    polygons: [roomFor(id)],
  });
  const state = {
    campus: campuses[0],
    manifest: { campuses },
    floorData: [floorFor("a")],
    floor: null,
    mode: "overview",
    building: null,
    selected: null,
    loading: 0,
  };
  const elements = new Map();
  const createdElements = [];
  const $ = (selector) => {
    if (!elements.has(selector))
      elements.set(selector, {
        hidden: false,
        value: "",
        innerHTML: "",
        children: [],
        dataset: {},
        classList: { toggle() {}, remove() {} },
        setAttribute() {},
        closest() {
          return this;
        },
        remove() {},
        append() {},
        after() {},
        before() {},
        querySelector: (child) => $(`${selector} ${child}`),
        querySelectorAll(child) {
          if (selector !== "#room-card" || child !== "[data-target]") return [];
          targetButtons = [
            ...this.innerHTML.matchAll(/data-target="(\d+)"/g),
          ].map((match) => ({ dataset: { target: match[1] } }));
          return targetButtons;
        },
        getBoundingClientRect() {
          if (selector === ".sidebar")
            return {
              left: 0,
              right: width,
              width,
              top: height - 220,
              bottom: height,
              height: 220,
            };
          if (
            [".map-top", "#campus-overview", "#settings-open"].includes(
              selector,
            )
          )
            return {
              left: 16,
              right: width - 16,
              width: width - 32,
              top: 16,
              bottom: 64,
              height: 48,
            };
          if ([".map-tools", "#next-floor-open"].includes(selector))
            return {
              left: width - 52,
              right: width - 8,
              width: 44,
              top: 80,
              bottom: 124,
              height: 44,
            };
          return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
        },
      });
    return elements.get(selector);
  };
  $("#campus").value = "a";
  const requests = new Map(),
    errors = [],
    calls = [];
  const timers = new Map();
  let timerId = 0;
  let targetButtons = [];
  const rectangles = (selectors) =>
    Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => {
        const element = $(selector);
        return [name, element.hidden ? null : element.getBoundingClientRect()];
      }),
    );
  const context = vm.createContext({
    state,
    $,
    resolveRoom,
    placeDescription,
    placeLocation,
    presentPlaceIdentity,
    getHallAdjacencyView,
    mergedFloorView,
    entranceHint,
    isNextInterface,
    resolveFloorContext,
    resolveRouteFloorContext,
    floorContextOwner: "camera",
    floorContextTimer: null,
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    placeLandmarks: { hints: landmarks },
    presentStairIdentity,
    getJSON(url) {
      return new Promise((resolve, reject) =>
        requests.set(url, { resolve, reject }),
      );
    },
    scene: {
      locationPicking: false,
      setLocationPicking(value) {
        this.locationPicking = value;
      },
      setCampus: (c) => calls.push(["campus", c.id]),
      setOverview: (b) => calls.push(["overview", b]),
      setFloor(f, building, options) {
        calls.push(["floor", f.id]);
        this.lastFloorView = {
          floor: f,
          building,
          options,
          neighborsOn: this.neighborsOn,
        };
        this.locationPicking = false;
      },
      keepFloorViewport() {
        calls.push(["keep-floor-viewport"]);
      },
      selectRoom: (r) => calls.push(["room", r?.id]),
    },
    busy: (value) => {
      $("#loading").hidden = !value;
    },
    closeRoom: () => {
      state.selected = null;
    },
    dismissRoom: () => {
      state.selected = null;
    },
    showError: (message) => errors.push(message),
    updateUI() {},
    saveView() {},
    openSources() {},
    geometryEvidence,
    withConfirmedStairSearch,
    getFloorMarkers: () => [],
    getMapStairMarkers: () => stairMarkers,
    resolveStairTarget,
    kindNames: { room: "Помещение" },
    innerWidth: width,
    innerHeight: height,
    isCompactLandscape,
    portraitMapPadding: () =>
      measuredPortraitPadding(
        width,
        height,
        rectangles({
          top: ".map-top",
          back: "#campus-overview",
          settings: "#settings-open",
          floorPicker: "#next-floor-open",
          tools: ".map-tools",
          sidebar: ".sidebar",
          dock: "#route-guidance-dock",
          location: "#location-pick-banner",
        }),
      ),
    landscapeMapPadding: () =>
      measuredLandscapePadding(
        width,
        height,
        rectangles({
          top: ".map-top",
          status: ".focus-floor-status",
          floorPicker: "#next-floor-open",
          tools: ".map-tools",
          floors: "#floor-rail",
          sidebar: ".sidebar",
          dock: "#route-guidance-dock",
          location: "#location-pick-banner",
        }),
      ),
    escape: String,
    icon: () => "",
    document: {
      createElement(tagName) {
        const element = {
          tagName,
          children: [],
          after() {},
          before(child) {
            this.beforeElement = child;
          },
          append(child) {
            this.children.push(child);
          },
        };
        createdElements.push(element);
        return element;
      },
      querySelectorAll: () => [],
    },
    matchMedia: () => ({ matches: true }),
    renderFloors() {},
    routes: { syncView() {}, changedCampus() {}, getRoute: () => null },
    readSaved: (_key, fallback) => fallback,
    experience: withExperience
      ? {
          remember() {},
          expand() {},
          favorite() {},
          minimize() {
            calls.push(["minimize"]);
          },
        }
      : undefined,
    userPosition: {
      cancelPicking() {
        context.scene.locationPicking = false;
      },
    },
  });
  vm.runInContext(controller, context);
  vm.runInContext(
    `var routeCallbacks = {${section("    onFloorContext:", "    onConfirmFloor:")}};`,
    context,
  );
  vm.runInContext(
    section('$("#campus-overview").onclick', '$("#next-floor-open").onclick'),
    context,
  );
  vm.runInContext(
    section("function openInterior(", "new ResizeObserver("),
    context,
  );
  if (actualUI)
    vm.runInContext(
      section("function renderFloors(", "function cancelPendingNavigation(") +
        section("function closeRoom(", "function roomPadding("),
      context,
    );
  return {
    state,
    $,
    errors,
    calls,
    createdElements,
    scene: context.scene,
    roomFor,
    load: (id) => context.loadCampus(id),
    navigate: (id) => context.navigateRoom(roomFor(id)),
    navigatePlace: (room) => context.navigateRoom(room),
    dismiss: () => context.dismissRoom(),
    choose: (id) => context.chooseFloor(`${id}-floor1`),
    chooseBuilding: (building) => context.chooseBuilding(building),
    overview: () => context.overview(),
    updateUI: () => context.updateUI(),
    floorContextBuilding: () => context.floorContextBuilding(),
    applyFloorContext: (value, source) =>
      context.applyFloorContext(value, source),
    locationContext: () => context.refreshLocationFloorContext(),
    routeContext: (sample, nodes) =>
      context.routeCallbacks.onFloorContext(sample, nodes),
    queueCameraContext(point, { owner = "camera" } = {}) {
      context.floorContextOwner = owner;
      context.scene.floorFocusPoint = () => point;
      context.queueCameraFloorContext();
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    select: (r) => context.selectRoom(r),
    clickStairTarget(index = 0) {
      assert.ok(
        targetButtons[index]?.onclick,
        "the actual stair button has a handler",
      );
      return targetButtons[index].onclick();
    },
    resolve: (id) => requests.get(`/${id}.json`).resolve(floorFor(id)),
    reject: (id) =>
      requests.get(`/${id}.json`).reject(new Error(`Failed ${id}`)),
  };
}

test("selecting the A-146 stair refreshes a stale G route floor label using its own building", () => {
  const h = harness({ actualUI: true });
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  h.state.campus = campus;
  h.state.floor = {
    ...campus.floors.find((item) => item.id === "v-78-floor1"),
    polygons: [],
  };
  h.state.mode = "floor";
  h.state.building = "Г";
  h.$("#focus-floor-status").innerHTML = "2 этаж · корпус Г";
  h.select({
    id: "v-78--floor-1--68n",
    label: "А-146",
    kind: "room",
    building: "А",
    campusId: "v-78",
    floorId: "v-78-floor1",
    center: [147.2835, 8.0119],
  });
  assert.equal(h.state.selected.kind, "stairs");
  assert.match(h.$("#focus-floor-status").innerHTML, /1 этаж · корпус А/);
  assert.doesNotMatch(h.$("#focus-floor-status").innerHTML, /корпус Г|2 этаж/);
});

test("manual position picking survives changing floor and stops when leaving the interior", () => {
  const h = harness();
  h.scene.locationPicking = true;
  h.state.floorData.push({
    ...h.state.floorData[0],
    id: "upper-floor1",
    level: 2,
  });
  h.choose("upper");
  assert.equal(h.state.floor.id, "upper-floor1");
  assert.equal(
    h.scene.locationPicking,
    true,
    "the next tap still places the point on the newly selected floor",
  );
  h.overview();
  assert.equal(
    h.scene.locationPicking,
    false,
    "an exterior view cannot accept an indoor survey point",
  );
});

test("a numbered facility keeps its own wing and floor after its card is closed", async () => {
  const h = harness({ actualUI: true });
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  const medical = {
    id: "medical",
    label: "Медпункт А-109",
    kind: "medical",
    campusId: "v-78",
    floorId: "v-78-floor1",
    building: null,
    center: [0, 0],
  };
  h.state.campus = campus;
  h.state.floorData = [
    {
      ...campus.floors.find((item) => item.id === medical.floorId),
      polygons: [medical],
    },
  ];
  h.state.building = "Г";
  assert.equal(await h.navigatePlace(medical), true);
  assert.equal(h.state.building, "А");
  assert.match(h.$("#focus-floor-status").innerHTML, /1 этаж · корпус А/);
  h.dismiss();
  assert.equal(h.state.selected, null);
  assert.equal(h.state.building, "А");
  assert.match(h.$("#focus-floor-status").innerHTML, /1 этаж · корпус А/);
});

test("selecting a facility never promotes its landmark's building into the map floor label", () => {
  const generated = JSON.parse(
    readFileSync(new URL("../src/data/place-landmarks.json", import.meta.url)),
  );
  const h = harness({ actualUI: true, landmarks: generated.hints });
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  h.state.campus = campus;
  h.state.floor = {
    ...campus.floors.find((item) => item.id === "v-78-floor2"),
    polygons: [],
  };
  h.state.mode = "floor";
  h.state.building = null;
  h.$("#focus-floor-status").innerHTML = "3 этаж · корпус Б";
  h.select({
    id: "v-78--floor-2--a0j",
    label: "Столовая",
    kind: "cafeteria",
    building: null,
    campusId: "v-78",
    floorId: "v-78-floor2",
    center: [182.2636, 10.0064],
  });
  assert.match(h.$("#room-card").innerHTML, /Ориентир: Б-312/);
  assert.match(h.$("#focus-floor-status").innerHTML, /Уровень плана 2/);
  assert.doesNotMatch(h.$("#focus-floor-status").innerHTML, /корпус Б|3 этаж/);
});

test("a confirmed basement descent explains the missing plan and offers the overlapping upward stair", () => {
  const upward = {
    id: "stairs-up",
    layoutId: "layout-up",
    kind: "stairs",
    label: "На второй этаж",
    center: [48, -18],
  };
  const basement = {
    id: "stairs-down",
    layoutId: "layout-down",
    kind: "stairs",
    label: "Спуск в цоколь",
    center: [48, -18],
    existenceStatus: "user-confirmed-existence",
    routingStatus: "display-only-no-source-transition",
    note: "Спуск в цоколь подтверждён. План цоколя и маршрут по нему уточняются.",
    targets: [],
  };
  const h = harness({ stairMarkers: [upward, basement] });
  h.choose("a");
  h.select(basement);
  const card = h.$("#room-card").innerHTML;
  assert.match(card, /Спуск подтверждён командой · форма приблизительная/);
  assert.match(card, /План цоколя и маршрут по нему уточняются/);
  assert.match(card, /data-stair-variant="0">На второй этаж/);
  assert.doesNotMatch(
    card,
    /data-target=|Переход на другой этаж пока не указан/,
  );
});

function realStairView(level) {
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  const floors = campus.floors.map((meta) =>
    JSON.parse(
      readFileSync(new URL(`../public${meta.url}`, import.meta.url), "utf8"),
    ),
  );
  const h = harness({ actualUI: true });
  h.state.campus = campus;
  h.state.floorData = floors;
  h.state.floor = floors.find((floor) => floor.level === level);
  h.state.mode = "floor";
  h.state.building = "А";
  return h;
}

test("the library descent button uses the destination's source level instead of borrowing A1 from the selected wing", () => {
  const h = realStairView(2);
  const source = getMapStairMarkers(h.state.floor).find((marker) =>
    marker.sourceIds.includes("v-78:edge:20734"),
  );
  const original = JSON.stringify(h.state.floorData);
  h.select(source);
  const card = h.$("#room-card").innerHTML;
  assert.match(card, /Спуск к библиотеке · корпус И/);
  assert.match(card, /data-target="0">↕ Уровень 1 плана/);
  assert.doesNotMatch(card, /↕ 1 этаж|↕.*корпуса [АИ]/);
  h.clickStairTarget();
  assert.equal(h.state.floor.id, "v-78-floor1");
  assert.equal(h.state.building, null);
  assert.equal(h.state.selected.floorId, "v-78-floor1");
  assert.ok(h.state.selected.sourceIds.includes("v-78:edge:20734"));
  assert.match(h.$("#room-card").innerHTML, /Корпус и этаж уточняются/);
  assert.match(h.$("#focus-floor-status").innerHTML, /Уровень плана 1/);
  assert.doesNotMatch(
    h.$("#focus-floor-status").innerHTML,
    /корпус [АИ]|1 этаж/,
  );
  assert.equal(JSON.stringify(h.state.floorData), original);

  // The reverse target is the user-confirmed upper point on physical floor 2,
  // while its building remains unknown. It must not become I2 or A2.
  assert.match(h.$("#room-card").innerHTML, /↕ 2 этаж · корпус уточняется/);
});

test("the accepted main stair keeps its confirmed A3 destination and paired marker after clicking its button", () => {
  const h = realStairView(2);
  const source = getMapStairMarkers(h.state.floor).find(
    (marker) => marker.layoutId === "v-78-floor2-photo-stair-wide-hall",
  );
  const original = JSON.stringify(h.state.floorData);
  h.select(source);
  assert.match(h.$("#room-card").innerHTML, /↕ 3 этаж корпуса А/);
  assert.equal(
    [...h.$("#room-card").innerHTML.matchAll(/data-target=/g)].length,
    1,
    "paired flights lead to one destination button",
  );
  h.clickStairTarget();
  assert.equal(h.state.floor.id, "v-78-floor3");
  assert.equal(h.state.building, "А");
  assert.equal(h.state.selected.layoutId, "v-78-floor3-photo-stair-wide-hall");
  assert.equal(h.state.selected.floorId, "v-78-floor3");
  assert.match(h.$("#focus-floor-status").innerHTML, /3 этаж · корпус А/);
  assert.equal(JSON.stringify(h.state.floorData), original);
});

test("the confirmed lower stair card distinguishes the user's schematic from measured fire-plan flights", () => {
  const h = realStairView(1);
  const review = getMapStairMarkers(h.state.floor).find(
    (marker) => marker.layoutId === "v-78-floor1-user-stair-basement",
  );
  h.select(review);
  const card = h.$("#room-card").innerHTML;
  assert.match(card, /Схема по вашему описанию · размеры ≈/);
  assert.match(card, /две зеркальные ветви/);
  assert.match(card, /Номер этажа ИВЦ не установлен/);
  assert.doesNotMatch(
    card,
    /Марши по пожарному плану|Схема лестницы уточняется · условная отметка/,
  );
});

test("a delayed search navigation cannot overwrite a newer campus selection", async () => {
  const h = harness();
  const oldSearch = h.navigate("b");
  const latestCampus = h.load("c");
  h.resolve("c");
  assert.equal(await latestCampus, true);
  h.resolve("b");
  assert.equal(await oldSearch, false);
  assert.equal(h.state.campus.id, "c");
  assert.equal(h.state.floor, null);
  assert.equal(h.state.building, null);
  assert.equal(h.state.mode, "overview");
  assert.deepEqual(h.errors, []);
  assert.equal(
    h.calls.some(([kind]) => kind === "room"),
    false,
  );
});

test("a stale failed campus request cannot obscure the current campus", async () => {
  const h = harness();
  const stale = h.load("b");
  const latest = h.load("c");
  h.resolve("c");
  await latest;
  h.reject("b");
  assert.equal(await stale, false);
  assert.equal(h.state.campus.id, "c");
  assert.deepEqual(h.errors, []);
});

test("a failed current search navigation stops before selecting a room", async () => {
  const h = harness();
  const result = h.navigate("b");
  h.reject("b");
  assert.equal(await result, false);
  assert.equal(h.state.campus.id, "a");
  assert.equal(h.state.floor, null);
  assert.deepEqual(h.errors, ["Failed b"]);
});

test("overview and local floor actions cancel an unfinished campus change", async () => {
  for (const action of ["overview", "choose"]) {
    const h = harness();
    const pending = h.load("b");
    h.$("#campus").value = "b";
    h[action]("a");
    h.resolve("b");
    assert.equal(await pending, false);
    assert.equal(h.state.campus.id, "a");
    assert.equal(h.state.mode, action === "choose" ? "floor" : "overview");
    assert.equal(h.$("#loading").hidden, true);
  }
});

test("local search wins over an in-flight campus change", async () => {
  const h = harness();
  const pending = h.load("b");
  h.$("#campus").value = "b";
  assert.equal(await h.navigate("a"), true);
  h.resolve("b");
  assert.equal(await pending, false);
  assert.equal(h.state.floor.id, "a-floor1");
  assert.equal(h.state.selected.id, "a-room");
});

test("successful cross-campus search opens the room after its floor loads", async () => {
  const h = harness();
  const pending = h.navigate("b");
  h.resolve("b");
  assert.equal(await pending, true);
  assert.equal(h.state.campus.id, "b");
  assert.equal(h.state.floor.id, "b-floor1");
  assert.equal(h.state.building, "b");
  assert.equal(h.state.selected.id, "b-room");
  assert.equal(h.$("#search").value, "b-101");
  assert.deepEqual(
    h.calls.map(([kind]) => kind),
    ["campus", "floor", "room"],
  );
});

test("a room callback without an active floor is harmless", () => {
  const h = harness();
  assert.doesNotThrow(() => h.select(h.roomFor("a")));
  assert.equal(h.state.selected, null);
});

test("G-424-1 opens its confirmed entrance room for either historical interface choice", async () => {
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  const meta = campus.floors.find((item) => item.id === "v-78-floor3");
  const floor = JSON.parse(
    readFileSync(new URL(`../public${meta.url}`, import.meta.url), "utf8"),
  );
  const rooms = ["v-78--floor-3--cux", "v-78--floor-3--cvi"].map((id) => ({
    ...floor.polygons.find((room) => room.id === id),
    campusId: campus.id,
    floorId: floor.id,
  }));
  const original = JSON.stringify(floor);
  for (const nextInterface of [false, true]) {
    const h = harness({ nextInterface, withExperience: true, actualUI: true });
    Object.assign(h.state, {
      campus,
      floorData: [floor],
      search: rooms,
    });
    assert.equal(await h.navigatePlace(rooms[0]), true);
    assert.match(h.$("#room-card").innerHTML, /Г-424-1/);
    const hint = h.createdElements.find(
      (element) => element.className === "entrance-hint",
    );
    assert.ok(hint, "the single interface always includes the entrance hint");
    assert.match(hint.innerHTML, /Вход через Г-424/);
    assert.match(hint.innerHTML, /положение внутренней двери ещё уточняется/);
    const actions = h.createdElements.find(
      (element) => element.className === "room-actions",
    );
    assert.equal(actions.beforeElement, hint);
    assert.equal(hint.children.length, 1);
    assert.equal(hint.children[0].textContent, "Показать Г-424");
    assert.equal(await hint.children[0].onclick(), true);
    assert.equal(h.state.selected.id, rooms[1].id);
    assert.equal(h.state.floor.id, "v-78-floor3");
    assert.equal(h.state.building, "Г");
    assert.match(h.$("#focus-floor-status").innerHTML, /4 этаж · корпус Г/);
  }
  assert.equal(
    JSON.stringify(floor),
    original,
    "the hint does not edit map geometry",
  );
});

test("a user-confirmed hall facility shows physical floor 2 without assigning building A", () => {
  const h = harness({ actualUI: true });
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  h.state.campus = campus;
  h.state.floor = {
    ...campus.floors.find((item) => item.id === "v-78-floor2"),
    polygons: [],
  };
  h.state.mode = "floor";
  h.state.building = null;
  h.select({
    id: "v-78--floor-2--9z2",
    label: "Столовая",
    kind: "cafeteria",
    building: null,
    campusId: "v-78",
    floorId: "v-78-floor2",
    center: [29.87, -6.32],
  });
  assert.equal(h.state.selected.label, "Буфет");
  assert.match(
    h.$("#focus-floor-status").innerHTML,
    /2 этаж · корпус уточняется/,
  );
  assert.doesNotMatch(
    h.$("#focus-floor-status").innerHTML,
    /корпус А|Уровень плана/,
  );
});

test("fresh V78 opens the main entrance A2 while explicit links preserve their view", () => {
  const view = resolveInitialView("", manifest);
  assert.equal(view.building, "А");
  assert.equal(view.floorId, "v-78-floor2");
  assert.equal(view.mode, "floor");
  assert.equal(
    resolveInitialView("campus=v-78&view=overview", manifest).mode,
    "overview",
  );
  assert.equal(
    resolveInitialView(
      "campus=v-78&view=floor&building=Г&floor=v-78-floor1",
      manifest,
    ).floorId,
    "v-78-floor1",
  );
});

test("legacy stacked links open a compatible single floor and preserve other link parameters", () => {
  const exact = new URLSearchParams(
    "campus=v-78&building=Г&floor=v-78-floor3&view=stack&projection=2d&from=a&to=b",
  );
  const original = exact.toString();
  assert.deepEqual(resolveInitialView(exact, manifest), {
    campusId: "v-78",
    building: "Г",
    floorId: "v-78-floor3",
    mode: "floor",
    projection: "2d",
  });
  assert.equal(exact.toString(), original);
  const campus = manifest.campuses.find((item) => item.id === "v-78");
  for (const hash of [
    "campus=v-78&building=Г&view=stack",
    "campus=v-78&building=Г&floor=v-78-floor4&view=stack",
    "campus=v-78&building=missing&floor=missing&view=stack",
    "campus=v-78&view=stack",
  ]) {
    const view = resolveInitialView(hash, manifest);
    assert.equal(view.mode, "floor");
    const floor = campus.floors.find((item) => item.id === view.floorId);
    assert.ok(floor);
    assert.ok(
      !view.building || Object.hasOwn(floor.buildingLevels, view.building),
    );
  }
});

test("choosing a building or overview reveals the phone map before focusing it in both interfaces", () => {
  for (const nextInterface of [false, true]) {
    for (const [width, height] of [
      [390, 844],
      [844, 390],
    ]) {
      const h = harness({ nextInterface, withExperience: true, width, height });
      h.chooseBuilding("a");
      assert.equal(h.state.building, "a");
      assert.deepEqual(h.calls, [["minimize"], ["overview", "a"]]);
      h.choose("a");
      h.calls.length = 0;
      h.chooseBuilding("a");
      assert.deepEqual(h.calls, [["minimize"], ["floor", "a-floor1"]]);
      assert.equal(h.state.mode, "floor");
      h.calls.length = 0;
      h.overview();
      assert.deepEqual(h.calls, [["minimize"], ["overview", undefined]]);
      assert.equal(h.state.mode, "overview");
      assert.equal(h.state.building, null);
    }
    const desktop = harness({
      nextInterface,
      withExperience: true,
      width: 1440,
      height: 900,
    });
    desktop.chooseBuilding("a");
    desktop.overview();
    assert.equal(
      desktop.calls.some(([kind]) => kind === "minimize"),
      false,
    );
  }
});

test("floor rail and Next picker preserve the minimized sheet for ordinary and route floors", () => {
  for (const nextInterface of [false, true]) {
    for (const hasRoute of [false, true]) {
      for (const initialSheet of ["minimized", "peek", "expanded"]) {
        const floors = [1, 2].map((level) => ({
          id: `e-${level}`,
          level,
          buildingLevels: { Е: level },
        }));
        const state = {
          campus: { floors },
          floor: floors[1],
          building: "Е",
          mode: "floor",
        };
        let sheet = initialSheet,
          pickerClosed = false;
        const sheetCalls = [],
          floorCalls = [];
        const button = (name, id) => ({
          dataset: { [name]: id },
          click() {
            this.onclick();
          },
        });
        const rail = floors.map((floor) => button("railFloor", floor.id));
        const picker = floors.map((floor) => button("nextFloor", floor.id));
        const elements = new Map();
        const $ = (selector) => {
          if (!elements.has(selector))
            elements.set(selector, {
              setAttribute() {},
              querySelectorAll: () =>
                selector === "#floor-rail" ? rail : picker,
              close() {
                pickerClosed = true;
              },
            });
          return elements.get(selector);
        };
        const context = {
          $,
          state,
          scene: { locationPicking: false },
          escape: String,
          icon: () => "",
          isNextInterface: () => nextInterface,
          placeLocation,
          floorContextOwner: "selection",
          chooseFloor(id) {
            state.floor = floors.find((floor) => floor.id === id);
            floorCalls.push("ordinary");
          },
          routes: {
            getRoute: () =>
              hasRoute
                ? {
                    segments: floors.map((floor) => ({
                      floorId: floor.id,
                      nodes: [{ building: "Е" }],
                    })),
                  }
                : null,
            showFloor(id) {
              state.floor = floors.find((floor) => floor.id === id);
              floorCalls.push("route");
            },
          },
          experience: {
            getSheetState: () => sheet,
            minimize() {
              sheet = "minimized";
              sheetCalls.push("minimized");
            },
            expand(value) {
              sheet = value ? "expanded" : "peek";
              sheetCalls.push(sheet);
            },
          },
        };
        vm.runInNewContext(
          section("function floorPhysical(", "function updateUI(") +
            section(
              "function renderFocusedFloorStatus(",
              "function cancelPendingNavigation(",
            ) +
            "\nrenderFloors();",
          context,
        );
        (nextInterface ? picker : rail)[0].click();
        assert.equal(state.floor.id, "e-1");
        assert.deepEqual(floorCalls, [hasRoute ? "route" : "ordinary"]);
        assert.equal(
          sheet,
          initialSheet === "minimized" ? "minimized" : "peek",
        );
        if (initialSheet === "minimized")
          assert.deepEqual(
            sheetCalls,
            [],
            "changing floor must not reopen a hidden panel",
          );
        assert.equal(pickerClosed, nextInterface);
      }
    }
  }
});

test("actual floor selection reuses the same merged plan after leaving and returning", () => {
  const h = harness();
  h.choose("a");
  const first = h.state.floor;
  assert.ok(first);
  h.overview();
  h.choose("a");
  assert.strictEqual(h.state.floor, first);
});

test("top All buildings returns to the whole campus without opening the sheet in either interface", () => {
  for (const nextInterface of [false, true]) {
    const h = harness({ nextInterface, actualUI: true, withExperience: true });
    const button = h.$("#campus-overview");
    h.overview();
    assert.equal(
      button.hidden,
      true,
      "no redundant back action at whole-campus view",
    );
    h.chooseBuilding("a");
    assert.equal(
      button.hidden,
      false,
      "available at a focused exterior building",
    );
    h.calls.length = 0;
    button.onclick();
    assert.deepEqual(h.calls, [
      ["minimize"],
      ["room", undefined],
      ["overview", undefined],
    ]);
    assert.equal(button.hidden, true);
    assert.equal(h.state.building, null);
    h.choose("a");
    assert.equal(h.state.building, null);
    assert.equal(
      button.hidden,
      false,
      "available on a floor even without a building filter",
    );
    h.state.selected = h.roomFor("a");
    h.calls.length = 0;
    button.onclick();
    assert.deepEqual(h.calls, [
      ["minimize"],
      ["room", undefined],
      ["overview", undefined],
    ]);
    assert.equal(h.state.mode, "overview");
    assert.equal(h.state.floor, null);
    assert.equal(h.state.selected, null);
    assert.equal(button.hidden, true);
  }
});

test("overview startup without an active floor tolerates missing, null and stale floor context", () => {
  for (const floorContext of [
    undefined,
    null,
    { floorId: "a-floor1", building: "a" },
  ]) {
    const h = harness({ actualUI: true });
    h.state.floorContext = floorContext;
    assert.equal(h.state.floor, null);
    assert.equal(h.floorContextBuilding(), null);
    assert.doesNotThrow(h.updateUI);
    assert.match(h.$("#focus-floor-status").innerHTML, /Обзор кампуса/);
    assert.equal(h.$("#next-floor-open").hidden, true);
    assert.equal(h.$("#campus-overview").hidden, true);
  }
});

function contextFloorHarness() {
  const h = realStairView(2);
  h.scene.locationFloor = h.state.floor;
  h.state.floorContext = {
    floorId: h.state.floor.id,
    building: "А",
    source: "selection",
  };
  const room = (label) =>
    h.state.floor.polygons.find((polygon) => polygon.label === label);
  return { ...h, room };
}

test("camera context moves from A2 to G3 on the same source plan and synchronizes every floor readout", () => {
  const h = contextFloorHarness();
  const floor = h.state.floor;
  const source = JSON.stringify(h.state.floorData);
  const location = {
    source: "manual",
    campusId: "v-78",
    floorId: floor.id,
    point: h.room("А-203").center.slice(),
  };
  h.state.userLocation = location;
  h.updateUI();
  assert.match(h.$("#next-floor-open").innerHTML, /Корпус А · 2 этаж/);
  h.queueCameraContext(h.room("Г-310").center);
  h.flushTimers();
  assert.equal(
    h.state.floor,
    floor,
    "context does not select a different plan",
  );
  assert.equal(
    h.state.building,
    "А",
    "context does not rebuild the chosen geometry",
  );
  assert.equal(
    h.state.userLocation,
    location,
    "panning cannot move or refine the user's point",
  );
  assert.equal(h.state.floorContext.source, "camera");
  assert.equal(h.state.floorContext.building, "Г");
  assert.equal(h.state.floorContext.physicalLevel, 3);
  assert.match(h.$("#focus-floor-status").innerHTML, /3 этаж · корпус Г/);
  assert.match(h.$("#next-floor-open").innerHTML, /Корпус Г · 3 этаж/);
  assert.match(h.$("#next-floor-title").textContent, /Корпус Г/);
  assert.match(h.$("#breadcrumb").innerHTML, /Корпус Г.*3 этаж/);
  assert.match(h.$("#view-title").innerHTML, /Корпус Г.*3 этаж/);
  assert.equal(h.$("#caption-title").textContent, "Корпус Г · 3 этаж");
  for (const level of [1, 2, 3, 4])
    assert.match(
      h.$("#next-floor-list").innerHTML,
      new RegExp(`aria-label="${level} этаж корпуса Г"`),
    );
  assert.equal(
    (h.$("#next-floor-list").innerHTML.match(/data-next-floor=/g) || []).length,
    4,
  );
  assert.equal(
    h.calls.some(([kind]) => kind === "floor"),
    false,
  );
  const confirmed = h.state.floorContext;
  const shared = floor.polygons.find(
    (polygon) => polygon.id === "v-78-floor2-area-29",
  );
  assert.equal(resolveFloorContext(floor, shared.center), null);
  h.queueCameraContext(shared.center);
  h.flushTimers();
  assert.equal(
    h.state.floorContext,
    confirmed,
    "ambiguous corridor retains the last clear G3 context",
  );
  assert.match(h.$("#next-floor-open").innerHTML, /Корпус Г · 3 этаж/);
  assert.equal(JSON.stringify(h.state.floorData), source);
});

test("manual location context updates the selected plan's floor readout without inferring a different source level", () => {
  const h = contextFloorHarness();
  h.state.userLocation = {
    source: "manual",
    campusId: "v-78",
    floorId: h.state.floor.id,
    point: h.room("Г-310").center.slice(),
  };
  const floor = h.state.floor;
  h.locationContext();
  assert.equal(h.state.floorContext.building, "Г");
  assert.equal(h.state.floorContext.source, "location");
  assert.match(h.$("#focus-floor-status").innerHTML, /3 этаж · корпус Г/);
  const confirmed = h.state.floorContext;
  h.state.userLocation = {
    ...h.state.userLocation,
    floorId: "v-78-floor1",
    point: h.room("А-203").center.slice(),
  };
  h.locationContext();
  assert.equal(
    h.state.floorContext,
    confirmed,
    "a manual point on another selected plan cannot overwrite this readout",
  );
  assert.equal(h.state.floor, floor);
});

test("route context ignores other floors and owns the readout until a real camera interaction", () => {
  const h = contextFloorHarness();
  const point = h.room("Г-310").center;
  const nodes = [
    {
      floorId: h.state.floor.id,
      building: "Г",
      physicalLevel: 3,
      position: [point[0] - 0.5, point[1]],
    },
    {
      floorId: h.state.floor.id,
      building: "Г",
      physicalLevel: 3,
      position: [point[0] + 0.5, point[1]],
    },
  ];
  h.routeContext({ floorId: "v-78-floor1", position: point }, nodes);
  assert.equal(h.state.floorContext.building, "А");
  h.routeContext({ floorId: h.state.floor.id, position: point }, nodes);
  assert.equal(h.state.floorContext.building, "Г");
  assert.equal(h.state.floorContext.source, "route");
  h.queueCameraContext(h.room("А-203").center, { owner: "route" });
  h.flushTimers();
  assert.equal(
    h.state.floorContext.building,
    "Г",
    "route camera animation cannot replace the route's actual section context",
  );
  h.queueCameraContext(h.room("А-203").center);
  h.flushTimers();
  assert.equal(
    h.state.floorContext.building,
    "А",
    "deliberate free map interaction may establish camera context again",
  );
  assert.equal(h.state.floorContext.source, "camera");
});

test("Outside building to Inside retains focus and scale while showing the complete source plan", () => {
  const h = harness({ withExperience: true });
  const source = h.state.floorData[0];
  source.polygons.push({ id: "neighbor-room", building: "b", label: "b-101" });
  const original = JSON.stringify(source);
  h.chooseBuilding("a");
  h.calls.length = 0;
  assert.equal(h.$("#nav-inside").onclick(), true);
  assert.equal(h.state.mode, "floor");
  assert.equal(
    h.state.building,
    "a",
    "building context remains the outside selection",
  );
  assert.equal(h.state.floor.id, source.id, "the existing source plan is used");
  assert.strictEqual(h.state.floor.polygons, source.polygons);
  assert.equal(
    JSON.stringify(source),
    original,
    "source geometry remains untouched",
  );
  assert.equal(
    h.scene.lastFloorView.neighborsOn,
    true,
    "neighbors are enabled before rendering",
  );
  assert.equal(
    h.scene.lastFloorView.building,
    "a",
    "selected wing remains the camera focus",
  );
  assert.equal(
    h.scene.lastFloorView.options.fit,
    false,
    "do not fit the full floor or change zoom",
  );
  assert.equal(h.$("#neighbors").checked, true);
  assert.deepEqual(h.calls, [["floor", source.id], ["keep-floor-viewport"]]);
  h.calls.length = 0;
  assert.equal(h.$("#nav-inside").onclick(), true);
  assert.deepEqual(
    h.calls,
    [],
    "pressing Inside again does not reset the user's view",
  );
});

test("an explicit neighbor choice remains usable and survives later Outside to Inside entries", () => {
  const h = harness();
  h.chooseBuilding("a");
  h.$("#nav-inside").onclick();
  h.$("#neighbors").checked = false;
  h.$("#neighbors").onchange();
  assert.equal(h.scene.lastFloorView.neighborsOn, false);
  assert.equal(h.scene.lastFloorView.options.fit, false);
  assert.equal(h.state.neighborsPreference, false);
  h.overview();
  h.chooseBuilding("a");
  h.$("#open-interior").onclick();
  assert.equal(
    h.scene.lastFloorView.neighborsOn,
    false,
    "respect the explicit session preference",
  );
  assert.equal(h.$("#neighbors").checked, false);
  h.$("#neighbors").checked = true;
  h.$("#neighbors").onchange();
  assert.equal(
    h.scene.lastFloorView.neighborsOn,
    true,
    "all buildings can be restored directly in Settings",
  );
  assert.equal(h.state.building, "a");
});

test("Inside never enables neighbors or changes the view when the requested plan was not loaded", () => {
  const h = harness();
  h.state.floorData = [];
  h.scene.neighborsOn = false;
  h.$("#neighbors").checked = false;
  assert.equal(h.$("#nav-inside").onclick(), false);
  assert.equal(h.state.mode, "overview");
  assert.equal(h.state.floor, null);
  assert.equal(h.scene.neighborsOn, false);
  assert.equal(h.$("#neighbors").checked, false);
  assert.deepEqual(h.calls, []);
});
