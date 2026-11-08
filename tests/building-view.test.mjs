import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getBuildingFloorView,
  getBuildingScopePolygonIds,
  getBuildingScopePoints,
  restrictFloorDisplayBounds,
} from "../src/map/building-view.js";

const rect = (x, z, width, height) => ({
  points: [
    [x, z],
    [x + width, z],
    [x + width, z + height],
    [x, z + height],
  ],
  holes: [],
});
const floor2 = JSON.parse(
  readFileSync(
    new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    "utf8",
  ),
);

test("A2 removes the entire separate I component without changing source geometry or navigation", () => {
  const original = JSON.stringify(floor2);
  const sourceTransitions = floor2.transitions.length;
  const view = getBuildingFloorView(floor2, "А");
  assert.equal(view.footprints.length, 1);
  assert.ok(floor2.exteriorFootprints.includes(view.footprints[0]));
  assert.ok(view.polygons.every((p) => p.exteriorEligible !== false));
  assert.ok(!view.polygons.some((p) => p.building === "И"));
  for (const id of [
    "v-78-floor2-area-327",
    "v-78-floor2-area-328",
    "v-78-floor2-area-331",
    "v-78-floor2-area-335",
    "v-78-floor2-area-340",
  ])
    assert.ok(!view.polygons.some((p) => p.id === id), id);
  for (const id of [
    "v-78-floor2-area-6",
    "v-78-floor2-area-24",
    "v-78-floor2-area-29",
    "v-78-floor2-area-56",
    "v-78--floor-2--9yb",
    "v-78--floor-2--9yc",
  ])
    assert.equal(
      view.polygons.find((p) => p.id === id),
      floor2.polygons.find((p) => p.id === id),
      id,
    );
  assert.ok(view.walls.length < floor2.walls.length);
  assert.ok(view.doors.length < floor2.doors.length);
  assert.equal(floor2.transitions.length, sourceTransitions);
  assert.equal(JSON.stringify(floor2), original);
});

test("separate-component filtering includes rotated borders, excludes all local display features, and retains courtyard holes", () => {
  const rotate = ([x, y]) => [(x - y) / Math.SQRT2, (x + y) / Math.SQRT2];
  const transform = (polygon) => ({
    ...polygon,
    points: polygon.points.map(rotate),
    holes: polygon.holes.map((ring) => ring.map(rotate)),
  });
  const own = transform({
    ...rect(0, 0, 30, 30),
    holes: [rect(10, 10, 10, 10).points],
  });
  const foreign = transform(rect(10, 10, 10, 10));
  const boundary = rotate([10, 15]);
  const source = {
    footprints: [own, foreign],
    polygons: [
      { id: "A", building: "А", ...transform(rect(1, 1, 3, 3)) },
      { id: "I", building: "И", ...transform(rect(12, 12, 3, 3)) },
      { id: "unlabelled-I", ...transform(rect(16, 12, 3, 3)) },
    ],
    walls: [
      { id: "I-wall", a: boundary, b: rotate([10, 18]) },
      { id: "A-wall", a: rotate([0, 0]), b: rotate([5, 0]) },
    ],
    doors: [{ id: "I-door", a: rotate([10, 16]), b: rotate([10, 17]) }],
    markers: [
      { id: "I-stair-boundary", position: boundary },
      { id: "A-stair", position: rotate([2, 2]) },
    ],
    transitions: [
      { id: "I-edge", point: rotate([13, 13]) },
      { id: "A-edge", position: rotate([2, 2]) },
    ],
  };
  const before = JSON.stringify(source);
  const view = getBuildingFloorView(source, "А");
  assert.deepEqual(
    view.polygons.map((p) => p.id),
    ["A"],
  );
  assert.deepEqual(
    view.walls.map((p) => p.id),
    ["A-wall"],
  );
  assert.equal(view.doors.length, 0);
  assert.deepEqual(
    view.markers.map((p) => p.id),
    ["A-stair"],
  );
  assert.deepEqual(
    view.transitions.map((p) => p.id),
    ["A-edge"],
  );
  assert.equal(view.footprints[0].holes.length, 1);
  assert.equal(JSON.stringify(source), before);
});

