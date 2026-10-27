import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  createStaircase,
  getMapStairMarkers,
  getStairDisplayCutouts,
  getStairRoutePaths,
  stairLayoutFor,
  withStairDisplayCutouts,
} from "../src/map/stairs.js";

const readFloor = (level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const dispose = (group) =>
  group.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
const inRing = (p, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};

test("middle-floor sections show an up-flight and a down-flight while stacks retain the complete original ascent", () => {
  let count = 0;
  for (const level of [1, 2, 3]) {
    const floor = readFloor(level),
      original = structuredClone(floor);
    for (const marker of getMapStairMarkers(floor)) {
      const layout = stairLayoutFor(marker, floor);
      if (!layout?.incomingDisplay) continue;
      count++;
      const section = createStaircase(marker, floor);
      const stack = createStaircase(marker, floor, {}, { stack: true });
      try {
        const box = new THREE.Box3().setFromObject(section);
        const full = new THREE.Box3().setFromObject(stack);
        assert.equal(section.userData.middleFloorCutaway, true);
        assert.ok(box.min.y < -1.5 && box.min.y > -2.1, marker.id);
        assert.ok(
          box.max.y > 2.5 && box.max.y < 3,
          "only the nearest up/down flights remain in a floor section",
        );
        assert.equal(stack.userData.middleFloorCutaway, false);
        assert.ok(
          full.min.y > -0.05 && full.max.y > 4,
          "the complete source ascent is rendered once in a stack",
        );
        const front = layout.frame.origin.map(
          (value, i) =>
            value +
            layout.frame.axisU[i] * layout.frame.size[0] * 0.5 +
            layout.frame.axisV[i] * layout.frame.size[1] * 0.85,
        );
        const cuts = getStairDisplayCutouts(floor).filter(
          (cut) => cut.layoutId === layout.incomingDisplay.id,
        );
        assert.ok(cuts.length);
        if (layout.shape === "wide-well-U")
          assert.ok(
            cuts.every((cut) => !inRing(front, cut.points)),
            "the shared entrance landing must not become a black opening",
          );
        const polygon = floor.polygons.find((p) => p.id === layout.fitAreaId);
        const display = withStairDisplayCutouts(polygon, cuts);
        assert.ok(
          display.holes.length > (polygon.holes || []).length,
          `${layout.id}: the descent opening must actually be applied inside a notched native cell`,
        );
      } finally {
        dispose(section);
        dispose(stack);
      }
    }
    assert.deepEqual(floor, original);
  }
  assert.equal(count, 16);
});

test("a G3 descent route uses the incoming side and the same visible negative-height tread profile", () => {
  const floor = readFloor(2);
  const marker = getMapStairMarkers(floor).find(
    (m) => m.layoutId === "v78-Г-2-ЛК2",
  );
  const layout = stairLayoutFor(marker, floor);
  const edgeId = layout.incomingDisplay.sourceEdgeIds[0];
  const source = floor.transitions.find((edge) => edge.id === edgeId);
  const route = {
    segments: [
      { floorId: floor.id, nodes: [{ sourceLevel: 2 }] },
      { floorId: source.targetFloorId, nodes: [{ sourceLevel: 1 }] },
    ],
    transitions: [
      {
        sourceEdgeId: edgeId,
        fromFloorId: floor.id,
        toFloorId: source.targetFloorId,
        point: source.position,
        targetPoint: source.targetPosition,
      },
    ],
  };
  const [path] = getStairRoutePaths(route, floor);
  assert.ok(path);
  assert.equal(path.descending, true);
  assert.equal(path.layoutId, layout.incomingDisplay.id);
  assert.ok(path.points[0][1] < 0.3 && path.points.at(-1)[1] < -1.5);
  assert.ok(path.points.every((p) => p[1] <= 0.3 && p[1] > -2));
  const [full] = getStairRoutePaths(route, floor, 3.6, { stack: true });
  assert.ok(
    Math.min(...full.points.map((p) => p[1])) < -3,
    "a stack may use the entire photographed physical module",
  );
});
