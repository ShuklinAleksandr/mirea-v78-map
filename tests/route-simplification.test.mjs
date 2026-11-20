import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simplifyWalkingSegment } from "../src/data/route-simplification.js";
import { findRoute } from "../src/data/routing.js";

const box = (x1, y1, x2, y2) => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];
function fixture(
  points = [
    [1, 1],
    [5, 6],
    [9, 1],
  ],
) {
  const floorId = "fixture-floor";
  const floor = {
    id: floorId,
    campusId: "fixture",
    units: "meters",
    level: 1,
    footprints: [{ points: box(0, 0, 10, 10) }],
    polygons: [{ id: "hall", kind: "hall", points: box(0, 0, 10, 10) }],
    walls: [],
    doors: [],
    transitions: [],
    markers: [],
  };
  const nodes = points.map((position, i) => ({
    id: "node-" + i,
    areaId: "hall",
    floorId,
    position,
    kind: "door",
    building: "А",
    physicalLevel: 1,
  }));
  const edges = nodes.slice(1).map((n, i) => ({
    from: nodes[i].id,
    to: n.id,
    kind: "corridor",
    eligible: true,
    bidirectional: true,
  }));
  return {
    floor,
    segment: { floorId, points, nodes },
    route: { campusId: floor.campusId, edges },
  };
}
const apply = (f, options) =>
  simplifyWalkingSegment(f.segment, f.route, f.floor, options);

test("a wall-free hall gets a direct walking line through the original endpoints", () => {
  const f = fixture(),
    before = structuredClone(f);
  const s = apply(f);
  assert.deepEqual(s.points, [
    [1, 1],
    [9, 1],
  ]);
  assert.ok(s.straightened);
  assert.equal(s.nodes[0], f.segment.nodes[0]);
  assert.equal(s.nodes[1], f.segment.nodes.at(-1));
  assert.deepEqual(f, before);
});
test("thin walls including their width, doors, concave or missing slabs, and nested obstacles keep the detour", () => {
  const cases = [
    (f) => f.floor.walls.push({ a: [4, 0], b: [4, 1.1] }),
    (f) => f.floor.walls.push({ a: [3.9, 1.15], b: [4.1, 1.15], width: 0.4 }),
    (f) => f.floor.doors.push({ a: [4, 0], b: [4, 1.1] }),
    (f) => (f.floor.polygons[0].holes = [box(4, 0.99, 4.001, 1.01)]),
    (f) => (f.floor.footprints[0].holes = [box(4, 0.9, 4.1, 1.1)]),
    (f) =>
      (f.floor.polygons[0].points = [
        [0, 0],
        [3, 0],
        [3, 2],
        [4, 2],
        [4, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    (f) =>
      f.floor.polygons.push({
        id: "room",
        kind: "room",
        points: box(3, 0.9, 5, 1.2),
      }),
    (f) =>
      f.floor.polygons.push({
        id: "stairs",
        kind: "stairs",
        points: box(3, 0.9, 5, 1.2),
      }),
    (f) => f.floor.transitions.push({ kind: "stairs", position: [4, 1.5] }),
    (f) => (f.floor.uncertaintyRegions = [{ points: box(3, 0.9, 5, 1.2) }]),
    (f) => (f.floor.polygons[0].kind = "room"),
    (f) => (f.floor.doors = null),
  ];
  for (const change of cases) {
    const f = fixture();
    change(f);
    assert.equal(apply(f), f.segment, change.toString());
  }
});
test("route semantics survive a geometrically clear chord", () => {
  const cases = [
    (f) => (f.route.edges[0].bidirectional = false),
    (f) => (f.route.edges[0].kind = "door"),
    (f) => (f.route.edges[0].eligible = false),
    (f) => (f.route.edges[1].ephemeral = true),
    (f) => (f.segment.nodes[1].building = "Г"),
    (f) => (f.segment.nodes[1].physicalLevel = 2),
    (f) => (f.segment.nodes[1].floorId = "other"),
    (f) => (f.segment.nodes[1].areaId = "unknown"),
    (f) => (f.segment.nodes[1].position = [4, 6]),
  ];
  for (const change of cases) {
    const f = fixture();
    change(f);
    assert.equal(apply(f), f.segment, change.toString());
  }
  const f = fixture();
  assert.equal(apply(f, { blockedAreaIds: ["hall"] }), f.segment);
});
test("a real V-78 hall route loses unnecessary bends while keeping crossed doors and stair landings", () => {
  const read = (path) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url)));
  const graph = read("../public/data/routing/v-78.json");
  const id = (label) =>
    Object.keys(graph.rooms).find((id) => graph.rooms[id].label === label);
  const route = findRoute(graph, id("Главный вход"), id("И-205-а"));
  let removed = 0;
  const kept = new Set();
  for (const s of route.segments) {
    const display = simplifyWalkingSegment(
      s,
      route,
      read("../public/data/campuses/v-78/" + s.floorId + ".json"),
    );
    assert.equal(display.nodes[0], s.nodes[0]);
    assert.equal(display.nodes.at(-1), s.nodes.at(-1));
    removed += s.nodes.length - display.nodes.length;
    display.nodes.forEach((n) => kept.add(n.id));
  }
  const drawn = new Set(route.nodes.map((n) => n.id));
  for (const edge of route.edges.filter((e) => e.kind !== "corridor"))
    for (const id of [edge.from, edge.to]) {
      if (drawn.has(id)) assert.ok(kept.has(id), id);
    }
  assert.ok(removed > 0);
});
