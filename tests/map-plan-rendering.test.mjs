import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { mapQuality } from "../src/map/quality.js";

test("the 2D floor uses unlit room fills and pickable flat stair symbols", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
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
    addLabel(text) {
      assert.equal(typeof text, "string");
      return {};
    },
    setRouteGuidance() {},
    invalidate() {},
    refreshUserLocation() {},
  });
  view.setFloor(floor, null, { fit: false });
  const stairs = view.model.getObjectByName("Stair symbols");
  assert.ok(view.pickables.includes(stairs));
  assert.ok(stairs.userData.faceRooms.some((room) => room.kind === "stairs"));
  const rooms = view.pickables.find((mesh) => mesh !== stairs);
  assert.ok(rooms.userData.faceRooms.some((room) => room.kind === "room"));
  for (const mesh of view.model.children.filter((object) => object.isMesh)) {
    assert.ok(mesh.material.isMeshBasicMaterial);
    mesh.geometry.computeBoundingBox();
    assert.ok(
      mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y < 1e-5,
    );
  }
  view.clear();
});

test("weak-device automatic quality lowers pixel density and shadows", () => {
  const weak = { pixelRatio: 3, touch: true, cores: 4 };
  assert.deepEqual(mapQuality("auto", weak), {
    pixelRatio: 0.8,
    shadows: false,
    shadowSize: 0,
    detail: false,
    autoFrameRate: 30,
  });
  assert.equal(mapQuality("high", weak).shadowSize, 2048);
  assert.equal(mapQuality("balanced", weak).autoFrameRate, 60);
});

test("quality options change 2D pixel density even on a standard display", () => {
  const screen = { pixelRatio: 1, plan: true };
  const profiles = ["low", "balanced", "high"].map((mode) =>
    mapQuality(mode, screen),
  );
  assert.deepEqual(
    profiles.map(({ pixelRatio }) => pixelRatio),
    [0.8, 1, 1.5],
  );
  assert.ok(profiles.every(({ shadowSize }) => shadowSize === 0));
});
