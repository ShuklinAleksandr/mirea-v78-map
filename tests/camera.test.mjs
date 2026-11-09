import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AtlasScene } from "../src/map/scene.js";
import {
  createStaircase,
  getMapStairMarkers,
  stairLayoutFor,
} from "../src/map/stairs.js";

function cameraHarness() {
  const perspectiveCamera = new THREE.PerspectiveCamera(38, 1.5, 0.8, 2500);
  perspectiveCamera.position.set(110, 90, 130);
  const planCamera = new THREE.OrthographicCamera(
    -100,
    100,
    100,
    -100,
    0.5,
    5000,
  );
  planCamera.up.set(0, 0, -1);
  const controls = new OrbitControls(perspectiveCamera, null);
  controls.target.set(12, 0, -4);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.update();
  return Object.assign(Object.create(AtlasScene.prototype), {
    perspectiveCamera,
    planCamera,
    controls,
    camera: perspectiveCamera,
    plan: false,
    invalidate() {},
    applyProjectionStyle() {},
  });
}

function animatedCameraHarness() {
  return Object.assign(Object.create(AtlasScene.prototype), cameraHarness(), {
    callbacks: {},
    host: { dataset: {} },
    renderer: { info: {}, render() {} },
    invalidate() {
      this.dirty = true;
    },
    updateNavigationHeading() {
      return false;
    },
    updateRoute() {},
    updateLabels() {},
    updateUserLocationScale() {},
    applyProjectionStyle() {},
    stats() {
      return {};
    },
  });
}

test("an untouched automatic frame still refits when a desktop window narrows", () => {
  let fitCalls = 0;
  const bounds = [-80, -10, 80, 10];
  const view = Object.assign(
    Object.create(AtlasScene.prototype),
    cameraHarness(),
    {
      host: { getBoundingClientRect: () => ({ width: 800, height: 720 }) },
      renderer: { setSize() {} },
      viewportWidth: 1280,
      lastBounds: bounds,
      updateLocationPickPreview() {},
      fit(received, animate) {
        assert.equal(received, bounds);
        assert.equal(animate, false);
        fitCalls++;
      },
    },
  );
  view.perspectiveCamera.aspect = 1280 / 720;
  view.resize();
  assert.equal(fitCalls, 1);
});

for (const plan of [false, true]) {
  test(`${plan ? "2D" : "3D"}: browser bars and a keyboard never refit the last selected room`, () => {
    const view = Object.assign(
      Object.create(AtlasScene.prototype),
      cameraHarness(),
      {
        host: { getBoundingClientRect: () => ({ width: 390, height: 280 }) },
        renderer: { setSize() {} },
        viewportWidth: 390,
        lastBounds: [-5, -5, 5, 5],
        updateLocationPickPreview() {},
        fit() {
          assert.fail("a height-only viewport change must not refocus a room");
        },
      },
    );
    view.perspectiveCamera.aspect = 390 / 844;
    if (plan) view.setProjection(true);
    const position = view.camera.position.clone();
    const target = view.controls.target.clone();
    const zoom = view.camera.zoom;
    view.resize();
    assert.deepEqual(view.camera.position.toArray(), position.toArray());
    assert.deepEqual(view.controls.target.toArray(), target.toArray());
    assert.equal(view.camera.zoom, zoom);
  });

  test(`${plan ? "2D" : "3D"}: manual map framing survives an orientation change`, () => {
    const view = Object.assign(
      Object.create(AtlasScene.prototype),
      cameraHarness(),
      {
        host: { getBoundingClientRect: () => ({ width: 844, height: 390 }) },
        renderer: { setSize() {} },
        viewportWidth: 390,
        lastBounds: [-5, -5, 5, 5],
        updateLocationPickPreview() {},
        fit() {
          assert.fail("manual pan/pinch must not jump back to old room bounds");
        },
      },
    );
    view.perspectiveCamera.aspect = 390 / 844;
    if (plan) view.setProjection(true);
    view.beginMapInteraction();
    const position = view.camera.position.clone();
    const target = view.controls.target.clone();
    view.resize();
    assert.deepEqual(view.camera.position.toArray(), position.toArray());
    assert.deepEqual(view.controls.target.toArray(), target.toArray());
  });
}

