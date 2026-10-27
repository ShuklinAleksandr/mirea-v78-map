import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolveInitialView } from "../src/data/navigation.js";
import { geometryEvidence, resolveRoom } from "../src/data/utils.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
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
  section("function cancelPendingNavigation(", "function saveView("),
  section("function roomPadding(", "const kindNames"),
  section("function selectRoom(", '$("#overview").onclick'),
].join("\n");

function harness({ stairMarkers = [], actualUI = false, landmarks = {} } = {}) {
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
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 624, right: 366, height: 220 }),
      });
    return elements.get(selector);
  };
  $("#campus").value = "a";
  const requests = new Map(),
    errors = [],
    calls = [];
  let targetButtons = [];
  const context = vm.createContext({
    state,
    $,
    resolveRoom,
    placeDescription,
    placeLocation,
    presentPlaceIdentity,
    getHallAdjacencyView,
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
      setFloor(f) {
        calls.push(["floor", f.id]);
        this.locationPicking = false;
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
    availableFloors: () => state.campus.floors,
    floorPhysical: (f) => f.level,
    floorName: (f) => String(f.level),
    geometryEvidence,
    withConfirmedStairSearch,
    getFloorMarkers: () => [],
    getMapStairMarkers: () => stairMarkers,
    resolveStairTarget,
    kindNames: { room: "Помещение" },
    innerWidth: 390,
    innerHeight: 844,
    escape: String,
    icon: () => "",
    document: {
      querySelectorAll(selector) {
        if (selector !== "[data-target]") return [];
        targetButtons = [
          ...$("#room-card").innerHTML.matchAll(/data-target="(\d+)"/g),
        ].map((match) => ({ dataset: { target: match[1] } }));
        return targetButtons;
      },
    },
    matchMedia: () => ({ matches: true }),
    renderFloors() {},
    routes: { syncView() {}, changedCampus() {} },
    userPosition: {
      cancelPicking() {
        context.scene.locationPicking = false;
      },
    },
  });
  vm.runInContext(controller, context);
  if (actualUI)
    vm.runInContext(
      section("function updateUI(", "function cancelPendingNavigation(") +
        section("function closeRoom(", "function roomPadding("),
      context,
    );
  return {
    state,
    $,
    errors,
    calls,
    scene: context.scene,
    roomFor,
    load: (id) => context.loadCampus(id),
    navigate: (id) => context.navigateRoom(roomFor(id)),
    navigatePlace: (room) => context.navigateRoom(room),
    dismiss: () => context.dismissRoom(),
    choose: (id) => context.chooseFloor(`${id}-floor1`),
    overview: () => context.overview(),
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