test("shared and unknown components remain intact, and no selection returns the source", () => {
  const shared = rect(0, 0, 20, 10);
  const unknown = rect(30, 0, 5, 5);
  const source = {
    footprints: [shared, unknown],
    polygons: [
      { id: "A", building: "А", ...rect(1, 1, 3, 3) },
      { id: "B", building: "Б", ...rect(10, 1, 3, 3) },
    ],
  };
  assert.equal(getBuildingFloorView(source, "А"), source);
  assert.equal(getBuildingFloorView(source, null), source);
});

test("A2 scope adds complete native A corridors only while their exact adjacency remains A-only", () => {
  const ids = getBuildingScopePolygonIds(floor2, "А");
  for (const id of ["v-78-floor2-area-29", "v-78-floor2-area-56"])
    assert.ok(ids.has(id));
  assert.ok(!ids.has("v-78-floor2-area-331"));
  assert.ok(
    !getBuildingScopePolygonIds({ ...floor2, id: "v-78-floor3" }, "А").has(
      "v-78-floor2-area-29",
    ),
  );
  assert.ok(
    !getBuildingScopePolygonIds(floor2, "И").has("v-78-floor2-area-29"),
  );
  const corridor = floor2.polygons.find((p) => p.id === "v-78-floor2-area-29");
  const neighbour = floor2.polygons.find((p) => p.label === "А-203");
  const altered = {
    ...floor2,
    polygons: floor2.polygons.map((p) =>
      p === neighbour ? { ...p, building: "Б" } : p,
    ),
  };
  assert.ok(!getBuildingScopePolygonIds(altered, "А").has(corridor.id));
  const changedType = {
    ...floor2,
    polygons: floor2.polygons.map((p) =>
      p === corridor ? { ...p, kind: "outdoor" } : p,
    ),
  };
  assert.ok(!getBuildingScopePolygonIds(changedType, "А").has(corridor.id));
});

test("E2 uses the complete existing indoor component, including unnamed labs and the real opening", () => {
  const before = JSON.stringify(floor2);
  const view = getBuildingFloorView(floor2, "Е");
  assert.equal(view.footprints.length, 1);
  const footprint = view.footprints[0];
  assert.ok(floor2.exteriorFootprints.includes(footprint));
  assert.equal(footprint.holes.length, 1);
  for (const id of [
    "v-78-floor2-area-350",
    "v-78-floor2-area-354",
    "v-78-floor2-area-450",
    "v-78-floor2-area-453",
  ])
    assert.ok(
      view.polygons.some((polygon) => polygon.id === id),
      id,
    );
  assert.ok(
    !view.polygons.some(
      (polygon) => polygon.building && polygon.building !== "Е",
    ),
  );
  assert.ok(
    view.polygons.every((polygon) => polygon.exteriorEligible !== false),
  );
  const points = getBuildingScopePoints(floor2, "Е");
  for (const point of footprint.points) assert.ok(points.includes(point));
  assert.deepEqual(
    [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
    ],
    [-267.814, -9.5336, -189.072, 54.5674],
  );
  assert.equal(JSON.stringify(floor2), before);
});

test("display-bounds rejection keeps crossing shapes and preserves their holes and source segments", () => {
  const polygon = {
    id: "crossing",
    ...rect(-20, -1, 40, 2),
    holes: [rect(-1, -0.5, 2, 1).points],
  };
  const wall = { a: [-20, 0], b: [20, 0] };
  const source = {
    footprints: [polygon, rect(30, 30, 5, 5)],
    polygons: [polygon],
    walls: [wall, { a: [30, 30], b: [35, 35] }],
    doors: [],
    markers: [{ position: [0, 0] }, { position: [30, 30] }],
  };
  const view = restrictFloorDisplayBounds(source, [-2, -2, 2, 2]);
  assert.equal(view.polygons[0], polygon);
  assert.equal(view.footprints[0], polygon);
  assert.deepEqual(view.walls, [wall]);
  assert.equal(view.markers.length, 1);
  assert.equal(source.walls.length, 2);
});

test("E1 keeps the already visible separate ЛК3 source island whole without assigning its building", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor1.json", import.meta.url),
    ),
  );
  const island = floor.polygons.find(
    (polygon) => polygon.id === "v-78--floor-1--6lv",
  );
  assert.equal(island.building, null);
  const points = getBuildingScopePoints(floor, "Е");
  for (const point of island.points)
    assert.ok(points.some((p) => p[0] === point[0] && p[1] === point[1]));
  assert.equal(island.building, null);
});
