import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import {
  createStaircase,
  getMapStairMarkers,
  stairLayoutFor,
} from "../src/map/stairs.js";
import { scanBackedStairLayoutsForFloor } from "../src/map/stair-model-bindings.js";

const readFloor = (level = 2) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
    ),
  );
const libraryId = "v-78-floor2-user-stair-library";
const markerFor = (floor, id) =>
  getMapStairMarkers(floor).find((marker) => marker.layoutId === id);

test("repeated display requests reuse immutable CPU snapshots without freezing the source", () => {
  const floor = readFloor();
  const before = JSON.stringify(floor);
  const markers = getMapStairMarkers(floor);
  const marker = markerFor(floor, libraryId);
  const layout = stairLayoutFor(marker, floor);
  assert.equal(getMapStairMarkers(floor), markers);
  assert.equal(stairLayoutFor(marker, floor), layout);
  assert.throws(() => markers.push(marker), TypeError);
  assert.throws(() => (marker.center[0] = 0), TypeError);
  assert.throws(() => (layout.flights[0].from[0] = 0), TypeError);
  assert.equal(Object.isFrozen(floor), false);
  assert.equal(Object.isFrozen(floor.polygons[0].points), false);
  assert.equal(JSON.stringify(floor), before);

  const replacement = structuredClone(floor);
  const fresh = getMapStairMarkers(replacement);
  assert.notEqual(fresh, markers, "replacement source owns its snapshot");
  assert.deepEqual(fresh, markers);
  replacement.markers.push({
    id: "test-new-source-marker",
    kind: "stairs",
    position: [10000, 10000],
  });
  assert.ok(
    getMapStairMarkers(replacement).some(
      (m) => m.id === "test-new-source-marker",
    ),
  );
  assert.equal(getMapStairMarkers(floor), markers);
});

test("warm library cache rejects changed portals and changed source geometry in place", () => {
  for (const change of [
    (floor) => {
      floor.transitions.find(
        (item) => item.id === "v-78:edge:20734",
      ).targetPosition[0] += 1;
    },
    (floor) => {
      floor.polygons.find(
        (item) => item.id === "v-78--floor-2--9yc",
      ).points[0][0] += 1;
    },
    (floor) => {
      floor.units = "pixels";
    },
  ]) {
    const floor = readFloor();
    assert.ok(markerFor(floor, libraryId));
    change(floor);
    assert.equal(markerFor(floor, libraryId), undefined);
  }
});

test("D source bindings rerun guards after reuse rather than accepting stale cell or portal data", () => {
  for (const change of [
    (floor) => {
      floor.polygons.find(
        (item) => item.id === "v-78-floor2-area-264",
      ).points[0][0] += 1;
    },
    (floor) => {
      for (const items of [floor.markers, floor.transitions])
        for (const item of items.filter(
          (item) => item.id === "v-78:edge:20743",
        ))
          item.targetPosition[0] += 1;
    },
    (floor) => {
      floor.buildingLevels.Д = 99;
    },
  ]) {
    const floor = readFloor();
    const id = "v78-Д-scan-v-78-floor2";
    assert.ok(markerFor(floor, id));
    assert.equal(scanBackedStairLayoutsForFloor(floor).length, 1);
    change(floor);
    assert.deepEqual(scanBackedStairLayoutsForFloor(floor), []);
    assert.equal(markerFor(floor, id), undefined);
  }
});

test("changed level context does not reuse a middle-floor incoming display", () => {
  const floor = readFloor(2);
  const id = "v78-Г-2-ЛК2";
  const marker = markerFor(floor, id);
  const layout = stairLayoutFor(marker, floor);
  assert.ok(layout.incomingDisplay);
  floor.level = 99;
  const changed = stairLayoutFor(marker, floor);
  assert.notEqual(changed, layout);
  assert.equal(changed.incomingDisplay, undefined);
});

test("CPU profile reuse does not cache display height or share disposable render geometry", () => {
  const floor = readFloor();
  const marker = markerFor(floor, "v-78-floor2-photo-stair-wide-hall");
  const a = createStaircase(marker, floor, { floorRise: 3 });
  const b = createStaircase(marker, floor, { floorRise: 5 });
  try {
    assert.equal(a.userData.floorRise, 3);
    assert.equal(b.userData.floorRise, 5);
    assert.notEqual(a.children[0].geometry, b.children[0].geometry);
    assert.notEqual(a.children[0].material, b.children[0].material);
    const low = new THREE.Box3().setFromObject(a);
    const high = new THREE.Box3().setFromObject(b);
    assert.ok(high.max.y > low.max.y + 1.9);
  } finally {
    for (const group of [a, b])
      group.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
  }
});
