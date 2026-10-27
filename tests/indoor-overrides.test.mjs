import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  getIndoorDisplayGeometry,
  OPEN_CORRIDOR_PARTITIONS,
  getConfirmedHallDisplay,
  OPEN_HALL_BUFFETS,
  OPEN_HALL_PASSAGE,
} from "../src/map/indoor-overrides.js";
import { createIndoorHallDetails } from "../src/map/hall.js";

const floors = [1, 2, 3, 4].map((level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
    ),
  ),
);
const length = ({ a, b }) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function overlap(wall, opening) {
  const dx = opening.b[0] - opening.a[0],
    dz = opening.b[1] - opening.a[1],
    l = length(opening);
  const p = (point) => ({
    along:
      ((point[0] - opening.a[0]) * dx + (point[1] - opening.a[1]) * dz) / l,
    distance:
      Math.abs(
        (point[0] - opening.a[0]) * dz - (point[1] - opening.a[1]) * dx,
      ) / l,
  });
  const a = p(wall.a),
    b = p(wall.b);
  if (Math.max(a.distance, b.distance) > 0.005) return 0;
  return Math.max(
    0,
    Math.min(l, Math.max(a.along, b.along)) -
      Math.max(0, Math.min(a.along, b.along)),
  );
}
function pointOnEdge(point, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    l = Math.hypot(dx, dz);
  if (l < 1e-8) return false;
  const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (l * l);
  return (
    t >= -1e-5 &&
    t <= 1 + 1e-5 &&
    Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz) < 0.005
  );
}
function wallMeshes(walls) {
  const group = new THREE.Group();
  for (const wall of walls) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(length(wall), 2.7, 0.2),
      new THREE.MeshBasicMaterial(),
    );
    mesh.rotation.y = -Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
    mesh.position.set(
      (wall.a[0] + wall.b[0]) / 2,
      1.35,
      (wall.a[1] + wall.b[1]) / 2,
    );
    group.add(mesh);
  }
  group.updateMatrixWorld(true);
  return group;
}
const dispose = (group) =>
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });

for (const [index, sourceFloor] of floors.entries()) {
  test(`A${index + 1}: exact open partitions disappear while classroom/exterior/longitudinal boundaries remain`, () => {
    // Isolate the earlier corridor correction from the independently tested
    // 25 October entrance-hall updates on the same source level.
    const hallIds = new Set([
      "v-78-floor2-area-6",
      ...OPEN_HALL_BUFFETS.map((entry) => entry.polygonId),
    ]);
    const floor = {
      ...sourceFloor,
      polygons: sourceFloor.polygons.filter((p) => !hallIds.has(p.id)),
    };
    const original = JSON.stringify(floor);
    const display = getIndoorDisplayGeometry(floor);
    const openings = OPEN_CORRIDOR_PARTITIONS.filter(
      (opening) => opening.floorId === floor.id,
    );
    assert.equal(display.appliedOverrides.length, [4, 2, 7, 2][index]);
    assert.equal(floor.doors.length - display.doors.length, openings.length);
    for (const opening of openings) {
      for (const id of opening.sourceAreaIds) {
        const polygon = floor.polygons.find((polygon) => polygon.id === id);
        assert.equal(polygon.kind, "unclassified");
        for (const point of [opening.a, opening.b])
          assert.ok(
            polygon.points.some((a, i) =>
              pointOnEdge(
                point,
                a,
                polygon.points[(i + 1) % polygon.points.length],
              ),
            ),
            `${opening.id}: correction stops at both source circulation boundaries`,
          );
      }
      assert.ok(
        floor.walls.reduce((sum, wall) => sum + overlap(wall, opening), 0) >
          0.5,
        `${opening.id}: source has a visible cross-wall`,
      );
      assert.ok(
        display.walls.every((wall) => overlap(wall, opening) < 1e-5),
        `${opening.id}: no transverse wall remains`,
      );
      assert.ok(!display.doors.some((door) => door.id === opening.doorId));
    }
    const removedDoors = new Set(openings.map((opening) => opening.doorId));
    assert.deepEqual(
      display.doors,
      floor.doors.filter((door) => !removedDoors.has(door.id)),
      "every other door, including classroom and stair-cell doors, is preserved",
    );
    for (const wall of floor.walls)
      if (openings.every((opening) => overlap(wall, opening) < 1e-7))
        assert.ok(
          display.walls.includes(wall),
          "unrelated wall object is retained verbatim",
        );
    assert.equal(
      JSON.stringify(floor),
      original,
      "source polygons, transitions and door data are untouched",
    );

    // Independent collision check through a former solid jamb, rather than
    // through the original 80cm door gap: the visible corridor is actually open.
    const opening = openings[0];
    const walls = floor.walls.filter((wall) => overlap(wall, opening) > 0.05);
    const wall = walls.sort((a, b) => length(b) - length(a))[0];
    const center = wall.a.map((value, i) => (value + wall.b[i]) / 2);
    const normal = new THREE.Vector3(
      opening.b[1] - opening.a[1],
      0,
      opening.a[0] - opening.b[0],
    ).normalize();
    const point = new THREE.Vector3(center[0], 1.3, center[1]);
    const ray = new THREE.Raycaster(
      point.clone().addScaledVector(normal, 2),
      normal.clone().negate(),
      0,
      4,
    );
    const before = wallMeshes(walls),
      after = wallMeshes(
        display.walls.filter((wall) => overlap(wall, opening) > 0.05),
      );
    try {
      assert.ok(ray.intersectObject(before, true).length > 0);
      assert.equal(ray.intersectObject(after, true).length, 0);
    } finally {
      dispose(before);
      dispose(after);
    }
  });
}

