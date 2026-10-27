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
  return {
    perspectiveCamera,
    planCamera,
    controls,
    camera: perspectiveCamera,
    plan: false,
    invalidate() {},
  };
}

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
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_ROTATE);
  assert.ok(
    Math.abs(
      view.camera.position.distanceTo(view.controls.target) - expectedDistance,
    ) < 1e-6,
  );
  assert.ok(view.controls.getPolarAngle() > 0.1);
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

    // Use the rendered flights, landings and rails as an independent spatial
    // reference. A generic 40×40 marker crop or the broad hall polygon fails.
    const stair = createStaircase(marker, floor);
    const box = new THREE.Box3().setFromObject(stair);
    const [x, z, X, Z] = fits[0];
    assert.ok(fits[0].every(Number.isFinite));
    assert.ok(x < box.min.x && z < box.min.z && X > box.max.x && Z > box.max.z);
    assert.ok(X - x <= box.max.x - box.min.x + 6);
    assert.ok(Z - z <= box.max.z - box.min.z + 6);
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
    assert.ok(view.clipPlanes.length >= 3);
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
            view.clipPlanes.every(
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
