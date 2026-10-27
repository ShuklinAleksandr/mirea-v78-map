import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  buildPlaceLandmarks,
  placeBuilding,
  placeDescription,
  placeLocation,
  presentPlaceIdentity,
} from "../src/data/place-location.js";
import { derivePlaceLandmarkData } from "../scripts/build-place-landmarks.mjs";
import {
  findPlaces,
  PLACE_CATEGORIES,
  categoryForPlaceQuery,
  placeCategory,
} from "../src/data/place-search.js";
import {
  rankNearbyPlaces,
  nearbyDistanceLabel,
} from "../src/data/nearby-places.js";
import { escape } from "../src/ui/dom.js";
import { getFloorMarkers } from "../src/data/utils.js";

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const generated = read("../src/data/place-landmarks.json");
const manifest = read("../public/data/manifest.json");
const sourceSearch = read("../public/data/search-index.json");
const records = (
  Array.isArray(sourceSearch) ? sourceSearch : sourceSearch.rooms
).filter((room) => room.campusId === "v-78");
const campus = manifest.campuses.find((item) => item.id === "v-78");
const floor = (id) => campus.floors.find((item) => item.id === id);

test("a numbered medical label supplies its own building and physical floor", () => {
  const room = records.find((item) => item.kind === "medical");
  assert.equal(room.building, null);
  const location = placeLocation(room, floor(room.floorId), generated.hints);
  assert.equal(location.building, "А");
  assert.equal(location.physicalLevel, 1);
  assert.equal(location.summary, "Корпус А · 1 этаж");
  assert.equal(location.landmark, "");
  assert.equal(
    placeBuilding({ label: "Гардеробная" }, floor(room.floorId)),
    null,
  );
});

test("a landmark does not assign its building or physical floor to a facility", () => {
  const room = records.find((item) => item.id === "v-78--floor-2--a0j");
  const location = placeLocation(room, floor(room.floorId), generated.hints);
  assert.equal(location.building, null);
  assert.equal(location.physicalLevel, null);
  assert.equal(location.landmark, "Ориентир: Б-312 · корпус Б · 3 этаж");
  assert.match(location.summary, /Корпус и этаж уточняются/);
  assert.match(location.summary, /уровень 2 плана/);
});

test("unknown source level zero never becomes a physical ground floor or basement", () => {
  const room = records.find((item) => item.id === "v-78--floor-0--204");
  const location = placeLocation(room, floor(room.floorId), generated.hints);
  assert.equal(location.physicalLevel, null);
  assert.equal(location.landmark, "");
  assert.equal(location.summary, "Корпус и этаж уточняются · уровень 0 плана");
  assert.doesNotMatch(location.summary, /цоколь|0 этаж/i);
});

test("facility notes describe the source category without classroom occupancy text", () => {
  for (const kind of ["cafeteria", "cloakroom", "medical", "entrance"]) {
    const note = placeDescription({ kind, label: "Объект" });
    assert.match(note, /план/);
    assert.doesNotMatch(note, /Занятость|аудитор/);
  }
  assert.match(
    placeDescription({ kind: "toilet", label: "Туалет Ж" }),
    /Женский санузел/,
  );
  assert.match(
    placeDescription({ kind: "toilet", label: "Туалет М" }),
    /Мужской санузел/,
  );
  assert.match(
    placeDescription({ kind: "toilet", label: "Туалет" }),
    /Тип санузла в подписи не указан/,
  );
});

test("the entrance, its hall and the two open buffets have confirmed floor 2 without borrowing building A", () => {
  for (const id of [
    "v-78--floor-2--9yb",
    "v-78--floor-2--9yc",
    "v-78--floor-2--9z2",
    "v-78--floor-2--a05",
  ]) {
    const room = records.find((entry) => entry.id === id);
    const original = JSON.stringify(room);
    const display = presentPlaceIdentity(room);
    const location = placeLocation(
      display,
      floor(room.floorId),
      generated.hints,
    );
    assert.equal(location.building, null);
    assert.equal(location.physicalLevel, 2);
    assert.equal(location.summary, "Корпус уточняется · 2 этаж");
    assert.equal(location.locationEvidence.type, "user-confirmed");
    assert.equal(display.placeEvidence.date, "2026-10-25");
    if (room.kind === "cafeteria") {
      assert.equal(display.label, "Буфет");
      assert.match(placeDescription(display), /без стен/);
    }
    assert.equal(JSON.stringify(room), original);
  }
  const entrance = records.find((entry) => entry.id === "v-78--floor-2--9yb");
  assert.match(placeDescription(entrance), /соединяется с корпусом А/);
  const wardrobe = records.find((entry) => entry.id === "v-78--floor-2--9yc");
  assert.match(
    placeDescription(wardrobe),
    /библиотекой и соединением с корпусом И/,
  );
  assert.doesNotMatch(placeDescription(wardrobe), /корпусом ИВЦ/);
  const island = records.find((entry) => entry.id === "v-78--floor-2--9y7");
  assert.equal(presentPlaceIdentity(island), island);
  assert.equal(
    placeLocation(island, floor(island.floorId)).physicalLevel,
    null,
  );
  assert.equal(
    presentPlaceIdentity({ ...entrance, floorId: "v-78-floor1" }).placeEvidence,
    undefined,
  );
});

