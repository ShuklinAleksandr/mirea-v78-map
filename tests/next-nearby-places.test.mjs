import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  rankNearbyPlaces,
  canRankNearbyRoutes,
} from "../src/data/nearby-places.js";
import { makeCurrentRouteEndpoint } from "../src/data/current-route-origin.js";
import { findRoute } from "../src/data/routing.js";
import { findNextPlaces } from "../src/data/next-place-search.js";

const now = 1_000_000;
const rectangle = (a, b, c, d) => [
  [a, b],
  [c, b],
  [c, d],
  [a, d],
];
const manual = (point = [2, 5]) => ({
  source: "manual",
  campusId: "fixture",
  floorId: "f1",
  building: "Г",
  physicalLevel: 2,
  floorEvidence: "manual",
  point,
  timestamp: now,
});
function fixture() {
  const sourceFloor = {
    campusId: "fixture",
    id: "f1",
    level: 1,
    buildingLevels: { Г: 2 },
    walls: [],
    doors: [],
    polygons: [
      {
        id: "hall",
        kind: "corridor",
        building: "Г",
        points: rectangle(0, 0, 20, 10),
        holes: [],
      },
      {
        id: "dest",
        kind: "cafeteria",
        building: "Г",
        points: rectangle(20, 0, 30, 10),
        holes: [],
      },
    ],
  };
  const node = (id, areaId, position) => ({
    id,
    areaId,
    position,
    floorId: "f1",
    building: "Г",
    physicalLevel: 2,
    sourceLevel: 1,
  });
  const graph = {
    campusId: "fixture",
    status: "source-graph",
    units: "meters",
    floors: { f1: { level: 1, buildingLevels: { Г: 2 } } },
    nodes: [
      node("h0", "hall", [5, 5]),
      node("h", "hall", [10, 5]),
      node("d", "dest", [24, 5]),
    ],
    edges: [
      {
        id: "h0h",
        from: "h0",
        to: "h",
        kind: "corridor",
        eligible: true,
        bidirectional: false,
        cost: 5,
      },
      {
        id: "hd",
        from: "h",
        to: "d",
        kind: "door",
        eligible: true,
        bidirectional: false,
        cost: 14,
      },
    ],
    rooms: {
      dest: { nodeId: "d", label: "Буфет", floorId: "f1", kind: "cafeteria" },
    },
  };
  const records = [
    {
      id: "dest",
      campusId: "fixture",
      floorId: "f1",
      building: "Г",
      label: "Буфет",
      kind: "cafeteria",
      center: [24, 5],
    },
  ];
  const manifest = { campuses: [{ id: "fixture", floors: [sourceFloor] }] };
  return { sourceFloor, graph, records, manifest };
}
function rank(f, position = manual(), extra = {}) {
  return rankNearbyPlaces(f.records, {
    ...f,
    position,
    interfaceMode: "next",
    now,
    ...extra,
  });
}

test("Next ranks from a corridor pin using the same permitted connector as route construction, keeping the source immutable", () => {
  const f = fixture(),
    before = JSON.stringify(f.graph);
  const result = rank(f);
  assert.equal(result.mode, "routes");
  assert.equal(result.nearest.room.id, "dest");
  assert.equal(result.nearest.distanceMeters, 22);
  const endpoint = makeCurrentRouteEndpoint(manual(), { now }).endpoint;
  assert.equal(
    findRoute(f.graph, endpoint, "dest", { floors: [f.sourceFloor] }).ok,
    true,
  );
  assert.equal(JSON.stringify(f.graph), before);
  assert.equal(
    rank(f, manual(), { interfaceMode: "classic" }).mode,
    "straight-line",
  );
  assert.equal(
    rankNearbyPlaces(f.records, { ...f, position: manual(), now }).mode,
    "straight-line",
  );
});

test("Next rejects connections through a wall, closed door, hole or the wrong floor and labels the fallback honestly", () => {
  for (const key of ["walls", "doors"]) {
    const f = fixture();
    f.sourceFloor[key] = [{ a: [4, 0], b: [4, 10] }];
    const result = rank(f);
    assert.equal(result.mode, "straight-line", key);
    assert.equal(result.nearest.distanceKind, "straight-line", key);
  }
  const hole = fixture();
  hole.sourceFloor.polygons[0].holes = [rectangle(3, 4, 4, 6)];
  assert.equal(rank(hole).mode, "straight-line");
  const wrong = fixture();
  wrong.sourceFloor.id = "another-floor";
  assert.equal(rank(wrong).mode, "straight-line");
  const outside = fixture();
  assert.equal(rank(outside, manual([-1, 5])).mode, "straight-line");
});