for (const plan of [false, true]) {
  test(`${plan ? "2D" : "3D"}: a repeated camera fit cancels an obsolete tween and draws the changed scene once`, () => {
    const view = animatedCameraHarness();
    if (plan) view.setProjection(true);
    const position = view.camera.position.clone();
    const target = view.controls.target.clone();
    view.moveCamera(position.clone().addScalar(10), target.clone());
    assert.ok(view.transition, "fixture has an obsolete destination");
    view.moveCamera(position.clone().addScalar(1e-8), target.clone());
    assert.equal(view.transition, null);
    assert.equal(view.dirty, true, "new floor or selection still needs paint");
    assert.equal(view.animate(performance.now()), false);
    assert.equal(view.renderedFrames, 1);
    assert.equal(view.animate(performance.now() + 650), false);
    assert.equal(view.renderedFrames, 1, "no stationary animation tail");
    assert.ok(view.camera.position.distanceTo(position) < 1e-6);
    assert.ok(view.controls.target.distanceTo(target) < 1e-6);
  });
}

test("a changed camera position or target retains the real motion tween", () => {
  for (const change of ["position", "target"]) {
    const view = animatedCameraHarness();
    const position = view.camera.position.clone();
    const target = view.controls.target.clone();
    (change === "position" ? position : target).x += 0.01;
    view.moveCamera(position, target);
    assert.ok(view.transition, `${change} change is not a no-op`);
    const start = view.transition.start;
    assert.equal(view.animate(start + 325), true);
    assert.ok(view.transition, "real movement continues between endpoints");
    view.animate(start + 650);
    assert.equal(view.transition, null);
    assert.ok(view.camera.position.distanceTo(position) < 1e-6);
    assert.ok(view.controls.target.distanceTo(target) < 1e-6);
  }
});

test("entering a floor keeps the exterior camera scale and clears the old fit", () => {
  const view = Object.assign(
    Object.create(AtlasScene.prototype),
    cameraHarness(),
    {
      allBounds: () => [-40, -30, 40, 30],
      lastBounds: [-150, -150, 150, 150],
      lastFitOptions: { targetY: 9 },
    },
  );
  view.controls.target.y = 9;
  const offset = view.camera.position.clone().sub(view.controls.target);
  view.keepFloorViewport();
  assert.deepEqual(view.controls.target.toArray(), [12, 0, -4]);
  assert.ok(
    view.camera.position.clone().sub(view.controls.target).distanceTo(offset) <
      1e-6,
  );
  assert.equal(view.lastBounds, null);
  assert.equal(view.lastFitOptions, null);
});

test("a plan panned away from campus recenters on entry without resetting its zoom", () => {
  const view = Object.assign(
    Object.create(AtlasScene.prototype),
    cameraHarness(),
    {
      allBounds: () => [-40, -30, 60, 50],
    },
  );
  view.controls.target.set(700, 0, 400);
  view.setProjection(true);
  view.camera.zoom = 3;
  view.keepFloorViewport();
  assert.equal(view.camera.zoom, 3);
  assert.deepEqual(view.controls.target.toArray(), [10, 0, 10]);
});