test("the user-identified descent at the wardrobe labels only the existing source point without assigning the destination's building or floor", () => {
  const sourceFloor = read("../public/data/campuses/v-78/v-78-floor2.json");
  const sourceId = "v-78:edge:20734";
  const source = sourceFloor.markers.find((marker) => marker.id === sourceId);
  const normalized = getFloorMarkers(sourceFloor).find((marker) =>
    marker.sourceIds.includes(sourceId),
  );
  assert.ok(source);
  assert.ok(normalized.id.startsWith(`${sourceId}@`));
  for (const marker of [source, normalized]) {
    const before = JSON.stringify(marker);
    const display = presentPlaceIdentity(marker, sourceFloor);
    assert.equal(display.label, "Спуск к библиотеке · корпус И");
    assert.equal(display.building, null);
    assert.equal(placeLocation(display, sourceFloor).physicalLevel, 2);
    assert.match(display.note, /площадка и разворот на 180°/);
    assert.match(display.note, /И и ИВЦ — разные корпуса/);
    assert.match(
      display.note,
      /физический этаж и точная привязка нижнего выхода ещё не подтверждены/,
    );
    assert.equal(display.layoutId, undefined);
    assert.equal(JSON.stringify(marker), before);
    assert.deepEqual(presentPlaceIdentity(display, sourceFloor), display);
    assert.equal(placeDescription(display), display.note);
  }
  for (const marker of [
    { ...source, id: "v-78:edge:207340" },
    { ...source, position: [31.523, 33.1784] },
    { ...source, kind: "room" },
    { ...source, targetFloorId: "v-78-floor0" },
    { ...source, targetPosition: [0, 0] },
    { ...normalized, position: [0, 0] },
    { ...normalized, id: "different-source", sourceIds: [] },
  ])
    assert.equal(presentPlaceIdentity(marker, sourceFloor), marker);
  assert.equal(
    presentPlaceIdentity(normalized, { ...sourceFloor, id: "v-78-floor1" }),
    normalized,
  );
  const hall = sourceFloor.polygons.find(
    (polygon) => polygon.id === "v-78-floor2-area-6",
  );
  const displayedHall = presentPlaceIdentity(hall, sourceFloor);
  assert.equal(displayedHall.kind, "hall");
  assert.deepEqual(
    presentPlaceIdentity(displayedHall, sourceFloor),
    displayedHall,
  );
  assert.equal(placeLocation(displayedHall, sourceFloor).physicalLevel, 2);
  assert.match(placeDescription(displayedHall), /соединённый с корпусом А/);
});

function graphFixture() {
  const room = (id, kind, building = null) => ({
    id,
    label: id,
    kind,
    campusId: "v-78",
    floorId: "source-1",
    building,
  });
  const records = [
    room("facility", "cafeteria"),
    room("А-101", "room", "А"),
    room("Б-201", "room", "Б"),
    room("private", "room"),
  ];
  const node = (id, areaId = id) => ({
    id,
    areaId,
    floorId: "source-1",
    position: [0, 0],
  });
  const edge = (from, to, distanceMeters, extra = {}) => ({
    id: `${from}:${to}`,
    from,
    to,
    kind: "corridor",
    eligible: true,
    bidirectional: true,
    distanceMeters,
    ...extra,
  });
  const graph = {
    campusId: "v-78",
    status: "source-graph",
    floors: { "source-1": { level: 1, buildingLevels: { А: 1, Б: 2 } } },
    rooms: { facility: { nodeId: "facility" } },
    nodes: records.map((room) => node(room.id)).concat(node("hall")),
    edges: [
      edge("facility", "hall", 4),
      edge("hall", "А-101", 3, { kind: "door" }),
      edge("facility", "Б-201", 1, { eligible: false }),
    ],
  };
  return { graph, records, edge };
}