test("GPS nearest routes require a fresh accurate fix and a user-selected floor", () => {
  const f = fixture();
  const gps = {
    ...manual(),
    source: "gps",
    accuracyMeters: 5,
    trackingStatus: "live",
    expiresAt: now + 60_000,
    floorEvidence: "manual-view-selection",
  };
  assert.equal(rank(f, gps).mode, "routes");
  for (const change of [
    { accuracyMeters: 13 },
    { accuracyMeters: undefined },
    { timestamp: now - 10_001 },
    { floorEvidence: "unknown" },
  ]) {
    assert.equal(
      canRankNearbyRoutes(
        { ...gps, ...change },
        { interfaceMode: "next", now },
      ),
      false,
    );
    assert.equal(rank(f, { ...gps, ...change }).mode, "straight-line");
  }
  assert.equal(
    rank(f, { ...gps, trackingStatus: "stopped" }).mode,
    "no-location",
  );
  assert.equal(
    rank(f, gps, { interfaceMode: "classic" }).mode,
    "straight-line",
  );
});

test("the projected free origin cannot travel backwards along a one-way corridor", () => {
  const f = fixture();
  f.graph.nodes.push({
    id: "u",
    areaId: "upstream",
    position: [24, 6],
    floorId: "f1",
    building: "Г",
    physicalLevel: 2,
    sourceLevel: 1,
  });
  f.graph.rooms.upstream = {
    nodeId: "u",
    label: "Столовая",
    kind: "cafeteria",
    floorId: "f1",
  };
  f.graph.edges.push({
    id: "upstream",
    from: "h0",
    to: "u",
    kind: "door",
    eligible: true,
    bidirectional: false,
    cost: 19,
  });
  f.records.push({
    ...f.records[0],
    id: "upstream",
    label: "Столовая",
    center: [24, 6],
  });
  const result = rank(f, manual([9, 5]));
  assert.equal(result.mode, "routes");
  assert.equal(
    result.items.find((x) => x.room.id === "upstream").reachable,
    false,
  );
  assert.equal(result.nearest.room.id, "dest");
});

test("Next real V78 point ranking only advertises routes also reachable with production routing", () => {
  const read = (p) =>
    JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
  const graph = read("public/data/routing/v-78.json"),
    sourceFloor = read("public/data/campuses/v-78/v-78-floor0.json");
  const start = sourceFloor.polygons.find((p) => p.label === "Г-103-1");
  const records = read("public/data/search-index.json").filter(
    (r) => r.campusId === "v-78" && ["toilet", "cafeteria"].includes(r.kind),
  );
  const position = {
    ...manual(start.center),
    campusId: "v-78",
    floorId: sourceFloor.id,
    physicalLevel: 1,
  };
  const result = rankNearbyPlaces(records, {
    graph,
    sourceFloor,
    position,
    interfaceMode: "next",
    now,
  });
  assert.equal(result.mode, "routes");
  const winners = result.items.filter((x) => x.reachable).slice(0, 5);
  assert.ok(winners.length);
  const from = makeCurrentRouteEndpoint(position, { now }).endpoint;
  for (const item of winners)
    assert.equal(
      findRoute(graph, from, item.room, { floors: [sourceFloor] }).ok,
      true,
      item.room.id,
    );
});

test("shared Next search matches food categories, keeps exact rooms first and retains other buildings", () => {
  const records = [
    {
      id: "a",
      label: "А-209",
      building: "А",
      floorId: "f1",
      campusId: "v-78",
      kind: "room",
    },
    {
      id: "g",
      label: "Г-209",
      building: "Г",
      floorId: "f2",
      campusId: "v-78",
      kind: "room",
    },
    {
      id: "food-a",
      label: "Буфет",
      building: "А",
      floorId: "f1",
      campusId: "v-78",
      kind: "cafeteria",
    },
    {
      id: "food-g",
      label: "Столовая",
      building: "Г",
      floorId: "f2",
      campusId: "v-78",
      kind: "cafeteria",
    },
  ];
  const context = {
    campusId: "v-78",
    building: "Г",
    floorId: "f2",
    manifest: {
      campuses: [
        {
          id: "v-78",
          floors: [
            { id: "f1", buildingLevels: { А: 2 } },
            { id: "f2", buildingLevels: { Г: 3 } },
          ],
        },
      ],
    },
  };
  assert.deepEqual(
    findNextPlaces(records, { ...context, query: "еда" }).map((r) => r.id),
    ["food-g", "food-a"],
  );
  assert.deepEqual(
    findNextPlaces(records, { ...context, query: "209" }).map((r) => r.id),
    ["g", "a"],
  );
  assert.equal(
    findNextPlaces(records, { ...context, query: "А-209" })[0].id,
    "a",
  );
  assert.equal(findNextPlaces(records, context).length, 4);
});
