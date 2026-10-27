import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import adjacency from "../src/data/hall-adjacency.json" with { type: "json" };
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import { getConfirmedHallDisplay } from "../src/map/indoor-overrides.js";

const source = JSON.parse(
  readFileSync(
    new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    "utf8",
  ),
);
const rings = (polygon) => [polygon.points, ...(polygon.holes || [])];
const area = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
const multiArea = (polygons) =>
  polygons.reduce(
    (sum, polygon) =>
      sum +
      area(polygon[0]) -
      polygon.slice(1).reduce((holes, ring) => holes + area(ring), 0),
    0,
  );
const onBoundary = (point) => {
  const [a, b] = adjacency.buffetBoundary;
  return (
    Math.abs(
      (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]),
    ) < 1e-7
  );
};

test("hall adjacency view preserves source, doors, centres and untouched places while closing the confirmed strip", () => {
  const before = JSON.stringify(source);
  const view = getHallAdjacencyView(source);
  assert.notEqual(view, source);
  assert.equal(view.doors, source.doors);
  assert.equal(view.markers, source.markers);
  assert.equal(view.transitions, source.transitions);
  for (const id of adjacency.roomIds) {
    const room = view.polygons.find((p) => p.id === id),
      old = source.polygons.find((p) => p.id === id);
    assert.equal(room.center, old.center);
    assert.equal(room.geometryStatus, "user-adjacency-approximate-dimensions");
    assert.equal(room.displayEvidence.dimensions, "model-only-not-surveyed");
    for (let i = 0; i < old.points.length; i++) {
      const index = adjacency.oldVertices
        .slice(0, 4)
        .findIndex(
          (p) =>
            Math.hypot(p[0] - old.points[i][0], p[1] - old.points[i][1]) < 1e-7,
        );
      if (index >= 0) {
        const projected = room.points.find(
          (point) =>
            Math.hypot(
              point[0] - adjacency.projectedVertices[index][0],
              point[1] - adjacency.projectedVertices[index][1],
            ) < 1e-7,
        );
        assert.ok(
          projected,
          "the projected rear corner still reaches the buffet",
        );
        assert.ok(onBoundary(projected));
      } else
        assert.ok(
          room.points.includes(old.points[i]),
          "front vertices and door-facing edges stay put",
        );
    }
  }
  const affected = new Set([...adjacency.roomIds, adjacency.hallPolygonId]);
  for (const polygon of source.polygons.filter((p) => !affected.has(p.id)))
    assert.equal(
      view.polygons.find((p) => p.id === polygon.id),
      polygon,
    );
  assert.equal(JSON.stringify(source), before);
  assert.equal(
    getHallAdjacencyView(source),
    view,
    "immutable input can reuse its display result",
  );
  assert.equal(
    getHallAdjacencyView(view),
    view,
    "an applied display is not transformed twice",
  );
});

test("clipped room corners stay on the original slab without changing its exterior or courtyard holes", () => {
  const view = getHallAdjacencyView(source);
  assert.equal(view.footprints, source.footprints);
  for (const id of adjacency.roomIds) {
    const room = view.polygons.find((polygon) => polygon.id === id);
    assert.ok(
      multiArea(
        polygonClipping.difference(rings(room), source.footprints.map(rings)),
      ) < 1e-7,
      id,
    );
    assert.ok(
      room.points.some(onBoundary),
      "each cell reaches the existing buffet boundary",
    );
    if (id !== "v-78-floor2-area-4")
      assert.ok(
        room.points.filter(onBoundary).length >= 2,
        "the first three rear edges adjoin the buffet along a nonzero segment",
      );
  }
  const leftRoom = view.polygons.find(
    (polygon) => polygon.id === "v-78-floor2-area-3",
  );
  assert.ok(
    leftRoom.points.length > 4,
    "the left corner is clipped instead of expanding the source footprint",
  );
});

test("boolean hall difference has no overlap with expanded rooms, retains the right ATM pocket and original door group", () => {
  const view = getHallAdjacencyView(source);
  const halls = view.polygons.filter(
    (p) => p.sourcePolygonId === adjacency.hallPolygonId,
  );
  assert.equal(
    halls.length,
    2,
    "retain the small detached pocket explicitly instead of a self-overlapping ring",
  );
  assert.equal(halls[0].id, adjacency.hallPolygonId);
  assert.equal(halls[1].roomId, adjacency.hallPolygonId);
  for (const roomId of adjacency.roomIds) {
    const room = view.polygons.find((p) => p.id === roomId);
    for (const hall of halls)
      assert.ok(
        multiArea(polygonClipping.intersection(rings(hall), rings(room))) <
          1e-7,
        roomId,
      );
  }
  // Right-hand wedge stays available beside the four cells; no bank-device
  // count or physical measurement is inferred from this model point.
  const pocket = [
    [
      [38.4, -2.3],
      [38.5, -2.3],
      [38.5, -2.2],
      [38.4, -2.2],
    ],
  ];
  assert.ok(
    multiArea(polygonClipping.intersection(rings(halls[0]), pocket)) > 0.009,
  );
  const rightmost = view.polygons.find((p) => p.id === "v-78-floor2-area-4");
  assert.ok(rightmost.points.some((p) => p[0] === 41.194 && p[1] === -0.4286));
  assert.ok(
    getConfirmedHallDisplay(view).passage,
    "the four confirmed open doors keep their exact shared source boundary",
  );
  assert.equal(
    getConfirmedHallDisplay(view).buffets.length,
    2,
    "both source buffet contours keep their confirmed open corridor boundaries",
  );
});

