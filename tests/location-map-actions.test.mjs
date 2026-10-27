import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { presentUserHeading } from "../src/map/location-view.js";

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
const ring = [
  [-10, -10],
  [10, -10],
  [10, 10],
  [-10, 10],
];
function viewHarness() {
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 500);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const variables = {};
  const floor = {
    id: "f2",
    polygons: [
      { id: "room", kind: "room", building: "Г", points: ring, center: [0, 0] },
    ],
    footprints: [{ points: ring }],
    walls: [],
  };
  const previews = [];
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    host: {
      clientWidth: 400,
      clientHeight: 400,
      dataset: {},
      style: { setProperty: (key, value) => (variables[key] = value) },
    },
    camera,
    plan: true,
    scene: new THREE.Scene(),
    campus: { id: "v-78" },
    floor,
    mode: "floor",
    building: "Г",
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({
          left: 20,
          top: 30,
          width: 400,
          height: 400,
        }),
      },
    },
    controls: {
      target: new THREE.Vector3(),
      update() {},
      mouseButtons: { LEFT: THREE.MOUSE.PAN },
      touches: { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN },
    },
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    labelLayer: { inert: false },
    callbacks: { onPositionPickPreview: (pick) => previews.push(pick) },
    showHover() {},
    invalidate() {},
  });
  return { view, variables, previews };
}
const gps = (point = [1, 2], overrides = {}) => ({
  source: "gps",
  campusId: "v-78",
  point,
  timestamp: Date.now(),
  accuracyMeters: 8,
  accuracyRadiusMap: 8,
  trackingStatus: "live",
  ...overrides,
});

test("explicit recenter uses a close fixed neighborhood while retaining the provider uncertainty", (t) => {
  const { view } = viewHarness();
  t.after(() => view.setUserLocation(null));
  view.setUserLocation(
    gps([1, 2], { accuracyMeters: 180, accuracyRadiusMap: 200 }),
  );
  let request;
  view.fit = (...args) => (request = args);
  assert.equal(view.focusUserLocation(), true);
  assert.deepEqual(request[0], [-11, -10, 13, 14]);
  assert.equal(
    view.userLocationLayer.getObjectByName("gps-provider-accuracy").geometry
      .parameters.radius,
    200,
  );
  assert.deepEqual(view.userLocation.point, [1, 2]);
  assert.deepEqual(view.userLocationFollowAnchor.toArray(), [1, 0.4, 2]);
});

test("following translates an existing camera smoothly without pumping zoom or changing azimuth", (t) => {
  const { view } = viewHarness();
  t.after(() => view.setUserLocation(null));
  view.camera.position.set(10, 100, 20);
  view.camera.zoom = 3.5;
  let fits = 0;
  view.fit = () => fits++;
  view.setUserLocation(gps());
  view.focusUserLocation();
  view.setUserLocation(gps([4, 5]));
  assert.equal(view.followUserLocation(), true);
  assert.equal(fits, 1, "later fixes do not fit the map again");
  assert.deepEqual(view.transition.to.toArray(), [13, 100, 23]);
  assert.deepEqual(view.transition.toTarget.toArray(), [3, 0, 3]);
  assert.deepEqual(
    view.transition.to.clone().sub(view.transition.toTarget).toArray(),
    [10, 100, 20],
  );
  assert.equal(view.camera.zoom, 3.5);
  assert.deepEqual(
    view.camera.position.toArray(),
    [10, 100, 20],
    "the camera eases instead of jumping on callback",
  );
  view.setUserLocation(gps([6, 4]));
  view.followUserLocation();
  assert.deepEqual(
    view.transition.to.toArray(),
    [15, 100, 22],
    "a fix arriving during easing accumulates once",
  );
  assert.deepEqual(view.transition.toTarget.toArray(), [5, 0, 2]);
  const transition = view.transition;
  view.setUserLocation(gps([50, 50], { trackingStatus: "signal-lost" }));
  assert.equal(view.followUserLocation(), false);
  assert.equal(
    view.transition,
    transition,
    "unusable evidence never moves the camera",
  );
});

test("following re-centers once after changing the viewed floor or projection without assigning it as the real floor", (t) => {
  const { view } = viewHarness();
  t.after(() => view.setUserLocation(null));
  let fits = 0;
  view.fit = () => fits++;
  view.setUserLocation(gps());
  view.focusUserLocation();
  view.floor = { ...view.floor, id: "f3" };
  view.refreshUserLocation();
  assert.equal(view.followUserLocation(), true);
  assert.equal(fits, 2);
  assert.equal(view.userLocation.floorId, undefined);
  view.setUserLocation(gps([2, 3]));
  view.followUserLocation();
  assert.equal(
    fits,
    2,
    "subsequent fixes translate instead of re-fitting the new view",
  );
  view.plan = false;
  view.followUserLocation();
  assert.equal(fits, 3, "a new projection gets one close re-center");
  view.setUserLocation(gps([3, 4]));
  view.followUserLocation();
  assert.equal(fits, 3);
});

