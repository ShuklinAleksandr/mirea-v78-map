import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AtlasScene } from "../src/map/scene.js";
import { createRouteTracker } from "../src/data/route-tracking.js";
import { createRouteLocationDisplay } from "../src/data/route-location-display.js";
import { createRouteTrackingSurfaceGuard } from "../src/data/route-tracking-surface.js";
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

function liveHarness(t, plan) {
  const view = harness(plan);
  view.campus = { id: "v-78" };
  let match = { point: [4, 0], sourceSegmentIndex: 0, status: "tracking" };
  view.routeLayer = {
    paths: [
      {
        sourceSegmentIndex: 0,
        points: [
          [0, 0],
          [20, 0],
          [20, 20],
        ],
      },
    ],
  };
  view.callbacks = {
    shouldFollowRouteCamera: () => true,
    shouldFollowUserLocation: () => true,
    getRouteLocationMatch: (location) => location && match,
  };
  view.setHeadingFollow(false);
  let timestamp = Date.now() - 1000;
  const update = (point, options = {}) => {
    match = { point, sourceSegmentIndex: 0, status: "tracking", ...options };
    timestamp += 1000;
    view.setUserLocation({
      source: "gps",
      campusId: "v-78",
      point: [point[0], point[1] + 1],
      timestamp,
      accuracyMeters: 6,
      accuracyRadiusMap: 6,
      trackingStatus: "live",
    });
  };
  t.after(() => {
    view.setUserLocation(null);
    view.model.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  });
  update([4, 0]);
  return { view, update };
}

for (const plan of [false, true]) {
  test(`live ${plan ? "2D" : "3D"} route camera faces travel without compass and respects manual zoom/pause`, (t) => {
    const { view, update } = liveHarness(t, plan);
    view.navigationBearing = Math.PI / 2; // Opposing raw compass cannot win.
    view.userHeading = { timestamp: Date.now() };
    assert.equal(view.updateNavigationHeading(16), true);
    view.controls.update();
    const offset = view.camera.position.clone().sub(view.controls.target);
    if (plan) {
      assert.ok(view.camera.up.angleTo(new THREE.Vector3(1, 0, 0)) < 0.001);
      assert.ok(Math.hypot(offset.x, offset.z) < 0.01, "plan stays top-down");
    } else {
      assert.ok(offset.x < 0, "camera is behind eastbound movement");
      assert.ok(
        Math.abs(Math.acos(offset.y / offset.length()) - (55 * Math.PI) / 180) <
          0.001,
      );
    }
    const distance = view.cameraViewDistance();
    update([6, 0]);
    view.followUserLocation();
    assert.ok(
      Math.abs(view.cameraViewDistance() - distance) < 1e-8,
      "new fixes preserve zoom",
    );

    view.beginMapInteraction();
    view.camera.position.x += 7;
    view.controls.target.x += 7;
    if (plan) view.camera.zoom = 2.5;
    else view.camera.position.lerp(view.controls.target, 0.4);
    view.controls.update();
    const chosenDistance = view.cameraViewDistance();
    const chosen = view.camera.position.clone();
    update([8, 0]);
    assert.equal(view.followUserLocation(), false);
    assert.equal(view.updateNavigationHeading(32), undefined);
    assert.ok(
      view.camera.position.equals(chosen),
      "a late GPS callback cannot undo the gesture",
    );

    view.focusUserLocation();
    view.updateNavigationHeading(48);
    view.controls.update();
    assert.equal(view.routeCameraPaused, false);
    assert.ok(
      Math.abs(view.cameraViewDistance() - chosenDistance) < 1e-8,
      "recenter retains the chosen zoom",
    );
    if (plan) assert.equal(view.camera.zoom, 2.5);
  });
}

