import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { mapQuality } from "../src/map/quality.js";

const floors = [0, 1, 2, 3, 4].map((level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
    ),
  ),
);
const harness = () =>
  Object.assign(Object.create(AtlasScene.prototype), {
    floorHeight: 3.6,
    wallHeight: 2.7,
    plan: false,
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: { replaceChildren() {} },
    addLabel() {
      return {};
    },
    setRouteGuidance() {},
    invalidate() {},
    refreshUserLocation() {},
  });
const geometrySet = (view) => {
  const set = new Set();
  view.model.traverse((o) => {
    if (o.geometry) set.add(o.geometry);
  });
  return set;
};

test("returning to E2 reuses only CPU contours while independently disposing and rebuilding GPU resources", () => {
  const view = harness();
  view.setFloor(floors[2], "Е", { fit: false });
  const prepared = view.floorDisplay;
  const oldGeometry = geometrySet(view),
    disposed = new Set();
  oldGeometry.forEach((geometry) =>
    geometry.addEventListener("dispose", () => disposed.add(geometry)),
  );
  view.setFloor(floors[1], "Е", { fit: false });
  assert.equal(disposed.size, oldGeometry.size);
  assert.notEqual(view.floorDisplay, prepared);
  view.setFloor(floors[2], "Е", { fit: false });
  assert.equal(view.floorDisplay, prepared);
  assert.equal(view.floorDisplayCache.length, 2);
  for (const geometry of geometrySet(view))
    assert.ok(!oldGeometry.has(geometry));
  view.clear();
  assert.equal(view.model.children.length, 0);
});

test("prepared-floor cache is bounded and separates scoped and complete route displays", () => {
  const view = harness();
  const scoped = view.prepareFloorDisplay(floors[2], "Е");
  const full = view.prepareFloorDisplay(floors[2], null);
  assert.notEqual(full, scoped);
  assert.ok(
    full.renderFloor.polygons.length > scoped.renderFloor.polygons.length,
  );
  for (const building of ["Б", "В", "Г", "Д", "А"])
    view.prepareFloorDisplay(floors[1], building);
  assert.equal(view.floorDisplayCache.length, 6);
  assert.ok(!view.floorDisplayCache.includes(scoped));
  const revived = view.prepareFloorDisplay(floors[2], "Е");
  assert.notEqual(revived, scoped);
  assert.deepEqual(revived.slabs, scoped.slabs);
  assert.equal(view.floorDisplayCache.length, 6);
});

test("all 26 building/physical-floor scopes retain their assigned rooms inside the cutaway", () => {
  const view = harness();
  let scopes = 0;
  for (const floor of floors)
    for (const building of Object.keys(floor.buildingLevels)) {
      const prepared = view.prepareFloorDisplay(floor, building);
      const ids = new Set(prepared.renderFloor.polygons.map(({ id }) => id));
      for (const polygon of floor.polygons.filter(
        (p) => p.building === building,
      ))
        assert.ok(
          ids.has(polygon.id),
          `${building} ${floor.id}: ${polygon.id}`,
        );
      scopes++;
    }
  assert.equal(scopes, 26);
});

test("every quality preset retains lighting detail choices but disables shadow passes in 2D and 3D", () => {
  for (const preset of ["low", "balanced", "high", "auto"])
    for (const plan of [true, false])
      for (const touch of [true, false]) {
        const profile = mapQuality(preset, {
          plan,
          touch,
          pixelRatio: 2,
          cores: 8,
          memory: 8,
        });
        assert.equal(profile.shadows, false);
        assert.equal(profile.shadowSize, 0);
      }
  assert.equal(mapQuality("low").detail, false);
  assert.equal(mapQuality("balanced").detail, true);
  assert.ok(
    mapQuality("high", { pixelRatio: 2 }).pixelRatio >
      mapQuality("low", { pixelRatio: 2 }).pixelRatio,
  );
});

test("projection changes release an existing shadow target and never enable another shadow pass", (t) => {
  const previous = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  t.after(() => {
    if (previous === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = previous;
  });
  let released = 0;
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    quality: "high",
    plan: false,
    deviceQuality: {},
    renderer: {
      getPixelRatio: () => 1,
      setPixelRatio() {},
      shadowMap: { enabled: true },
      domElement: { setAttribute() {} },
    },
    sun: {
      castShadow: true,
      shadow: {
        map: {
          dispose() {
            released++;
          },
        },
        mapSize: {
          x: 2048,
          set() {
            throw new Error("Unexpected shadow allocation");
          },
        },
      },
    },
    ground: { visible: true },
  });
  view.applyProjectionStyle();
  assert.equal(view.renderer.shadowMap.enabled, false);
  assert.equal(view.sun.castShadow, false);
  assert.equal(view.sun.shadow.map, null);
  assert.equal(released, 1);
  view.plan = true;
  view.applyProjectionStyle();
  view.plan = false;
  view.applyProjectionStyle();
  assert.equal(released, 1);
  assert.equal(view.sun.shadow.map, null);
});

test("shared indoor components stay whole with selected-wing focus bounds and reuse common prepared contours", () => {
  const view = harness();
  const a = view.prepareFloorDisplay(floors[2], "А");
  const g = view.prepareFloorDisplay(floors[2], "Г");
  assert.equal(
    g,
    a,
    "same source component does not repeat contour/cutout derivation for each wing",
  );
  assert.equal(a.preserveSharedComponents, true);
  for (const id of [
    "v-78-floor2-area-27",
    "v-78-floor2-area-41",
    "v-78-floor2-area-63",
  ])
    assert.ok(a.renderFloor.polygons.some((polygon) => polygon.id === id));
  view.setFloor(floors[2], "Г", { fit: false });
  assert.equal(view.building, "Г");
  assert.equal(view.clipPlanes, null);
  view.model.traverse((object) => {
    for (const material of [object.material].flat().filter(Boolean))
      assert.ok(
        !material.clippingPlanes?.length,
        "shared rooms are not cut by per-building planes",
      );
  });
  const bounds = view.boundsForBuilding("Г", floors[2]);
  assert.ok(
    bounds[2] - bounds[0] < 100,
    "camera still focuses the requested wing",
  );
  view.clear();
});
