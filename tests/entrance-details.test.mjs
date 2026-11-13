import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import polygonClipping from "polygon-clipping";
import { getEntranceLayout } from "../src/map/entrance-layout.js";
import { createEntranceDetails } from "../src/map/entrance-details.js";
import { getIndoorDisplayGeometry } from "../src/map/indoor-overrides.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";

const source = JSON.parse(
  readFileSync(
    new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
  ),
);
const polygon = (id) => source.polygons.find((p) => p.id === id);
const hall = polygon("v-78-floor2-area-6"),
  entrance = polygon("v-78--floor-2--9yb"),
  leftRoom = polygon("v-78-floor2-area-9");
const rings = (p) => [p.points, ...p.holes];
const footprint = (part) => {
  const normal = [-part.along[1], part.along[0]];
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) =>
    part.center.map(
      (value, i) =>
        value +
        (part.along[i] * u * part.length) / 2 +
        (normal[i] * v * part.depth) / 2,
    ),
  );
};
const dispose = (group) =>
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
const distanceAlong = (point, anchor, axis) =>
  (point[0] - anchor[0]) * axis[0] + (point[1] - anchor[1]) * axis[1];

test("entrance sequence keeps the enclosed source vestibule before frames and security after frames, without inventing a guard-room entrance", () => {
  const before = JSON.stringify(source);
  for (const floor of [source, getHallAdjacencyView(source)]) {
    const layout = getEntranceLayout(floor);
    assert.deepEqual(layout.sequence, [
      "doors",
      "detectors",
      "turnstiles",
      "hall",
    ]);
    assert.deepEqual(layout.front, {
      a: [43.5, 38.5824],
      b: [55.565, 39.2074],
    });
    assert.deepEqual(layout.inner, {
      a: [43.352, 34.2784],
      b: [56.252, 34.9524],
    });
    for (const center of layout.detectors.centers)
      assert.ok(
        Math.abs(distanceAlong(center, layout.inner.a, layout.innerInside)) <
          1e-10,
      );
    for (const center of layout.turnstiles.centers)
      assert.ok(
        Math.abs(
          distanceAlong(center, layout.inner.a, layout.innerInside) - 1.6,
        ) < 1e-10,
      );
    const desk = layout.guard;
    assert.equal(desk.sourcePolygonId, hall.id);
    assert.equal(desk.publicEntrance, false);
    assert.equal(desk.rotationFromDoorBankDegrees, -90);
    const depth = distanceAlong(
      desk.center,
      layout.inner.a,
      layout.innerInside,
    );
    assert.ok(
      depth - desk.deskLength / 2 > 0,
      "desk begins after detector boundary",
    );
    assert.ok(
      Math.abs(
        depth + desk.deskLength / 2 - layout.turnstiles.depthAfterInnerBoundary,
      ) < 1e-10,
      "desk ends at the bank instead of protruding behind it",
    );
    assert.ok(
      distanceAlong(desk.center, layout.inner.a, layout.innerAlong) < 0,
      "desk is left of frame bank",
    );
    assert.equal(
      layout.countStatus,
      "representative-display-count-not-surveyed",
    );
    assert.equal(layout.routingStatus, "display-only-source-graph-unchanged");
    assert.deepEqual(
      floor.polygons.find((p) => p.id === leftRoom.id),
      leftRoom,
      "the unrelated small room stays unnamed and unaltered",
    );
  }
  assert.equal(JSON.stringify(source), before);
});