test("a wall continuing past an explicit opening is trimmed locally; nearby parallel and crossing walls stay", () => {
  const opening = OPEN_CORRIDOR_PARTITIONS[0],
    source = floors[0];
  const direction = opening.b.map(
    (value, i) => (value - opening.a[i]) / length(opening),
  );
  const outsideA = opening.a.map((value, i) => value - direction[i] * 2);
  const outsideB = opening.b.map((value, i) => value + direction[i] * 2);
  const extension = { a: outsideA, b: outsideB, tag: "extension" };
  const reversed = { a: outsideB, b: outsideA, tag: "reversed" };
  const parallel = {
    a: opening.a.map(
      (value, i) => value + (i === 0 ? -direction[1] : direction[0]) * 0.04,
    ),
    b: opening.b.map(
      (value, i) => value + (i === 0 ? -direction[1] : direction[0]) * 0.04,
    ),
  };
  const crossing = {
    a: [opening.a[0] - 3, opening.a[1]],
    b: [opening.a[0] + 3, opening.a[1]],
  };
  const floor = {
    ...source,
    polygons: source.polygons.filter((p) =>
      opening.sourceAreaIds.includes(p.id),
    ),
    doors: source.doors.filter((door) => door.id === opening.doorId),
    walls: [extension, reversed, parallel, crossing],
  };
  const display = getIndoorDisplayGeometry(floor);
  for (const tag of ["extension", "reversed"]) {
    const parts = display.walls.filter((wall) => wall.tag === tag);
    assert.equal(parts.length, 2);
    assert.ok(
      Math.abs(parts.reduce((sum, wall) => sum + length(wall), 0) - 4) < 1e-6,
      "two metres beyond either circulation boundary remain intact",
    );
  }
  assert.ok(display.walls.includes(parallel));
  assert.ok(display.walls.includes(crossing));
});

test("unrelated floors and stale or relabelled geometry do not receive a permissive override", () => {
  const source = floors[0],
    opening = OPEN_CORRIDOR_PARTITIONS[0];
  for (const floor of [
    { ...source, id: "v-86-floor1" },
    { ...source, doors: [] },
    {
      ...source,
      polygons: source.polygons.map((p) => ({ ...p, kind: "room" })),
    },
    {
      ...source,
      doors: source.doors.map((d) => ({
        ...d,
        a: d.a.map((value) => value + 100),
        b: d.b.map((value) => value + 100),
      })),
    },
  ]) {
    const display = getIndoorDisplayGeometry(floor);
    assert.deepEqual(display.appliedOverrides, []);
    assert.equal(display.walls, floor.walls);
    assert.equal(display.doors, floor.doors);
  }
  assert.ok(opening.evidence.type.includes("user-confirmed"));
});