for (const viewport of [
  {
    width: 1280,
    height: 800,
    padding: { left: 390, right: 90, top: 110, bottom: 90 },
  },
  {
    width: 390,
    height: 844,
    padding: { left: 64, right: 64, top: 164, bottom: 440 },
  },
]) {
  test(`library shaft focus reveals the return flight through the opening at ${viewport.width}px`, () => {
    const floor = JSON.parse(
      readFileSync(
        new URL(
          "../public/data/campuses/v-78/v-78-floor2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const marker = getMapStairMarkers(floor).find(
      (m) => m.layoutId === "v-78-floor2-user-stair-library",
    );
    const layout = stairLayoutFor(marker, floor);
    const model = new THREE.Group();
    const stair = createStaircase(marker, floor);
    model.add(stair);
    const view = Object.assign(
      Object.create(AtlasScene.prototype),
      cameraHarness(),
      {
        floor,
        model,
        selection: new THREE.Group(),
        sun: new THREE.DirectionalLight(),
        mode: "floor",
        reducedMotion: true,
        host: { clientWidth: viewport.width, clientHeight: viewport.height },
      },
    );
    view.perspectiveCamera.aspect = viewport.width / viewport.height;
    view.perspectiveCamera.updateProjectionMatrix();
    const blockers = new THREE.Group();
    const material = new THREE.MeshBasicMaterial();
    for (const wall of floor.walls) {
      const dx = wall.b[0] - wall.a[0],
        dz = wall.b[1] - wall.a[1];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(Math.hypot(dx, dz), 2.7, wall.width || 0.2),
        material,
      );
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.position.set(
        (wall.a[0] + wall.b[0]) / 2,
        1.48,
        (wall.a[1] + wall.b[1]) / 2,
      );
      blockers.add(mesh);
    }
    blockers.updateMatrixWorld(true);
    try {
      view.selectRoom(marker, { padding: viewport.padding });
      const offset = view.camera.position
        .clone()
        .sub(view.controls.target)
        .normalize();
      assert.ok(
        offset.x * layout.frame.axisV[0] + offset.z * layout.frame.axisV[1] < 0,
        "view comes from the wardrobe side",
      );
      assert.ok(
        offset.y > 0.99,
        "the shaft is viewed from above, over the entrance wall",
      );
      view.camera.updateMatrixWorld(true);
      for (const v of [0.2, 0.45, 0.65]) {
        const u = 0.75;
        const t = (0.78 - v) / (0.78 - 0.1);
        const y = 0.14 + 3.6 * (-0.5 - 0.5 * t);
        const point = new THREE.Vector3(
          layout.frame.origin[0] +
            layout.frame.axisU[0] * u * layout.frame.size[0] +
            layout.frame.axisV[0] * v * layout.frame.size[1],
          y,
          layout.frame.origin[1] +
            layout.frame.axisU[1] * u * layout.frame.size[0] +
            layout.frame.axisV[1] * v * layout.frame.size[1],
        );
        const projected = point.clone().project(view.camera);
        const x = ((projected.x + 1) * viewport.width) / 2;
        const screenY = ((1 - projected.y) * viewport.height) / 2;
        assert.ok(
          x > viewport.padding.left &&
            x < viewport.width - viewport.padding.right,
        );
        assert.ok(
          screenY > viewport.padding.top &&
            screenY < viewport.height - viewport.padding.bottom,
        );
        const ray = new THREE.Raycaster(
          view.camera.position,
          point.clone().sub(view.camera.position).normalize(),
          0,
          view.camera.position.distanceTo(point) - 0.05,
        );
        assert.equal(
          ray.intersectObjects(blockers.children).length,
          0,
          "source walls cannot hide the lower flight",
        );
        const atFloor = ray.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.13),
          new THREE.Vector3(),
        );
        const dx = atFloor.x - layout.frame.origin[0],
          dz = atFloor.z - layout.frame.origin[1];
        const localU =
          (dx * layout.frame.axisU[0] + dz * layout.frame.axisU[1]) /
          layout.frame.size[0];
        const localV =
          (dx * layout.frame.axisV[0] + dz * layout.frame.axisV[1]) /
          layout.frame.size[1];
        assert.ok(
          localU > 0.04 && localU < 0.96 && localV > 0.04 && localV < 0.98,
          "floor-plane intersection is inside the real cutout",
        );
      }
      const options = view.lastFitOptions;
      view.setProjection(true, { fit: true });
      view.setProjection(false, { fit: true });
      assert.deepEqual(view.lastFitOptions, options);
      view.fit(view.lastBounds, false, viewport.padding);
      assert.equal(
        view.lastFitOptions,
        null,
        "another room or route uses normal framing again",
      );
    } finally {
      disposeGroup(model);
      disposeGroup(view.selection);
      disposeGroup(blockers);
    }
  });
}

test("switching to 2D during an inertial rotation preserves a vertical plan", () => {
  const view = cameraHarness();
  // Simulate remaining momentum from an OrbitControls drag, then run the real
  // projection method and real damping updates without needing a WebGL context.
  view.controls._rotateUp(-0.4);
  view.controls._rotateLeft(0.3);
  AtlasScene.prototype.setProjection.call(view, true);
  for (let frame = 0; frame < 120; frame++) {
    view.controls.update();
    const direction = view.camera.position
      .clone()
      .sub(view.controls.target)
      .normalize();
    assert.ok(Math.hypot(direction.x, direction.z) < 0.00001);
  }
  assert.equal(view.camera, view.planCamera);
  assert.equal(view.controls.enableRotate, false);
  assert.equal(view.controls.mouseButtons.LEFT, THREE.MOUSE.PAN);
  assert.equal(view.controls.touches.ONE, THREE.TOUCH.PAN);
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_PAN);
});

