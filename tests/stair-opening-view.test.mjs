import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { pointInLocationPolygon } from "../src/location.js";
import { pickLocationSurface } from "../src/map/location-view.js";
import { AtlasScene } from "../src/map/scene.js";
import { createStairOpeningPlan } from "../src/map/stair-opening-view.js";

test("plan hatching follows both branches of a concave shaft without crossing its notch", () => {
  const opening = {
    points: [
      [0, 0],
      [6, 0],
      [6, 6],
      [4, 6],
      [4, 2],
      [2, 2],
      [2, 6],
      [0, 6],
    ],
  };
  const hatching = createStairOpeningPlan([opening]);
  const positions = hatching.geometry.getAttribute("position");
  const firstHatch = opening.points.length * 2;
  assert.ok(positions.count > firstHatch);
  for (let i = firstHatch; i < positions.count; i += 2) {
    for (const fraction of [0.1, 0.5, 0.9]) {
      const point = [
        THREE.MathUtils.lerp(
          positions.getX(i),
          positions.getX(i + 1),
          fraction,
        ),
        THREE.MathUtils.lerp(
          positions.getZ(i),
          positions.getZ(i + 1),
          fraction,
        ),
      ];
      assert.ok(pointInLocationPolygon(point, opening), JSON.stringify(point));
    }
  }
});

test("the existing A3 main staircase opening has plan marks and stays unavailable for pin placement", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor3.json", import.meta.url),
      "utf8",
    ),
  );
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    plan: true,
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: { replaceChildren() {} },
    addLabel: () => ({}),
    setRouteGuidance() {},
    invalidate() {},
    refreshUserLocation() {},
  });
  view.setFloor(floor, null, { fit: false });
  const hatch = view.model.getObjectByName("Stair openings · plan hatching");
  assert.ok(hatch?.isLineSegments);
  assert.ok(!view.pickables.includes(hatch));
  const main = view.locationCutouts.find(
    (cutout) => cutout.layoutId === "v-78-floor3-photo-stair-wide-hall",
  );
  assert.ok(main);
  const inside = main.points.reduce(
    ([x, z], point) => [
      x + point[0] / main.points.length,
      z + point[1] / main.points.length,
    ],
    [0, 0],
  );
  assert.ok(pointInLocationPolygon(inside, main));
  assert.equal(
    pickLocationSurface(view.locationFloor, inside, {
      cutouts: view.locationCutouts,
    }),
    null,
  );
  view.clear();
});