test("the two buffets open only toward A's corridor, preserving entrance-hall and classroom walls, the third cafeteria island and source data", () => {
  const floor = floors[1];
  const original = JSON.stringify(floor);
  const display = getIndoorDisplayGeometry(floor);
  const confirmed = getConfirmedHallDisplay(floor);
  assert.equal(confirmed.buffets.length, 2);
  assert.equal(confirmed.passage?.id, "A2-open-hall-to-A-doors");
  for (const id of ["v-78--floor-2--9z2", "v-78--floor-2--a05"]) {
    const polygon = floor.polygons.find((p) => p.id === id);
    const edges = polygon.points.map((a, i) => ({
      a,
      b: polygon.points[(i + 1) % polygon.points.length],
    }));
    assert.ok(
      edges.every((edge) =>
        floor.walls.some((wall) => overlap(wall, edge) > 0.1),
      ),
    );
    const open = confirmed.buffets.find(
      (entry) => entry.polygonId === id,
    ).openSegments;
    assert.equal(open.length, 2);
    for (const edge of edges) {
      if (open.some((opening) => overlap(edge, opening) > length(edge) - 0.005))
        assert.ok(display.walls.every((wall) => overlap(wall, edge) < 1e-6));
      else {
        const protectedWalls = floor.walls.filter(
          (wall) => overlap(wall, edge) > 0.01,
        );
        assert.ok(protectedWalls.length);
        assert.ok(
          protectedWalls.every((wall) => display.walls.includes(wall)),
          "the buffet boundary toward a classroom or unconfirmed neighbour retains its original wall",
        );
      }
    }
  }
  const island = floor.polygons.find((p) => p.id === "v-78--floor-2--9y7");
  const islandEdges = island.points.map((a, i) => ({
    a,
    b: island.points[(i + 1) % island.points.length],
  }));
  const islandWalls = floor.walls.filter((wall) =>
    islandEdges.some((edge) => overlap(wall, edge) > 0.01),
  );
  assert.ok(islandWalls.length > 10);
  assert.ok(
    islandWalls.every((wall) => display.walls.includes(wall)),
    "the separate oval island has not been interpreted as one of the two stair-side buffets",
  );
  assert.equal(JSON.stringify(floor), original);
});

test("the confirmed hall-to-A bank retains four double-door metadata and an entirely empty passage without door meshes or source changes", () => {
  const floor = floors[1],
    display = getIndoorDisplayGeometry(floor);
  const original = JSON.stringify(floor);
  const edge = {
    a: [43.735, -5.6876],
    b: [47.563, -6.1426],
  };
  const direction = new THREE.Vector3(
    edge.b[1] - edge.a[1],
    0,
    edge.a[0] - edge.b[0],
  ).normalize();
  const center = new THREE.Vector3(
    (edge.a[0] + edge.b[0]) / 2,
    1.3,
    (edge.a[1] + edge.b[1]) / 2,
  );
  const ray = new THREE.Raycaster(
    center.clone().addScaledVector(direction, 1),
    direction.clone().negate(),
    0,
    2,
  );
  const before = wallMeshes(floor.walls),
    after = wallMeshes(display.walls),
    details = createIndoorHallDetails(floor, display);
  try {
    assert.ok(ray.intersectObject(before, true).length > 0);
    assert.equal(ray.intersectObject(after, true).length, 0);
    assert.deepEqual(
      display.openDoors.map((door) => door.id),
      ["v-78-floor2-door-90"],
    );
    assert.ok(!display.doors.some((door) => door.id === "v-78-floor2-door-90"));
    assert.equal(display.doorGroup.count, 4);
    assert.equal(display.doorGroup.evidence.type, "user-confirmed-door-count");
    assert.equal(display.doorGroup.leavesPerDoor, 2);
    assert.equal(display.doorGroup.userConfirmedCount, true);
    assert.equal(display.doorGroup.rendering, "open-passages-only");
    let doorMeshes = 0;
    details.traverse((object) => {
      if (
        object.isMesh &&
        (/двер|створк|рамк|порог|threshold/iu.test(object.name) ||
          object.userData.doorModule)
      )
        doorMeshes++;
    });
    assert.equal(
      doorMeshes,
      0,
      "no frame, leaf, lintel or threshold is rendered for the door bank",
    );
    for (const [index, a] of OPEN_HALL_PASSAGE.points.slice(0, -1).entries()) {
      const segment = { a, b: OPEN_HALL_PASSAGE.points[index + 1] };
      assert.ok(
        display.walls.every((wall) => overlap(wall, segment) < 1e-6),
        "the entire shared curved boundary remains free of walls",
      );
      assert.ok(
        display.doors.every((door) => overlap(door, segment) < 1e-6),
        "no source door strip is drawn across the open boundary",
      );
    }
    assert.ok(details.getObjectByName("Буфеты · условные столы"));
    assert.ok(details.getObjectByName("Буфеты · условные стойки"));
    assert.equal(
      details.userData.furnitureStatus,
      "schematic-arrangement-not-surveyed",
    );
    assert.equal(JSON.stringify(floor), original);
  } finally {
    dispose(before);
    dispose(after);
    dispose(details);
  }
});