test("2D zoom buttons change orthographic magnification without moving the camera", () => {
  const view = cameraHarness();
  AtlasScene.prototype.setProjection.call(view, true);
  const position = view.camera.position.clone();
  const target = view.controls.target.clone();
  const oldZoom = view.camera.zoom;
  AtlasScene.prototype.zoom.call(view, 0.75);
  assert.ok(view.camera.zoom > oldZoom);
  assert.deepEqual(view.camera.position.toArray(), position.toArray());
  assert.deepEqual(view.controls.target.toArray(), target.toArray());
  AtlasScene.prototype.zoom.call(view, 1.33);
  assert.ok(view.camera.zoom < oldZoom / 0.75);
});

test("approaching a linked stair with the map camera exposes its floor action in 2D and 3D", () => {
  for (const plan of [false, true]) {
    const view = cameraHarness();
    const destination = { floorId: "plan-3", buttonLabel: "На этаж 4" };
    const lower = { floorId: "plan-1", buttonLabel: "На этаж 2" };
    const opened = [];
    Object.assign(view, {
      plan,
      camera: plan ? view.planCamera : view.perspectiveCamera,
      mode: "floor",
      roomLabels: [],
      stairCandidates: [
        { marker: { id: "lower" }, point: [12, -4] },
        { marker: { id: "upper", layoutId: "upper-flight" }, point: [12, -6] },
      ],
      callbacks: {
        getStairTargets: (marker) => [
          marker.id === "upper" ? destination : lower,
        ],
        onStairTarget: (target) => opened.push(target),
      },
      addLabel(text, point, y, kind, open) {
        const el = { text, open, remove() {} };
        this.roomLabels.push({ el, kind });
        return el;
      },
    });
    view.updateStairActions();
    assert.equal(view.roomLabels.length, 0);
    if (plan) view.camera.zoom = 5;
    else view.camera.position.set(12, 35, 5);
    view.updateStairActions();
    assert.equal(view.roomLabels[0].el.text, "На этаж 2");
    view.selectedId = "search-result";
    view.selectedRoom = { layoutId: "upper-flight" };
    view.updateStairActions();
    assert.equal(view.roomLabels[0].el.text, "На этаж 4");
    view.roomLabels[0].el.open();
    assert.deepEqual(opened, [destination]);
    view.controls.target.set(80, 0, 30);
    view.updateStairActions();
    assert.equal(view.roomLabels.length, 0);
  }
});

test("zoom-out remains limited after a narrow campus fit and projection changes", () => {
  const view = cameraHarness();
  const bounds = [-305, -127, 305, 127];
  view.host = { clientWidth: 390, clientHeight: 844 };
  view.campus = { bounds };
  view.perspectiveCamera.aspect = 390 / 844;
  view.perspectiveCamera.updateProjectionMatrix();
  view.model = new THREE.Group();
  view.sun = new THREE.DirectionalLight();
  view.mode = "overview";
  view.reducedMotion = true;
  // No actual campus render is needed to exercise camera and controls.
  view.setOverview = () => {};

  for (const plan of [false, true]) {
    view.setProjection(plan);
    view.fit(bounds, false, { left: 16, right: 64, top: 90, bottom: 250 });
    const fittedDistance = view.cameraViewDistance();
    assert.ok(fittedDistance > 1000, "portrait view fits the whole campus");
    for (let i = 0; i < 20; i++) view.zoom(1.33);
    const limit = view.cameraViewDistance();
    assert.ok(
      limit > fittedDistance && limit <= fittedDistance * 1.6,
      `${plan ? "2D" : "3D"} fit ${fittedDistance} and limit ${limit}`,
    );
    view.setProjection(!plan);
    view.zoom(1.33);
    assert.ok(Math.abs(view.cameraViewDistance() - limit) < 1e-6);
  }
});

test("returning to 3D restores perspective and rotational controls at the plan scale", () => {
  const view = cameraHarness();
  AtlasScene.prototype.setProjection.call(view, true);
  AtlasScene.prototype.zoom.call(view, 0.5);
  const half =
    (view.planCamera.top - view.planCamera.bottom) / (2 * view.planCamera.zoom);
  const expectedDistance =
    half / Math.tan(THREE.MathUtils.degToRad(view.perspectiveCamera.fov / 2));
  AtlasScene.prototype.setProjection.call(view, false);
  assert.equal(view.camera, view.perspectiveCamera);
  assert.equal(view.controls.enableRotate, true);
  assert.equal(view.controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE);
  assert.equal(view.controls.touches.ONE, THREE.TOUCH.PAN);
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_PAN);
  assert.ok(
    Math.abs(
      view.camera.position.distanceTo(view.controls.target) - expectedDistance,
    ) < 1e-6,
  );
  assert.ok(view.controls.getPolarAngle() > 0.1);
});

