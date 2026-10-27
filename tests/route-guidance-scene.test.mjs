import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AtlasScene } from "../src/map/scene.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
} from "../src/map/route-guidance.js";

function harness(plan = false) {
  const perspectiveCamera = new THREE.PerspectiveCamera(
    38,
    390 / 844,
    0.2,
    2500,
  );
  const planCamera = new THREE.OrthographicCamera(
    -100,
    100,
    100,
    -100,
    0.5,
    5000,
  );
  planCamera.up.set(0, 0, -1);
  perspectiveCamera.position.set(110, 90, 130);
  const controls = new OrbitControls(perspectiveCamera, null);
  controls.target.set(12, 0, -4);
  controls.update();
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    perspectiveCamera,
    planCamera,
    camera: perspectiveCamera,
    controls,
    plan: false,
    mode: "floor",
    floor: { id: "f1" },
    scene: new THREE.Scene(),
    model: new THREE.Group(),
    sun: new THREE.DirectionalLight(),
    reducedMotion: true,
    host: { clientWidth: 390, clientHeight: 844 },
    invalidate() {},
  });
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(300, 2, 100),
    new THREE.MeshBasicMaterial(),
  );
  view.model.add(slab);
  if (plan) view.setProjection(true);
  return view;
}
const guide = createRouteGuidance({
  segments: [
    {
      floorId: "f1",
      points: [
        [0, 0],
        [80, 0],
        [80, 40],
      ],
    },
    {
      floorId: "f2",
      points: [
        [80, 40],
        [80, 60],
      ],
    },
  ],
  steps: [],
});

for (const plan of [false, true]) {
  test(`route preview ${plan ? "2D" : "3D"}: local framing, camera follow and disposable preview marker`, () => {
    const view = harness(plan);
    const sample = sampleRouteGuidance(guide, 0, 0);
    const padding = { left: 16, right: 66, top: 92, bottom: 350 };
    try {
      assert.equal(view.setRouteGuidance(sample, { padding }), true);
      assert.deepEqual(view.lastBounds, [-4, -13, 22, 13]);
      const marker = view.guidanceLayer;
      assert.equal(marker.userData.role, "route-preview-not-geolocation");
      assert.deepEqual(marker.position.toArray(), [0, 0.65, 0]);
      view.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3(0, 0.65, 0).project(view.camera);
      const x = (p.x * 0.5 + 0.5) * 390;
      const y = (-p.y * 0.5 + 0.5) * 844;
      assert.ok(x > padding.left && x < 390 - padding.right);
      assert.ok(y > padding.top && y < 844 - padding.bottom);
      const position = view.camera.position.clone();
      const target = view.controls.target.clone();
      const distance = position.distanceTo(target);
      const direction = position.clone().sub(target).normalize();
      view.setRouteGuidance(sampleRouteGuidance(guide, 0, 20), { padding });
      assert.equal(view.guidanceLayer, marker);
      assert.deepEqual(marker.position.toArray(), [20, 0.65, 0]);
      assert.ok(view.camera.position.x > position.x + 15);
      assert.ok(
        Math.abs(
          view.camera.position.distanceTo(view.controls.target) - distance,
        ) < 1e-6,
      );
      assert.ok(
        view.camera.position
          .clone()
          .sub(view.controls.target)
          .normalize()
          .distanceTo(direction) < 1e-6,
      );
      for (const distance of [80, 90, 120]) {
        const turn = sampleRouteGuidance(guide, 0, distance);
        view.setRouteGuidance(turn, { padding });
        view.camera.updateMatrixWorld(true);
        for (const point of [turn.position, ...turn.cameraPoints]) {
          const projected = new THREE.Vector3(point[0], 0.65, point[1]).project(
            view.camera,
          );
          const px = (projected.x * 0.5 + 0.5) * 390;
          const py = (-projected.y * 0.5 + 0.5) * 844;
          assert.ok(
            px > padding.left && px < 390 - padding.right,
            `turn ${distance}, x=${px}`,
          );
          assert.ok(
            py > padding.top && py < 844 - padding.bottom,
            `turn ${distance}, y=${py}`,
          );
        }
      }
      // Starting preview changes the mobile sheet height. Even a paused sample
      // must be framed again when its usable viewport changes.
      const tallerPanel = { ...padding, top: 164, bottom: 500 };
      const stationary = sampleRouteGuidance(guide, 0, 120);
      view.setRouteGuidance(stationary, { padding: tallerPanel });
      assert.deepEqual(view.lastFitPadding, tallerPanel);
      view.camera.updateMatrixWorld(true);
      const reframed = new THREE.Vector3(80, 0.65, 40).project(view.camera);
      const screenY = (-reframed.y * 0.5 + 0.5) * 844;
      assert.ok(
        screenY > tallerPanel.top && screenY < 844 - tallerPanel.bottom,
        `grown panel, y=${screenY}`,
      );
      // A sample from another floor cannot fabricate a vertical interpolation.
      assert.equal(
        view.setRouteGuidance(sampleRouteGuidance(guide, 1, 0)),
        false,
      );
      assert.deepEqual(marker.position.toArray(), [80, 0.65, 40]);
      let disposed = 0;
      for (const mesh of marker.children)
        mesh.geometry.addEventListener("dispose", () => disposed++);
      view.setRouteGuidance(null);
      assert.equal(disposed, 2);
      assert.equal(marker.parent, null);
      assert.equal(view.guidanceLayer, null);
      assert.equal(view.guidanceAnchor, null);
    } finally {
      view.setRouteGuidance(null);
      view.model.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
  });
}