test("buffet walls toward А-214.1/214.2, А-213б and the entrance hall remain solid; renamed circulation is not opened as a classroom", () => {
  const floor = floors[1];
  const display = getIndoorDisplayGeometry(floor);
  const walls = wallMeshes(display.walls);
  try {
    for (const [buffetId, roomId, edgeIndex, kind] of [
      ["v-78--floor-2--9z2", "v-78--floor-2--9z8", 0, "room"],
      ["v-78--floor-2--a05", "v-78--floor-2--a0e", 0, "room"],
      ["v-78--floor-2--9z2", "v-78-floor2-area-6", 1, "unclassified"],
      ["v-78--floor-2--a05", "v-78-floor2-area-6", 4, "unclassified"],
    ]) {
      const buffet = floor.polygons.find((p) => p.id === buffetId),
        room = floor.polygons.find((p) => p.id === roomId);
      assert.equal(room.kind, kind);
      const a = buffet.points[edgeIndex],
        b = buffet.points[(edgeIndex + 1) % buffet.points.length];
      assert.ok(
        room.points.some(
          (point) => Math.hypot(point[0] - a[0], point[1] - a[1]) < 1e-5,
        ),
      );
      assert.ok(
        room.points.some(
          (point) => Math.hypot(point[0] - b[0], point[1] - b[1]) < 1e-5,
        ),
      );
      const normal = new THREE.Vector3(b[1] - a[1], 0, a[0] - b[0]).normalize();
      const midpoint = new THREE.Vector3(
        (a[0] + b[0]) / 2,
        1.3,
        (a[1] + b[1]) / 2,
      );
      const ray = new THREE.Raycaster(
        midpoint.clone().addScaledVector(normal, 1),
        normal.clone().negate(),
        0,
        2,
      );
      assert.ok(
        ray.intersectObject(walls, true).length > 0,
        `wall to ${room.label || "the entrance hall"} remains solid`,
      );
    }
  } finally {
    dispose(walls);
  }
  const renamed = {
    ...floor,
    polygons: floor.polygons.map((p) =>
      p.id === "v-78-floor2-area-24"
        ? { ...p, kind: "room", label: "А-999" }
        : p,
    ),
  };
  const renamedDisplay = getIndoorDisplayGeometry(renamed);
  const rear = { a: [35.281, -9.3526], b: [28.549, -10.6066] };
  const sourceRearWalls = floor.walls.filter(
    (wall) => overlap(wall, rear) > 0.1,
  );
  assert.ok(sourceRearWalls.length > 0);
  assert.ok(
    sourceRearWalls.every((wall) => renamedDisplay.walls.includes(wall)),
  );
});