test("the dense turnstile bank joins the desk to the nearest right-hand entrance wall, without crossing the hall to the buffet", () => {
  for (const floor of [source, getHallAdjacencyView(source)]) {
    const layout = getEntranceLayout(floor);
    const { turnstiles: bank, guard } = layout;
    assert.deepEqual(
      [bank.boundary.wall.a, bank.boundary.wall.b].sort((a, b) => a[0] - b[0]),
      [
        [56.252, 34.9524],
        [57.526, 33.0644],
      ],
    );
    assert.ok(bank.boundary.across < layout.innerWidth + 2);
    assert.ok(bank.count > 3 && bank.count <= 20);
    assert.ok(bank.pitch >= 0.8 && bank.pitch <= 1);
    assert.equal(bank.postCenters.length, bank.count + 1);
    const across = (point) =>
      distanceAlong(point, layout.inner.a, layout.innerAlong);
    assert.ok(
      Math.abs(
        across(bank.start) - across(guard.center) - guard.deskDepth / 2,
      ) < 1e-10,
      "bank begins against the right side of the security desk",
    );
    assert.ok(
      bank.boundary.across - across(bank.end) < 0.15,
      "final post reaches the sloping wall without a large end gap",
    );
    for (let i = 1; i < bank.postCenters.length; i++)
      assert.ok(
        Math.abs(
          across(bank.postCenters[i]) -
            across(bank.postCenters[i - 1]) -
            bank.pitch,
        ) < 1e-10,
        "adjacent passages share one post at a consistent dense pitch",
      );
    const group = createEntranceDetails(floor);
    try {
      const posts = group.userData.parts.filter(
        (part) => part.kind === "turnstile-post",
      );
      const arms = group.userData.parts.filter(
        (part) => part.kind === "turnstile-arm",
      );
      assert.equal(posts.length, bank.count + 1);
      assert.equal(arms.length, bank.count);
      for (let i = 0; i < arms.length; i++) {
        assert.ok(
          Math.abs(
            across(arms[i].center) -
              arms[i].length / 2 -
              (across(posts[i].center) + posts[i].length / 2),
          ) < 1e-10,
        );
        assert.ok(
          Math.abs(
            across(arms[i].center) +
              arms[i].length / 2 -
              (across(posts[i + 1].center) - posts[i + 1].length / 2),
          ) < 1e-10,
        );
      }
    } finally {
      dispose(group);
    }
  }
});

test("only the two confirmed cross-wall banks open; both vestibule sides and the entire adjacent room remain intact", () => {
  const base = getIndoorDisplayGeometry({
    ...source,
    polygons: source.polygons.filter((p) => p.id !== entrance.id),
  });
  const display = getIndoorDisplayGeometry(source);
  const displayWalls = new Set(
    display.walls.map((wall) => JSON.stringify(wall)),
  );
  const removed = base.walls.filter(
    (wall) => !displayWalls.has(JSON.stringify(wall)),
  );
  assert.equal(
    removed.length,
    4,
    "two source wall fragments per door/frame bank",
  );
  const isOn = (point, a, b) =>
    Math.abs(
      (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]),
    ) < 0.002;
  for (const wall of removed)
    assert.ok(
      [
        [entrance.points[0], entrance.points[1]],
        [entrance.points[3], entrance.points[2]],
      ].some(([a, b]) => isOn(wall.a, a, b) && isOn(wall.b, a, b)),
    );
  for (const wall of base.walls) {
    if (!removed.includes(wall))
      assert.ok(displayWalls.has(JSON.stringify(wall)));
  }
  assert.deepEqual(
    base.doors
      .filter((door) => !display.doors.includes(door))
      .map((d) => d.id)
      .sort(),
    ["v-78-floor2-door-422", "v-78-floor2-door-93"],
  );
  assert.ok(
    display.doors.some((d) => d.id === "v-78-floor2-door-92"),
    "existing vestibule side door is retained",
  );
  assert.equal(
    display.doorGroup.count,
    4,
    "the earlier hall-to-A bank remains independent",
  );
  assert.equal(display.doorGroup.rendering, "open-passages-only");
});