test("2D and 3D preserve the chosen bearing after twisting the flat map", () => {
  const view = cameraHarness();
  const initialBearing = view.controls.getAzimuthalAngle();
  const initialTilt = view.controls.getPolarAngle();
  view.setProjection(true);
  const bearing = () => Math.atan2(-view.camera.up.x, -view.camera.up.z);
  assert.ok(Math.abs(bearing() - initialBearing) < 1e-8);
  view.camera.up.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
  view.controls.update();
  const chosen = bearing();
  const target = view.controls.target.clone();
  view.setProjection(false);
  assert.ok(Math.abs(view.controls.getAzimuthalAngle() - chosen) < 1e-8);
  assert.ok(Math.abs(view.controls.getPolarAngle() - initialTilt) < 1e-8);
  assert.ok(view.controls.target.distanceTo(target) < 1e-8);
  view.setProjection(true);
  assert.ok(Math.abs(bearing() - chosen) < 1e-8);
  const direction = view.camera.position
    .clone()
    .sub(view.controls.target)
    .normalize();
  assert.ok(Math.hypot(direction.x, direction.z) < 0.00001);
});

test("fitting a twisted flat plan keeps all bounds clear of the mobile panels", () => {
  const view = cameraHarness();
  view.host = { clientWidth: 390, clientHeight: 844 };
  view.perspectiveCamera.aspect = 390 / 844;
  view.perspectiveCamera.updateProjectionMatrix();
  view.model = new THREE.Group();
  view.sun = new THREE.DirectionalLight();
  view.mode = "floor";
  view.setProjection(true);
  view.camera.up.set(-Math.SQRT1_2, 0, -Math.SQRT1_2);
  view.controls.update();
  const padding = { left: 16, right: 72, top: 64, bottom: 290 };
  view.fit([-120, -12, 120, 12], false, padding);
  view.camera.updateMatrixWorld(true);
  for (const x of [-120, 120])
    for (const z of [-12, 12]) {
      const projected = new THREE.Vector3(x, 0, z).project(view.camera);
      const px = (projected.x + 1) * 195;
      const py = (1 - projected.y) * 422;
      assert.ok(px >= padding.left && px <= 390 - padding.right);
      assert.ok(py >= padding.top && py <= 844 - padding.bottom);
    }
  assert.ok(Math.abs(view.camera.up.x + Math.SQRT1_2) < 1e-8);
});

function disposeGroup(group) {
  const materials = new Set();
  group.traverse((object) => {
    object.geometry?.dispose();
    if (object.material) materials.add(object.material);
  });
  for (const material of materials) material.dispose();
}

for (const viewport of [
  {
    width: 390,
    height: 844,
    panelTop: 398,
    padding: { top: 164, bottom: 462, left: 64, right: 64 },
  },
  {
    width: 320,
    height: 568,
    panelTop: 276,
    padding: { top: 164, bottom: 308, left: 64, right: 64 },
  },
  {
    width: 1280,
    height: 800,
    panelRight: 366,
    padding: { top: 110, bottom: 90, left: 390, right: 90 },
  },
]) {
  for (const plan of [false, true]) {
    test(`${viewport.width}×${viewport.height}: selecting a room in ${plan ? "2D" : "3D"} frames its center outside the place panel`, () => {
      const model = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(80, 2, 60),
        new THREE.MeshBasicMaterial(),
      );
      slab.position.y = 1;
      model.add(slab);
      const view = Object.assign(
        Object.create(AtlasScene.prototype),
        cameraHarness(),
        {
          host: { clientWidth: viewport.width, clientHeight: viewport.height },
          model,
          selection: new THREE.Group(),
          sun: new THREE.DirectionalLight(),
          mode: "floor",
          reducedMotion: true,
        },
      );
      view.perspectiveCamera.aspect = viewport.width / viewport.height;
      view.perspectiveCamera.updateProjectionMatrix();
      const room = {
        id: "selected-room",
        kind: "room",
        center: [10, 5],
        points: [
          [5, 1],
          [15, 1],
          [15, 9],
          [5, 9],
        ],
      };
      try {
        if (plan) view.setProjection(true);
        // Real selectRoom -> fit -> moveCamera with real cameras and controls.
        view.selectRoom(room, { padding: viewport.padding });
        view.camera.updateMatrixWorld(true);
        const projected = new THREE.Vector3(
          room.center[0],
          0.2,
          room.center[1],
        ).project(view.camera);
        const x = (projected.x * 0.5 + 0.5) * viewport.width;
        const y = (-projected.y * 0.5 + 0.5) * viewport.height;
        assert.ok(
          projected.z > -1 && projected.z < 1,
          "selected point is inside the camera depth range",
        );
        assert.ok(
          x > viewport.padding.left &&
            x < viewport.width - viewport.padding.right,
          `room x=${x} avoids side controls`,
        );
        assert.ok(
          y > viewport.padding.top &&
            y < viewport.height - viewport.padding.bottom,
          `room y=${y} is in the useful map area`,
        );
        if (viewport.panelTop != null)
          assert.ok(
            y < viewport.panelTop - 16,
            `room y=${y} must be above the panel at ${viewport.panelTop}`,
          );
        if (viewport.panelRight != null)
          assert.ok(
            x > viewport.panelRight + 24,
            `room x=${x} must be right of the desktop panel`,
          );
        const usefulCenterX =
          (viewport.padding.left + viewport.width - viewport.padding.right) / 2;
        const usefulCenterY =
          (viewport.padding.top + viewport.height - viewport.padding.bottom) /
          2;
        assert.ok(
          Math.abs(x - usefulCenterX) < 5 && Math.abs(y - usefulCenterY) < 5,
          `selected room (${x},${y}) is framed in the visible map, not the full screen center`,
        );
      } finally {
        disposeGroup(model);
        disposeGroup(view.selection);
      }
    });
  }
}