test("accepted reverse movement changes direction after a deadband; held, stairs and preview stop camera", (t) => {
  const { view, update } = liveHarness(t, true);
  view.updateNavigationHeading(16);
  update([10, 0]);
  update([8.2, 0]);
  assert.equal(
    view.routeLocationFix.travelDirection,
    1,
    "jitter cannot reverse the view",
  );
  update([6.8, 0], { status: "wrong-way" });
  assert.equal(view.routeLocationFix.travelDirection, -1);
  view.updateNavigationHeading(32);
  assert.ok(view.camera.up.angleTo(new THREE.Vector3(-1, 0, 0)) < 0.001);
  update([7.3, 0], { status: "wrong-way" });
  assert.equal(view.routeLocationFix.travelDirection, -1);
  const stopped = view.camera.position.clone();
  view.transition = { from: stopped.clone(), to: stopped.clone().addScalar(3) };
  update([7.3, 0], {
    status: "uncertain",
    held: true,
    confirmedAt: Date.now(),
    expiresAt: Date.now() + 12000,
  });
  assert.equal(
    view.transition,
    null,
    "held evidence cancels automatic recenter motion",
  );
  assert.equal(view.updateNavigationHeading(48), undefined);
  assert.equal(view.followUserLocation(), false);
  update([15, 0]);
  assert.equal(
    view.routeLocationMotion,
    null,
    "recovery never animates through the held gap",
  );
  update([15, 0], { status: "floor-change" });
  assert.equal(view.updateNavigationHeading(64), undefined);
  assert.equal(view.floor.id, "f1", "camera never selects the next floor");
  update([16, 0]);
  view.routePreviewProgress = { distance: 2 };
  assert.equal(view.updateNavigationHeading(80), undefined);
  assert.equal(view.followUserLocation(), false);
  assert.ok(view.camera.position.equals(stopped));
});

test("real tracker/display camera ignores stationary ±2m jitter and turns only for confirmed reverse walking", (t) => {
  const view = harness(true);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const points = [
    [0, 0],
    [40, 0],
  ];
  const route = {
    ok: true,
    campusId: "v-78",
    distanceMeters: 40,
    segments: [{ floorId: "f1", points }],
    steps: [
      { kind: "start", floorId: "f1", position: [0, 0] },
      { kind: "walk", floorId: "f1", position: [0, 0] },
      { kind: "arrive", floorId: "f1", position: [40, 0] },
    ],
  };
  const floor = {
    id: "f1",
    polygons: [
      {
        id: "corridor",
        kind: "corridor",
        points: [
          [-5, -2],
          [45, -2],
          [45, 2],
          [-5, 2],
        ],
      },
    ],
    walls: [],
    doors: [],
  };
  const tracker = createRouteTracker(route);
  const display = createRouteLocationDisplay();
  const allowPoint = createRouteTrackingSurfaceGuard(floor);
  view.campus = { id: "v-78" };
  view.floor = floor;
  view.routeLayer = { paths: [{ sourceSegmentIndex: 0, points }] };
  view.callbacks = {
    shouldFollowRouteCamera: () => true,
    getRouteLocationMatch: (location) => location && display.read(now),
  };
  t.after(() => {
    view.setUserLocation(null);
    view.model.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  });
  let index = 0;
  const observe = (x) => {
    now += 1000;
    const location = {
      source: "gps",
      status: "inside",
      campusId: "v-78",
      point: [x, index % 2 ? 4 : -4],
      timestamp: now,
      accuracyMeters: 10,
      accuracyRadiusMap: 10,
      trackingStatus: "live",
    };
    const progress = tracker.update(location, {
      now,
      floorId: "f1",
      pauseOnReverse: true,
      allowPoint,
    });
    display.update({ progress, location, sourceSegmentIndex: 0, now });
    view.setUserLocation(location);
    view.updateNavigationHeading(++index * 1000);
    return progress;
  };
  for (const x of [10, 10, 12, 12, 10, 10, 8, 8, 9, 9, 10, 10, 12, 12]) {
    const progress = observe(x);
    assert.notEqual(progress.status, "wrong-way");
    if (progress.status === "tracking") {
      assert.equal(progress.distance, 10);
      assert.equal(view.routeLocationFix.travelDirection, 1);
      assert.ok(view.camera.up.angleTo(new THREE.Vector3(1, 0, 0)) < 0.001);
    }
  }
  for (const x of [14, 16, 18, 20, 22, 24]) observe(x);
  let backward;
  for (const x of [22, 20, 18, 16]) backward = observe(x);
  assert.equal(backward.status, "wrong-way");
  assert.equal(view.routeLocationFix.travelDirection, -1);
  assert.ok(view.camera.up.angleTo(new THREE.Vector3(-1, 0, 0)) < 0.001);
  observe(16);
  observe(17);
  const forward = observe(18);
  assert.equal(forward.status, "tracking");
  assert.equal(view.routeLocationFix.travelDirection, 1);
  assert.ok(view.camera.up.angleTo(new THREE.Vector3(1, 0, 0)) < 0.001);
});