test("buffet furniture turns west clockwise and east counterclockwise, with six contained tables each and clear circulation strips", () => {
  const floor = floors[1],
    details = createIndoorHallDetails(floor);
  try {
    const tableVertices = details
      .getObjectByName("Буфеты · условные столы")
      .geometry.getAttribute("position");
    const counterVertices = details
      .getObjectByName("Буфеты · условные стойки")
      .geometry.getAttribute("position");
    assert.equal(
      tableVertices.count,
      12 * 144,
      "twelve complete 12-sided table tops are drawn",
    );
    const contained = new Map();
    for (const [index, id] of [
      "v-78--floor-2--9z2",
      "v-78--floor-2--a05",
    ].entries()) {
      const polygon = floor.polygons.find((p) => p.id === id);
      const vectors = polygon.points.map(([x, z]) => new THREE.Vector2(x, z));
      const triangles = THREE.ShapeUtils.triangulateShape(vectors, []).map(
        (indices) =>
          new THREE.Triangle(
            ...indices.map(
              (i) => new THREE.Vector3(vectors[i].x, 0, vectors[i].y),
            ),
          ),
      );
      const inside = (point) =>
        triangles.some((triangle) =>
          triangle.containsPoint(new THREE.Vector3(point.x, 0, point.z)),
        );
      let count = 0;
      for (let i = 0; i < tableVertices.count; i++)
        if (inside(new THREE.Vector3().fromBufferAttribute(tableVertices, i)))
          count++;
      contained.set(id, count);
      assert.equal(
        count,
        6 * 144,
        "all six whole table tops stay inside this buffet, outside the circulation and adjacent classrooms",
      );
      const counterPoints = Array.from({ length: 36 }, (_, i) =>
        new THREE.Vector3().fromBufferAttribute(
          counterVertices,
          index * 36 + i,
        ),
      );
      assert.ok(
        counterPoints.every(inside),
        "the rotated counter stays in its source buffet",
      );
      const actualCenter = counterPoints
        .reduce((sum, point) => sum.add(point), new THREE.Vector3())
        .multiplyScalar(1 / 36);
      const front = index === 0 ? 1 : 4;
      const a = polygon.points[front],
        b = polygon.points[(front + 1) % polygon.points.length];
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        l = Math.hypot(dx, dz);
      const originalCenter = [
        (a[0] + b[0]) / 2 + (dz / l) * 1.15,
        (a[1] + b[1]) / 2 - (dx / l) * 1.15,
      ];
      const offset = originalCenter.map(
        (value, i) => value - polygon.center[i],
      );
      const sign = index === 0 ? 1 : -1;
      assert.ok(
        Math.hypot(
          actualCenter.x - polygon.center[0] + sign * offset[1],
          actualCenter.z - polygon.center[1] - sign * offset[0],
        ) < 0.0001,
        "actual counter geometry follows the requested signed quarter-turn",
      );
      const furniture = details.userData.buffets[index];
      assert.equal(furniture.tableCenters.length, 6);
      for (const center of furniture.tableCenters)
        for (const edge of getConfirmedHallDisplay(floor).buffets[index]
          .openSegments) {
          const dx = edge.b[0] - edge.a[0],
            dz = edge.b[1] - edge.a[1];
          const distance =
            Math.abs(
              (center[0] - edge.a[0]) * dz - (center[1] - edge.a[1]) * dx,
            ) / Math.hypot(dx, dz);
          assert.ok(
            distance - furniture.tableRadius >= 0.75,
            "a schematic strip remains free at the buffet/circulation boundary",
          );
        }
    }
    assert.equal(
      [...contained.values()].reduce((sum, value) => sum + value, 0),
      tableVertices.count,
    );
  } finally {
    dispose(details);
  }
});

test("hall overrides require their exact source cells, contours and known door; another campus or altered source is not opened", () => {
  const floor = floors[1];
  for (const changed of [
    { ...floor, id: "v-86-floor2" },
    { ...floor, polygons: floor.polygons.map((p) => ({ ...p, kind: "room" })) },
    {
      ...floor,
      polygons: floor.polygons.map((p) => ({
        ...p,
        points: p.points.map(([x, z]) => [x + 1, z]),
      })),
    },
  ]) {
    assert.deepEqual(getConfirmedHallDisplay(changed), {
      buffets: [],
      passage: null,
    });
  }
  assert.equal(getConfirmedHallDisplay({ ...floor, doors: [] }).passage, null);
  const boundaries = [
    ...OPEN_CORRIDOR_PARTITIONS.filter((entry) => entry.floorId === floor.id),
    ...getConfirmedHallDisplay(floor).buffets.flatMap(
      (entry) => entry.openSegments,
    ),
    ...OPEN_HALL_PASSAGE.points
      .slice(0, -1)
      .map((a, i) => ({ a, b: OPEN_HALL_PASSAGE.points[i + 1] })),
  ];
  const display = getIndoorDisplayGeometry(floor);
  for (const wall of floor.walls)
    if (boundaries.every((edge) => overlap(wall, edge) < 1e-7))
      assert.ok(
        display.walls.includes(wall),
        "every unrelated wall remains the original object",
      );
  const removedDoorIds = new Set([
    "v-78-floor2-door-9",
    "v-78-floor2-door-46",
    "v-78-floor2-door-68",
    "v-78-floor2-door-90",
    "v-78-floor2-door-30",
    "v-78-floor2-door-33",
  ]);
  assert.deepEqual(
    display.doors,
    floor.doors.filter((door) => !removedDoorIds.has(door.id)),
  );
});