test("untextured entrance landmarks fit retained source areas and use only two batches in 3D and 2D", () => {
  for (const plan of [false, true]) {
    const group = createEntranceDetails(source, { plan });
    try {
      assert.equal(group.children.length, 2);
      assert.equal(
        group.userData.parts.filter((p) => p.kind === "open-double-door-leaf")
          .length,
        10,
      );
      for (const part of group.userData.parts) {
        const shape = [footprint(part)];
        if (
          part.kind.startsWith("security") ||
          part.kind.startsWith("turnstile")
        ) {
          assert.deepEqual(
            polygonClipping.difference(shape, rings(hall)),
            [],
            part.kind + " stays inside the existing hall",
          );
          assert.deepEqual(
            polygonClipping.intersection(shape, rings(leftRoom)),
            [],
            part.kind + " does not occupy the unrelated small room",
          );
        } else if (
          part.kind.startsWith("door") ||
          part.kind === "open-double-door-leaf"
        ) {
          assert.deepEqual(
            polygonClipping.difference(shape, rings(entrance)),
            [],
            part.kind + " stays inside the vestibule",
          );
        } else {
          assert.deepEqual(
            polygonClipping.difference(
              shape,
              polygonClipping.union(rings(hall), rings(entrance)),
            ),
            [],
            part.kind + " remains at the shared frame boundary",
          );
        }
      }
      const vertices = group.children.reduce(
        (n, m) => n + m.geometry.attributes.position.count,
        0,
      );
      assert.ok(vertices / 3 <= 1000, "bounded lightweight geometry");
      for (const mesh of group.children) {
        assert.equal(mesh.castShadow, false);
        assert.equal(mesh.receiveShadow, false);
        assert.equal(mesh.material.map, null);
        assert.equal(mesh.geometry.attributes.uv, undefined);
        assert.ok(
          [...mesh.geometry.attributes.position.array].every(Number.isFinite),
        );
        if (plan) {
          assert.equal(mesh.material.type, "MeshBasicMaterial");
          const values = mesh.geometry.attributes.position.array;
          for (let i = 1; i < values.length; i += 3)
            assert.ok(
              values[i] >= 0.18 && values[i] <= 0.19,
              "2D landmarks are flat and do not restore 3D geometry",
            );
        }
      }
    } finally {
      dispose(group);
    }
  }
});

test("changed source identities or unavailable furniture space fail closed instead of erasing walls or relocating security", () => {
  const altered = structuredClone(source);
  altered.polygons
    .find((p) => p.id === hall.id)
    .holes.push([
      [42, 31],
      [44, 31],
      [44, 34.5],
      [42, 34.5],
    ]);
  const noLocalWall = structuredClone(source);
  const changedHall = noLocalWall.polygons.find((p) => p.id === hall.id);
  changedHall.points = changedHall.points.map((point) =>
    [57.526, 60.303, 63.232].includes(point[0]) ? [point[0], 35.5] : point,
  );
  const cases = [
    { ...source, campusId: "v-86" },
    { ...source, id: "v-78-floor1" },
    { ...source, units: "pixels" },
    {
      ...source,
      doors: source.doors.filter((d) => d.id !== "v-78-floor2-door-422"),
    },
    {
      ...source,
      doors: source.doors.map((d) =>
        d.id === "v-78-floor2-door-93" ? { ...d, source: "unknown" } : d,
      ),
    },
    {
      ...source,
      polygons: source.polygons.map((p) =>
        p.id === entrance.id ? { ...p, kind: "room" } : p,
      ),
    },
    {
      ...source,
      polygons: source.polygons.map((p) =>
        p.id === leftRoom.id
          ? { ...p, points: p.points.map(([x, z]) => [x + 0.2, z]) }
          : p,
      ),
    },
    altered,
    noLocalWall,
  ];
  for (const floor of cases) {
    assert.equal(getEntranceLayout(floor), null);
    assert.equal(createEntranceDetails(floor).children.length, 0);
    assert.ok(
      !getIndoorDisplayGeometry(floor).appliedOverrides.includes(
        "main-entrance-door-bank",
      ),
    );
  }
});