test("landmarks use allowed passages, ignoring closer disconnected points and rejected shortcuts", () => {
  const { graph, records } = graphFixture();
  const hint = buildPlaceLandmarks(graph, records).get("facility");
  assert.equal(hint.label, "А-101");
  assert.equal(hint.distanceMeters, 7);
  assert.deepEqual(hint.edgeIds, ["facility:hall", "hall:А-101"]);
  assert.equal(buildPlaceLandmarks(graph, records, { maxDistance: 6 }).size, 0);
});

test("another named room, vertical edge, wrong floor or reverse-only edge cannot supply a landmark", () => {
  for (const scenario of ["private", "stairs", "wrong-floor", "reverse"]) {
    const { graph, records, edge } = graphFixture();
    graph.edges = [];
    if (scenario === "private")
      graph.edges.push(
        edge("facility", "private", 1),
        edge("private", "А-101", 1),
      );
    if (scenario === "stairs")
      graph.edges.push(edge("facility", "А-101", 1, { kind: "stairs" }));
    if (scenario === "wrong-floor") {
      graph.nodes.find((node) => node.id === "А-101").floorId = "source-2";
      graph.edges.push(edge("facility", "А-101", 1));
    }
    if (scenario === "reverse")
      graph.edges.push(edge("А-101", "facility", 1, { bidirectional: false }));
    assert.equal(buildPlaceLandmarks(graph, records).size, 0, scenario);
  }
});

test("the generated hints match the current archived graph, catalog, manifest and floor files", async () => {
  const { data, missing } = await derivePlaceLandmarkData();
  assert.deepEqual(generated, data);
  assert.equal(Object.keys(data.hints).length, 47);
  assert.equal(missing.length, 57);
  const gaps = readFileSync(
    new URL("../docs/PLACE_LOCATION_GAPS_2026-10-20.md", import.meta.url),
    "utf8",
  );
  for (const room of missing) {
    assert.ok(gaps.includes(room.id), room.id);
    assert.ok(gaps.includes(room.floorId), room.floorId);
    assert.ok(gaps.includes(room.center.join(", ")), room.id);
  }
});

test("category search rows expose facility location and a separate numbered landmark after opening other places", async () => {
  const elements = new Map();
  const element = (tagName = "div") => ({
    tagName: tagName.toUpperCase(),
    value: "",
    children: [],
    hidden: false,
    innerHTML: "",
    attributes: {},
    listeners: {},
    replaceChildren() {
      this.children = [];
      this.innerHTML = "";
    },
    append(child) {
      this.children.push(child);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(selector === "button" && child.tagName === "BUTTON" ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
  });
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const sandbox = {
    $,
    escape,
    icon: () => "",
    findPlaces,
    PLACE_CATEGORIES,
    categoryForPlaceQuery,
    placeCategory,
    rankNearbyPlaces,
    nearbyDistanceLabel,
    placeLocation,
    presentPlaceIdentity,
    placeLandmarks: generated,
    URL,
    document: { createElement: element },
  };
  const source = readFileSync(
    new URL("../src/ui/search.js", import.meta.url),
    "utf8",
  )
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/export /g, "")
    .replace(/import\.meta\.url/g, '"https://local.test/search.js"');
  const bindSearch = vm.runInNewContext(`${source}\n;bindSearch`, sandbox);
  const search = bindSearch({
    state: { search: records, manifest: { campuses: [campus] } },
    navigateRoom() {},
  });
  $("#search").value = "еда";
  await search.refresh();
  const rows = () =>
    $("#results").children.filter((row) => row.className === "place-result");
  assert.equal(
    rows().length,
    5,
    "five results are shown immediately before expanding the remaining places",
  );
  const more = $("#results")
    .querySelectorAll("button")
    .find((button) => button.className === "nearby-more");
  assert.ok(
    more,
    "other facility rows remain available through a working button",
  );
  more.onclick();
  assert.equal(rows().length, 6);
  const html = rows()
    .map((row) => row.innerHTML)
    .join("\n");
  assert.match(html, /Ориентир: Б-312 · корпус Б · 3 этаж/);
  assert.match(html, /Корпус и этаж уточняются · уровень 2 плана/);
  assert.doesNotMatch(html, /undefined|0 этаж/);
  assert.ok(
    rows().filter((row) =>
      row.innerHTML.includes("<small>Корпус уточняется · 2 этаж"),
    ).length === 2,
    "only the two confirmed stair-side buffets receive physical floor 2",
  );
});