test("route camera eases across angle wrap without zoom pumping or compass interference", (t) => {
  const { view } = liveHarness(t, true);
  view.focusUserLocation();
  view.reducedMotion = false;
  const bearing = view.routeLocationBearing();
  const initial = bearing - (2 * Math.PI - 0.35);
  view.camera.up.set(-Math.sin(initial), 0, -Math.cos(initial));
  const before = view.camera.up.clone();
  const zoomDistance = view.cameraViewDistance();
  assert.equal(view.updateNavigationHeading(16), true);
  assert.ok(view.camera.up.angleTo(before) > 0);
  assert.ok(
    view.camera.up.angleTo(before) <= (2 * Math.PI) / 180,
    "120 degrees/second cap prevents a jump on the first 16ms frame",
  );
  const desired = new THREE.Vector3(-Math.sin(bearing), 0, -Math.cos(bearing));
  assert.ok(view.camera.up.angleTo(desired) < 0.35, "takes the short arc");
  for (let time = 32; time <= 2000; time += 16) {
    view.navigationBearing = time % 32 ? 0 : Math.PI;
    view.userHeading = { timestamp: Date.now() };
    view.updateNavigationHeading(time);
  }
  assert.ok(view.camera.up.angleTo(desired) < (2 * Math.PI) / 180);
  assert.ok(Math.abs(view.cameraViewDistance() - zoomDistance) < 1e-8);
  assert.equal(
    view.updateNavigationHeading(2016),
    undefined,
    "a completed turn lets rendering sleep",
  );
});

test("preview path color is independent of accepted GPS progress and clears when returning to live guidance", () => {
  const view = harness();
  const displayed = [];
  view.route = { ok: true };
  view.routeLayer = { setProgress: (sample) => displayed.push(sample) };
  const live = sampleRouteGuidance(guide, 0, 10);
  const preview = sampleRouteGuidance(guide, 0, 70);
  const newerLive = sampleRouteGuidance(guide, 0, 20);
  view.setLiveRouteProgress(live);
  view.setRoutePreviewProgress(preview);
  assert.equal(displayed.at(-1), preview);
  assert.equal(view.liveRouteProgress, live);
  view.setLiveRouteProgress(newerLive);
  assert.equal(displayed.at(-1), preview);
  view.setRouteGuidance(null);
  assert.equal(displayed.at(-1), newerLive);
  view.setLiveRouteProgress(null);
  assert.equal(displayed.at(-1), null);
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

test("real navigation can frame the source section without presenting a simulated position", () => {
  const view = harness(true);
  try {
    const sample = sampleRouteGuidance(guide, 0, 10);
    assert.equal(
      view.setRouteGuidance(sample, {
        showMarker: false,
        padding: { bottom: 160 },
      }),
      true,
    );
    assert.equal(view.guidanceLayer.visible, false);
    assert.ok(view.lastBounds);
    assert.equal(view.userLocation, undefined);
    view.setRouteGuidance(sample, { showMarker: true });
    assert.equal(view.guidanceLayer.visible, true);
  } finally {
    view.setRouteGuidance(null);
    view.model.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
});