test("corrected hall and all four rooms triangulate to their finite positive polygon areas", () => {
  const view = getHallAdjacencyView(source);
  const changed = view.polygons.filter((p) => p.displayEvidence);
  for (const polygon of changed) {
    const shape = new THREE.Shape(
      polygon.points.map(([x, z]) => new THREE.Vector2(x, z)),
    );
    for (const hole of polygon.holes || [])
      shape.holes.push(
        new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, z))),
      );
    const geometry = new THREE.ShapeGeometry(shape);
    try {
      const coordinates = geometry.getAttribute("position");
      assert.ok([...coordinates.array].every(Number.isFinite), polygon.id);
      const triangles = geometry.getIndex().array;
      let triangleArea = 0;
      for (let i = 0; i < triangles.length; i += 3) {
        const p = [0, 1, 2].map((offset) => [
          coordinates.getX(triangles[i + offset]),
          coordinates.getY(triangles[i + offset]),
        ]);
        triangleArea += area(p);
      }
      const expected = multiArea([rings(polygon)]);
      assert.ok(
        expected > 0 &&
          Math.abs(triangleArea - expected) <
            Math.max(0.001, expected * 0.00001),
        `${polygon.id}: triangles ${triangleArea}, polygon ${expected}`,
      );
    } finally {
      geometry.dispose();
    }
  }
});

test("walls follow the corrected rear vertices without moving front doors or duplicating buffet wall subsegments", () => {
  const view = getHallAdjacencyView(source);
  const contains = (point, a, b) =>
    Math.hypot(point[0] - a[0], point[1] - a[1]) +
      Math.hypot(point[0] - b[0], point[1] - b[1]) -
      Math.hypot(a[0] - b[0], a[1] - b[1]) <
    1e-7;
  const [a, b] = adjacency.buffetBoundary;
  const buffetWalls = view.walls.filter(
    (wall) => contains(wall.a, a, b) && contains(wall.b, a, b),
  );
  assert.equal(buffetWalls.length, 1);
  assert.ok(
    view.walls.some(
      (wall) => wall.geometryStatus === "user-adjacency-approximate-dimensions",
    ),
  );
  for (const door of source.doors)
    assert.equal(
      view.doors.find((candidate) => candidate.id === door.id),
      door,
    );
  const side = source.walls.find(
    (wall) =>
      wall.a[0] === 27.009 &&
      wall.a[1] === 1.5954 &&
      wall.b[0] === 28.425 &&
      wall.b[1] === 6.7994,
  );
  assert.ok(
    view.walls.includes(side),
    "the old left exterior side is retained instead of projecting it outside the slab",
  );
  const ringContains = (point, ring) => {
    if (ring.some((a, i) => contains(point, a, ring[(i + 1) % ring.length])))
      return 0;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j],
        b = ring[i];
      if (
        a[1] > point[1] !== b[1] > point[1] &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
    return inside ? 1 : -1;
  };
  for (const wall of view.walls.filter((wall) => wall.displayEvidence)) {
    assert.ok([...wall.a, ...wall.b].every(Number.isFinite));
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const p = wall.a.map((value, j) => value + (wall.b[j] - value) * t);
      assert.ok(
        source.footprints.some(
          (footprint) =>
            ringContains(p, footprint.points) >= 0 &&
            !footprint.holes.some((hole) => ringContains(p, hole) > 0),
        ),
        "corrected wall stays on the known source slab, including the clipped left corner",
      );
    }
  }
});

test("hall adjacency guard rejects missing identities, changed source coordinates and other floors", () => {
  const wrongFloor = { ...source, id: "v-78-floor1" };
  assert.equal(getHallAdjacencyView(wrongFloor), wrongFloor);
  const wrongCampus = { ...source, campusId: "s-20" };
  assert.equal(getHallAdjacencyView(wrongCampus), wrongCampus);
  const missing = {
    ...source,
    polygons: source.polygons.filter((p) => p.id !== adjacency.roomIds[0]),
  };
  assert.equal(getHallAdjacencyView(missing), missing);
  const changed = {
    ...source,
    polygons: source.polygons.map((p) =>
      p.id === adjacency.roomIds[0]
        ? { ...p, points: p.points.map(([x, z]) => [x + 0.1, z]) }
        : p,
    ),
  };
  assert.equal(getHallAdjacencyView(changed), changed);
});
