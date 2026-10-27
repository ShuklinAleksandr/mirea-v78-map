import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildingAtPoint, convexHull } from "../src/data/spatial.js";
const read = (path) =>
  JSON.parse(
    readFileSync(new URL(`../public${path}`, import.meta.url), "utf8"),
  );
const manifest = read("/data/manifest.json");
const campus = manifest.campuses.find((c) => c.id === "v-78");
const floors = campus.floors.map((f) => read(f.url));

for (const label of ["А-101-9", "А-173", "А-142в"]) {
  test(`clicking ${label} selects its elongated building A instead of a nearer neighboring centroid`, () => {
    const room = floors
      .flatMap((f) => f.polygons)
      .find((p) => p.label === label);
    assert.ok(
      room?.center,
      "regression room must exist in the real source data",
    );
    assert.equal(buildingAtPoint(floors, room.center), "А");
  });
}
const box = (x, z, width, depth) => [
  [x, z],
  [x + width, z],
  [x + width, z + depth],
  [x, z + depth],
];
test("a courtyard hole does not count as a room and uses the nearest actual boundary", () => {
  const fixture = [
    {
      level: 1,
      polygons: [
        { building: "А", points: box(0, 0, 10, 10), holes: [box(3, 3, 4, 4)] },
        { building: "Б", points: box(4, 4, 2, 2), holes: [] },
      ],
    },
  ];
  assert.equal(
    buildingAtPoint(fixture, [3.8, 5]),
    "Б",
    "point lies in A courtyard, closer to B edge",
  );
  assert.equal(buildingAtPoint(fixture, [2.9, 5]), "А", "point lies in A body");
  assert.equal(
    buildingAtPoint(fixture, [3, 5]),
    "А",
    "courtyard boundary belongs to its wall",
  );
});
test("nearest-edge fallback handles long buildings and ignores unassigned polygons", () => {
  const fixture = [
    {
      level: 1,
      polygons: [
        { building: "А", points: box(0, 0, 100, 5) },
        { building: "Б", points: box(3, 15, 3, 3) },
        { points: box(0, 5, 10, 10) },
      ],
    },
  ];
  assert.equal(buildingAtPoint(fixture, [2, 7]), "А");
  assert.equal(buildingAtPoint([], [2, 7]), null);
  assert.equal(buildingAtPoint(fixture, [NaN, 7]), null);
});
test("overlapping footprints use the upper source level without changing the data", () => {
  const fixture = [
    { level: 1, polygons: [{ building: "А", points: box(0, 0, 5, 5) }] },
    { level: 2, polygons: [{ building: "Б", points: box(0, 0, 5, 5) }] },
  ];
  const snapshot = JSON.stringify(fixture);
  assert.equal(buildingAtPoint(fixture, [2, 2]), "Б");
  assert.equal(JSON.stringify(fixture), snapshot);
});
test("convex hull keeps the four rotated corners in CCW order and excludes box corners", () => {
  const points = [
    [0, 2],
    [2, 0],
    [0, -2],
    [-2, 0],
    [0, 0],
    [1, 1],
    [0, 2],
  ];
  const before = JSON.stringify(points),
    hull = convexHull(points);
  assert.equal(hull.length, 4);
  assert.equal(JSON.stringify(points), before);
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length],
      c = hull[(i + 2) % hull.length];
    assert.ok(
      (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0,
    );
  }
  assert.ok(
    hull.some((a, i) => {
      const b = hull[(i + 1) % hull.length];
      return (b[0] - a[0]) * (1.9 - a[1]) - (b[1] - a[1]) * (1.9 - a[0]) < 0;
    }),
    "a rotated box corner must be outside at least one hull half-plane",
  );
  assert.deepEqual(
    convexHull([
      [0, 0],
      [1, 0],
      [2, 0],
    ]),
    [
      [0, 0],
      [2, 0],
    ],
  );
});
