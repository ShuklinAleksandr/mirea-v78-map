import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";

test("indoor names shrink instead of disappearing when a whole floor is in view", () => {
  for (const plan of [true, false]) {
    const camera = plan
      ? new THREE.OrthographicCamera(-60, 60, 45, -45, 0.1, 1000)
      : new THREE.PerspectiveCamera(38, 4 / 3, 0.1, 1000);
    if (plan) camera.up.set(0, 0, -1);
    const labels = Array.from({ length: 32 }, (_, index) => ({
      kind: "room",
      id: `room-${index}`,
      roomRadius: 1.8,
      position: new THREE.Vector3(
        ((index % 8) - 3.5) * 5,
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
        clientWidth: 800,
        clientHeight: 600,
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
    const scaleOf = (label) =>
      Number(/scale\(([^)]+)\)/.exec(label.el.style.transform)?.[1]);
    const closerScale = scaleOf(labels[0]);

    if (plan) {
      camera.zoom = 0.3;
      camera.updateProjectionMatrix();
    } else {
      camera.position.multiplyScalar(3);
      camera.updateMatrixWorld();
    }
    view.updateLabels();
    assert.ok(labels.every((label) => label.el.style.display === "block"));
    assert.ok(scaleOf(labels[0]) > 0 && scaleOf(labels[0]) < closerScale);

    view.labelsOn = false;
    view.updateLabels();
    assert.ok(labels.every((label) => label.el.style.display === "none"));
  }
});
