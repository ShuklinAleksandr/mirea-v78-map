import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getStairPartitionView,
  STAIR_PARTITION_MODEL,
} from "../src/map/stair-partitions.js";
import { getIndoorDisplayGeometry } from "../src/map/indoor-overrides.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import { getBuildingFloorView } from "../src/map/building-view.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const readFloor = (level) =>
  read(`../public/data/campuses/v-78/v-78-floor${level}.json`);
const registry = read("../public/data/stair-layouts.json");
const graph = read("../public/data/routing/v-78.json");
const length = (segment) =>
  Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]);
const scalar = (point, wall) => {
  const dx = wall.b[0] - wall.a[0],
    dz = wall.b[1] - wall.a[1];
  return (
    ((point[0] - wall.a[0]) * dx + (point[1] - wall.a[1]) * dz) /
    Math.hypot(dx, dz)
  );
};

test("nine known wide cells retain a short front partition and wider two-sided access without mutating source", () => {
  const beforeRegistry = structuredClone(registry);
  let count = 0;
  for (const level of [1, 2, 3]) {
    const floor = readFloor(level),
      original = structuredClone(floor);
    const view = getStairPartitionView(floor, registry.layouts);
    assert.equal(view.partitions.length, 3);
    assert.deepEqual(
      new Set(view.partitions.map((p) => p.building)),
      new Set(["Г", "В", "Б"]),
    );
    for (const p of view.partitions) {
      count++;
      assert.ok(Math.abs(p.width - 2) < 1e-8);
      assert.ok(p.width < length(p.sourceSegment) / 2);
      assert.ok(p.leftClearance >= STAIR_PARTITION_MODEL.minimumSidePassage);
      assert.ok(p.rightClearance >= STAIR_PARTITION_MODEL.minimumSidePassage);
      for (const point of [p.segment.a, p.segment.b]) {
        const along = scalar(point, p.sourceSegment);
        assert.ok(
          along > 0 && along < length(p.sourceSegment),
          "new front wall is a subset of the old wall",
        );
      }
      const front = view.walls[p.sourceWallIndex];
      assert.equal(front.source, floor.walls[p.sourceWallIndex].source);
      assert.equal(front.width, floor.walls[p.sourceWallIndex].width);
      assert.equal(
        front.displayEvidence.dimensionsStatus,
        "schematic-not-measured",
      );
      assert.equal(
        p.routingEffect,
        "source-door-anchors-preserved-runtime-conflicts-filtered-separately",
      );
      assert.deepEqual(
        p.sourceDoorIds.map((id) => floor.doors.find((d) => d.id === id)),
        p.sourceDoorIds.map((id) => original.doors.find((d) => d.id === id)),
      );
    }
    assert.deepEqual(floor, original);
  }
  assert.equal(count, 9);
  assert.deepEqual(registry, beforeRegistry);
});

test("the separate inner divider is behind the corridor, between flight edges with both branches open", () => {
  for (const level of [1, 2, 3]) {
    const floor = readFloor(level),
      view = getStairPartitionView(floor);
    assert.equal(view.walls.length, floor.walls.length + 3);
    for (const p of view.partitions) {
      assert.equal(p.innerWallStatus, "shown");
      const wall = p.innerWall;
      assert.equal(
        wall.displayEvidence.type,
        "user-confirmed-inner-start-divider",
      );
      assert.deepEqual(wall.local, { a: [0.29, 0.7], b: [0.71, 0.7] });
      assert.equal(wall.source, "user-description");
      assert.equal(wall.width, 0.2);
      assert.ok(
        wall.local.a[0] > 0.24 && wall.local.b[0] < 0.76,
        "divider leaves each full flight width free",
      );
      assert.ok(
        wall.local.a[1] < 1 && wall.local.b[1] < 1,
        "the front access remains between inner divider and corridor boundary",
      );
      // All original doors and vertical portal anchors remain outside the new wall.
      const [a, b] = wall.wallPoints;
      const tangent = [b[0] - a[0], b[1] - a[1]],
        n = Math.hypot(...tangent);
      for (const node of graph.nodes.filter(
        (node) =>
          node.floorId === floor.id &&
          node.areaId === p.polygonId &&
          ["door", "stairs"].includes(node.kind),
      )) {
        const x = node.position[0] - wall.a[0],
          z = node.position[1] - wall.a[1];
        const along = (x * tangent[0] + z * tangent[1]) / n;
        const across = Math.abs((x * tangent[1] - z * tangent[0]) / n);
        assert.ok(
          along < 0 || along > length(wall) || across > wall.width / 2,
          `${node.id} stays outside the divider`,
        );
      }
    }
  }
});

test("source changes fail closed for a cell instead of applying a stale wall correction", () => {
  const id = "v78-Г-2-ЛК2";
  for (const mutation of [
    (floor) => {
      floor.polygons.find(
        (p) => p.id === "v-78-floor2-area-201",
      ).points[0][0] += 0.001;
    },
    (floor) => {
      floor.doors.find((d) => d.id === "v-78-floor2-door-227").a[0] += 0.001;
    },
    (floor) => {
      floor.walls[1368].a[0] += 0.001;
    },
  ]) {
    const floor = readFloor(2);
    mutation(floor);
    assert.ok(
      !getStairPartitionView(floor).partitions.some((p) => p.layoutId === id),
    );
  }
  const layouts = structuredClone(registry.layouts);
  layouts.find((l) => l.id === id).frame.origin[0] += 0.001;
  assert.ok(
    !getStairPartitionView(readFloor(2), layouts).partitions.some(
      (p) => p.layoutId === id,
    ),
  );
});

test("unmatched first floors, A compact cells, main hall stairs and other campuses are unchanged", () => {
  for (const level of [0, 4]) {
    const floor = readFloor(level),
      view = getStairPartitionView(floor);
    assert.equal(view.walls, floor.walls);
    assert.deepEqual(view.partitions, []);
  }
  const floor = readFloor(2);
  const aLayouts = registry.layouts.filter((l) => l.building === "А");
  assert.equal(getStairPartitionView(floor, aLayouts).walls, floor.walls);
  assert.equal(
    getStairPartitionView({ ...floor, campusId: "v-86" }).walls,
    floor.walls,
  );
  assert.deepEqual(getStairPartitionView(null), { walls: [], partitions: [] });
});

test("an unmatched inner-flight shape skips only the inner divider and retains the confirmed short front wall", () => {
  const layouts = structuredClone(registry.layouts);
  layouts.find((l) => l.id === "v78-Г-2-ЛК2").flights[0].widthFraction = 2;
  const p = getStairPartitionView(readFloor(2), layouts).partitions.find(
    (p) => p.layoutId === "v78-Г-2-ЛК2",
  );
  assert.equal(p.width, 2);
  assert.equal(p.innerWall, null);
  assert.equal(p.innerWallStatus, "skipped-no-space-between-flights");
});

test("production hall/building/indoor filters preserve the guarded G3 source wall correction", () => {
  const original = readFloor(2),
    floor = getBuildingFloorView(getHallAdjacencyView(original), "Г");
  const display = getIndoorDisplayGeometry(floor);
  const result = getStairPartitionView({ ...floor, walls: display.walls });
  const p = result.partitions.find((p) => p.layoutId === "v78-Г-2-ЛК2");
  assert.ok(p);
  assert.equal(p.width, 2);
  assert.equal(p.innerWallStatus, "shown");
});