test("center picker uses the exact crosshair ray inside the visible map and follows manual panning", () => {
  const { view, variables, previews } = viewHarness();
  view.callbacks.getViewportPadding = () => ({ left: 80, bottom: 80 });
  view.setLocationPicking(true);
  const first = view.getCenterLocationPick();
  assert.equal(variables["--location-pick-x"], "240px");
  assert.equal(variables["--location-pick-y"], "160px");
  near(first.point[0], 4);
  near(first.point[1], -4);
  assert.equal(first.roomId, "room");
  assert.notDeepEqual(
    first.point,
    view.floor.polygons[0].center,
    "room identity never snaps a pin to a room center",
  );
  view.camera.position.x += 2;
  view.camera.lookAt(2, 0, 0);
  view.camera.updateMatrixWorld(true);
  const next = view.getCenterLocationPick();
  near(next.point[0], 6);
  near(next.point[1], -4);
  view.floor.walls = [{ a: [6, -10], b: [6, 10], width: 0.2 }];
  assert.equal(view.getCenterLocationPick(), null);
  view.updateLocationPickPreview({ force: true });
  assert.equal(
    previews.at(-1),
    null,
    "a wall disables confirmation rather than moving the pin",
  );
  view.setLocationPicking(false);
  assert.equal(view.getCenterLocationPick(), null);
});

test("pin placement temporarily pans in 3D and restores ordinary map controls", () => {
  const { view } = viewHarness();
  view.plan = false;
  view.setLocationPicking(true);
  assert.equal(view.controls.mouseButtons.LEFT, THREE.MOUSE.PAN);
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_PAN);
  assert.equal(view.controls.enableRotate, false);
  view.setLocationPicking(false);
  assert.equal(view.controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE);
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_ROTATE);
  assert.equal(view.controls.enableRotate, true);
  view.plan = true;
  view.setLocationPicking(true);
  view.setLocationPicking(false);
  assert.equal(view.controls.mouseButtons.LEFT, THREE.MOUSE.PAN);
  assert.equal(view.controls.touches.TWO, THREE.TOUCH.DOLLY_PAN);
  assert.equal(view.controls.enableRotate, false);
});

test("compass direction is transformed through geographic registration and never borrowed from GPS course", () => {
  const now = Date.now();
  const heading = (degrees) => ({
    source: "compass",
    degrees,
    timestamp: now,
    reference: "true",
    accuracyDegrees: 10,
  });
  const north = presentUserHeading(heading(0), null, now);
  const south = presentUserHeading(heading(180), null, now);
  assert.ok(north);
  near(north.vector[0], -south.vector[0]);
  near(north.vector[1], -south.vector[1]);
  const east = presentUserHeading(heading(90), null, now);
  assert.ok(
    Math.abs(
      north.vector[0] * east.vector[1] - north.vector[1] * east.vector[0],
    ) > 0.5,
  );
  assert.equal(
    presentUserHeading({ ...heading(90), source: "gps" }, null, now),
    null,
  );
  assert.equal(
    presentUserHeading({ ...heading(90), reference: "relative" }, null, now),
    null,
  );
  assert.equal(
    presentUserHeading({ ...heading(90), timestamp: now - 5001 }, null, now),
    null,
  );
  assert.equal(
    presentUserHeading({ ...heading(90), accuracyDegrees: -1 }, null, now),
    null,
  );
});

test("heading updates reuse arrow geometry and expire without touching GPS or survey positions", (t) => {
  const { view } = viewHarness();
  t.after(() => {
    view.setUserHeading(null);
    view.setUserLocation(null);
    view.setSurveyLocation(null);
  });
  const reference = {
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [-3, 2],
  };
  view.setSurveyLocation(reference);
  view.setUserLocation(gps());
  const accuracy = view.userLocationLayer.getObjectByName(
    "gps-provider-accuracy",
  );
  const update = (degrees) =>
    view.setUserHeading({
      source: "compass",
      degrees,
      timestamp: Date.now(),
      reference: "magnetic",
      accuracyDegrees: 15,
    });
  update(0);
  const arrow = view.userLocationLayer.userData.heading;
  const geometry = arrow.children[0].geometry;
  const vector = presentUserHeading(view.userHeading, view.userLocation).vector;
  const world = new THREE.Vector3(0, 0, -1).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    arrow.rotation.y,
  );
  near(world.x, vector[0]);
  near(world.z, vector[1]);
  update(90);
  assert.equal(view.userLocationLayer.userData.heading, arrow);
  assert.equal(arrow.children[0].geometry, geometry);
  assert.equal(
    view.userLocationLayer.getObjectByName("gps-provider-accuracy"),
    accuracy,
    "10Hz compass events do not recreate the position circle",
  );
  assert.deepEqual(view.userLocation.point, [1, 2]);
  assert.deepEqual(reference.point, [-3, 2]);
  assert.match(
    view.userLocationLayer.userData.headingPresentation.label,
    /Направление телефона 90°.*магнитный/,
  );
  view.setUserHeading({
    source: "compass",
    degrees: 90,
    timestamp: Date.now() - 6000,
    reference: "true",
  });
  assert.equal(arrow.visible, false);
  assert.equal(view.userLocationLayer.userData.headingPresentation, null);
});
