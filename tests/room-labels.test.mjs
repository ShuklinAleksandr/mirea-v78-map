import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";

test("a neighboring building keeps its room labels while another building is selected", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    ),
  );
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    plan: true,
    neighborsOn: true,
    floorHeight: 3.6,
    wallHeight: 2.7,
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: { replaceChildren() {} },
    addLabel(text, point, height, kind, onClick, id, roomRadius) {
      this.roomLabels.push({ text, point, kind, id, roomRadius });
      return {};
    },
    invalidate() {},
  });
  try {
    view.setFloor(floor, "А", { fit: false });
    for (const text of ["А-203", "Г-310"]) {
      const label = view.roomLabels.find((item) => item.text === text);
      assert.ok(label?.roomRadius, `${text} has a fitted indoor badge`);
      assert.equal(label.kind, "room");
    }
  } finally {
    view.clear();
  }
});

test("room badges keep the same size at both zooms and skip overlapping neighbors", () => {
  for (const plan of [true, false]) {
    const width = 390,
      height = 844;
    const aspect = width / height;
    const camera = plan
      ? new THREE.OrthographicCamera(
          -55 * aspect,
          55 * aspect,
          55,
          -55,
          0.1,
          1000,
        )
      : new THREE.PerspectiveCamera(38, aspect, 0.1, 1000);
    if (plan) camera.up.set(0, 0, -1);
    const labels = Array.from({ length: 32 }, (_, index) => ({
      kind: "room",
      id: `room-${index}`,
      roomRadius: 1.8,
      position: new THREE.Vector3(
        ((index % 8) - 3.5) * 3.5,
        0.13,
        (Math.floor(index / 8) - 1.5) * 5,
      ),
      el: { textContent: "А-111", style: {}, classList: { toggle() {} } },
    }));
    const view = Object.assign(Object.create(AtlasScene.prototype), {
      mode: "floor",
      plan,
      labelsOn: true,
      camera,
      host: {
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ x: 0, y: 0 }),
      },
      labelObstacles: [],
      roomLabels: labels,
      updateUserLocationOverlay: () => null,
    });
    camera.position.set(0, 90, plan ? 0 : 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    view.updateLabels();
    const visible = () =>
      labels.filter((label) => label.el.style.display === "block");
    const closerCount = visible().length;
    assert.ok(closerCount > 0);
    for (const { el } of visible())
      assert.doesNotMatch(el.style.transform, /scale/);

    if (plan) {
      camera.zoom = 0.3;
      camera.updateProjectionMatrix();
    } else {
      camera.position.multiplyScalar(3);
      camera.updateMatrixWorld();
    }
    view.updateLabels();
    assert.ok(visible().length > 0 && visible().length < closerCount);
    for (const { el } of visible())
      assert.doesNotMatch(el.style.transform, /scale/);

    view.labelsOn = false;
    view.updateLabels();
    assert.ok(labels.every((label) => label.el.style.display === "none"));
  }
});