for (const sourceLevel of [2, 3]) {
  const floor = JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${sourceLevel}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const marker = getMapStairMarkers(floor).find(
    (item) => stairLayoutFor(item, floor)?.shape === "straight-multiflight",
  );

  test(`A${sourceLevel}: focus frames the photographed hall stair instead of its entire source container`, () => {
    assert.ok(marker);
    const fits = [];
    const selection = new THREE.Group();
    const view = {
      floor,
      selection,
      invalidate() {},
      fit(bounds) {
        fits.push(bounds);
      },
    };
    AtlasScene.prototype.selectRoom.call(view, marker, { focus: false });
    assert.equal(
      fits.length,
      0,
      "clicking opens the card without moving the camera",
    );
    assert.equal(view.selectedId, marker.id);
    assert.equal(
      selection.children.length,
      1,
      "a point marker receives one selection ring",
    );
    AtlasScene.prototype.selectRoom.call(view, marker, { focus: true });
    assert.equal(fits.length, 1);
    assert.equal(
      selection.children.length,
      1,
      "refocusing replaces the old ring",
    );

    // The actual scan must fit, while the unchanged accepted plan footprint
    // retains context around its uniformly fitted surface. The scan no longer
    // fills every edge of that footprint; a 40×40 crop/full hall still fails.
    const stair = createStaircase(marker, floor);
    const box = new THREE.Box3().setFromObject(stair);
    const layout = stairLayoutFor(marker, floor);
    const planPoints = layout.footprint.map(([u, v]) => [
      layout.frame.origin[0] +
        layout.frame.axisU[0] * u * layout.frame.size[0] +
        layout.frame.axisV[0] * v * layout.frame.size[1],
      layout.frame.origin[1] +
        layout.frame.axisU[1] * u * layout.frame.size[0] +
        layout.frame.axisV[1] * v * layout.frame.size[1],
    ]);
    const planX = planPoints.map((p) => p[0]),
      planZ = planPoints.map((p) => p[1]);
    const [x, z, X, Z] = fits[0];
    assert.ok(fits[0].every(Number.isFinite));
    assert.ok(x < box.min.x && z < box.min.z && X > box.max.x && Z > box.max.z);
    assert.ok(x < Math.min(...planX) && X > Math.max(...planX));
    assert.ok(z < Math.min(...planZ) && Z > Math.max(...planZ));
    assert.ok(X - x <= Math.max(...planX) - Math.min(...planX) + 6);
    assert.ok(Z - z <= Math.max(...planZ) - Math.min(...planZ) + 6);
    disposeGroup(stair);
    AtlasScene.prototype.selectRoom.call(view, null);
    assert.equal(selection.children.length, 0);
  });

  test(`A${sourceLevel}: the building cutaway retains the unlabelled hall and every photographed stair vertex`, () => {
    const layout = stairLayoutFor(marker, floor);
    const container = floor.polygons.find(
      (polygon) => polygon.id === layout.containerAreaId,
    );
    assert.ok(container);
    assert.notEqual(
      container.building,
      "А",
      "regression fixture has an unassigned hall",
    );
    const labels = [];
    const view = Object.assign(Object.create(AtlasScene.prototype), {
      model: new THREE.Group(),
      context: new THREE.Group(),
      selection: new THREE.Group(),
      hover: new THREE.Group(),
      renderer: { shadowMap: {} },
      labelLayer: { replaceChildren() {} },
      neighborsOn: false,
      assumptions: { floorHeight: 3.6 },
      callbacks: {},
      addLabel(...args) {
        labels.push(args);
        return {};
      },
      // Wall tessellation and camera animation are unrelated to the cutaway.
      addWalls() {},
      fit() {},
    });
    view.setFloor(floor, "А", { fit: false });
    assert.ok(labels.some((args) => args[5] === marker.id));
    if (view.floorDisplay.preserveSharedComponents)
      assert.equal(view.clipPlanes, null, "shared source rooms stay whole");
    else assert.ok(view.clipPlanes.length >= 3);
    let checkedVertices = 0;
    for (const mesh of view.pickables) {
      const rooms = mesh.userData.faceRooms || [];
      const positions = mesh.geometry.attributes.position;
      for (let face = 0; face < rooms.length; face++) {
        if (rooms[face].id !== marker.id) continue;
        for (let corner = 0; corner < 3; corner++) {
          const point = new THREE.Vector3().fromBufferAttribute(
            positions,
            face * 3 + corner,
          );
          assert.ok(
            (view.clipPlanes || []).every(
              (plane) => plane.distanceToPoint(point) >= -0.0001,
            ),
            `${marker.id} visible vertex ${point.toArray()}`,
          );
          checkedVertices++;
        }
      }
    }
    assert.ok(
      checkedVertices > 100,
      "the actual batched staircase is present and visible",
    );
    if (sourceLevel === 2) {
      const renderedRooms = () =>
        view.pickables.flatMap((mesh) => mesh.userData.faceRooms || []);
      assert.ok(
        !renderedRooms().some((room) => room.building === "И"),
        "the separate I building is removed whole, not left as clipped fragments",
      );
      for (const id of ["v-78-floor2-area-29", "v-78-floor2-area-56"])
        assert.ok(
          renderedRooms().some((room) => room.id === id),
          "complete native A corridors remain in the isolated building view",
        );
      view.neighborsOn = true;
      view.setFloor(floor, "А", { fit: false });
      assert.ok(
        renderedRooms().some((room) => room.building === "И"),
        "turning neighboring buildings on restores the source I rooms",
      );
      assert.equal(view.floor, floor, "navigation retains the original floor");
    }
    view.clear();
  });
}

// Real V78 A2 bounds on the user's wide screen and an ordinary Mac window.
// Default floor fitting used to ignore the overlaid sidebar entirely.
for (const viewport of [
  {
    width: 3433,
    height: 1242,
    padding: { left: 390, right: 90, top: 110, bottom: 90 },
  },
  {
    width: 1280,
    height: 720,
    padding: { left: 390, right: 90, top: 110, bottom: 90 },
  },
  {
    width: 390,
    height: 844,
    padding: { left: 64, right: 64, top: 164, bottom: 462 },
  },
]) {
  for (const plan of [false, true]) {
    test(`${viewport.width}×${viewport.height}: default whole-building fit keeps A2 inside the map area in ${plan ? "2D" : "3D"}`, () => {
      const floor = JSON.parse(
        readFileSync(
          new URL(
            "../public/data/campuses/v-78/v-78-floor2.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const model = new THREE.Group();
      model.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(400, 4, 150),
          new THREE.MeshBasicMaterial(),
        ),
      );
      const view = Object.assign(
        Object.create(AtlasScene.prototype),
        cameraHarness(),
        {
          host: { clientWidth: viewport.width, clientHeight: viewport.height },
          callbacks: { getViewportPadding: () => viewport.padding },
          model,
          sun: new THREE.DirectionalLight(),
          mode: "floor",
          reducedMotion: true,
        },
      );
      view.perspectiveCamera.aspect = viewport.width / viewport.height;
      view.perspectiveCamera.updateProjectionMatrix();
      if (plan) view.setProjection(true);
      try {
        const bounds = view.boundsForBuilding("А", floor);
        view.fit(bounds, false);
        view.camera.updateMatrixWorld(true);
        for (const x of [bounds[0], bounds[2]]) {
          for (const z of [bounds[1], bounds[3]]) {
            for (const y of [0, 4]) {
              const p = new THREE.Vector3(x, y, z).project(view.camera);
              const screenX = ((p.x + 1) * viewport.width) / 2;
              const screenY = ((1 - p.y) * viewport.height) / 2;
              assert.ok(
                screenX >= viewport.padding.left &&
                  screenX <= viewport.width - viewport.padding.right,
                `x=${screenX} clears sidebar and controls`,
              );
              assert.ok(
                screenY >= viewport.padding.top &&
                  screenY <= viewport.height - viewport.padding.bottom,
                `y=${screenY} clears header and bottom panel`,
              );
            }
          }
        }
        assert.deepEqual(view.lastFitPadding, viewport.padding);
        // An explicit fit remains authoritative for route/room framing.
        view.fit(bounds, false, { left: 0, right: 0, top: 0, bottom: 0 });
        assert.equal(view.lastFitPadding.left, 0);
      } finally {
        disposeGroup(model);
      }
    });
  }
}

for (const plan of [false, true]) {
  for (const viewport of [
    {
      width: 390,
      height: 844,
      padding: { left: 16, right: 64, top: 164, bottom: 310 },
    },
    {
      width: 844,
      height: 390,
      padding: { left: 272, right: 64, top: 56, bottom: 12 },
    },
  ]) {
    test(`${plan ? "orthographic" : "perspective"} floor context samples the visible map centre at ${viewport.width}px`, () => {
      const view = cameraHarness();
      view.mode = "floor";
      view.host = {
        clientWidth: viewport.width,
        clientHeight: viewport.height,
      };
      view.perspectiveCamera.aspect = viewport.width / viewport.height;
      view.perspectiveCamera.updateProjectionMatrix();
      if (plan) view.setProjection(true);
      const before = {
        camera: view.camera.position.toArray(),
        target: view.controls.target.toArray(),
        zoom: view.camera.zoom,
      };
      const point = view.floorFocusPoint(viewport.padding);
      assert.ok(point && point.every(Number.isFinite));
      const projected = new THREE.Vector3(point[0], 0, point[1]).project(
        view.camera,
      );
      const x = ((projected.x + 1) * viewport.width) / 2;
      const y = ((1 - projected.y) * viewport.height) / 2;
      const expectedX =
        (viewport.padding.left + viewport.width - viewport.padding.right) / 2;
      const expectedY =
        (viewport.padding.top + viewport.height - viewport.padding.bottom) / 2;
      assert.ok(
        Math.abs(x - expectedX) < 1e-6,
        `map x=${x}, expected ${expectedX}`,
      );
      assert.ok(
        Math.abs(y - expectedY) < 1e-6,
        `map y=${y}, expected ${expectedY}`,
      );
      const unpadded = view.floorFocusPoint();
      assert.ok(
        Math.hypot(point[0] - unpadded[0], point[1] - unpadded[1]) > 0.1,
        "an obstructed viewport must not silently use the orbit target",
      );
      assert.deepEqual(view.camera.position.toArray(), before.camera);
      assert.deepEqual(view.controls.target.toArray(), before.target);
      assert.equal(view.camera.zoom, before.zoom);
    });
  }
}

test("floor context ray has no point outside an available floor viewport or when looking above the ground", () => {
  const view = cameraHarness();
  view.host = { clientWidth: 390, clientHeight: 844 };
  view.mode = "overview";
  assert.equal(view.floorFocusPoint(), null);
  view.mode = "floor";
  view.host.clientHeight = 0;
  assert.equal(view.floorFocusPoint(), null);
  view.host.clientHeight = 844;
  view.camera.position.set(0, 20, 0);
  view.camera.lookAt(0, 30, -10);
  assert.equal(view.floorFocusPoint(), null);
});

test("building context samples a close view but ignores a broad campus frame", () => {
  for (const plan of [false, true]) {
    const view = cameraHarness();
    view.mode = "floor";
    view.host = { clientWidth: 390, clientHeight: 844 };
    if (plan) view.setProjection(true);
    assert.equal(view.floorFocusPoint({}, { maxSpan: 100 }), null);
    if (plan) {
      view.camera.zoom *= 4;
      view.camera.updateProjectionMatrix();
    } else {
      view.camera.position.lerp(view.controls.target, 0.75);
      view.camera.lookAt(view.controls.target);
    }
    assert.ok(
      view.floorFocusPoint({}, { maxSpan: 100 })?.every(Number.isFinite),
    );
  }
});
