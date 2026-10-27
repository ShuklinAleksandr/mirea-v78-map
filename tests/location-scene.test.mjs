import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { GPS_MAX_AGE_MS } from "../src/location.js";

function harness() {
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 200);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const room = {
    id: "room-1",
    label: "Г-209",
    building: "Г",
    points: [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ],
  };
  return Object.assign(Object.create(AtlasScene.prototype), {
    host: { clientWidth: 400, clientHeight: 400, style: {}, dataset: {} },
    camera,
    scene: new THREE.Scene(),
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 400,
          height: 400,
        }),
      },
    },
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    campus: { id: "v-78" },
    floor: { id: "f2", polygons: [room] },
    mode: "floor",
    labelLayer: { inert: false },
    callbacks: {},
    invalidate() {},
    showHover() {},
  });
}

test("manual current position projects onto another viewed floor without changing its confirmed floor", () => {
  const view = harness();
  view.setUserLocation({
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [1, 2],
  });
  const layer = view.userLocationLayer;
  assert.equal(layer.visible, true);
  assert.equal(layer.userData.role, "manual-user-location");
  assert.deepEqual(layer.position.toArray(), [1, 0.4, 2]);
  assert.equal(
    layer.children.length,
    1,
    "manual position has no invented GPS accuracy circle",
  );
  view.floor = { id: "f3" };
  view.refreshUserLocation();
  assert.equal(layer.visible, true);
  assert.equal(layer.userData.presentation.floorState, "other-floor");
  assert.equal(layer.userData.presentation.projection, true);
  assert.equal(view.userLocation.floorId, "f2");
  view.setUserLocation(null);
});

test("GPS circle appears in floor and campus views, with an unknown floor and one-shot expiry", (t) => {
  const view = harness();
  t.after(() => view.setUserLocation(null));
  const location = {
    source: "gps",
    campusId: "v-78",
    floorId: null,
    point: [1, 2],
    accuracyMeters: 9,
    accuracyRadiusMap: 10,
    timestamp: Date.now(),
  };
  view.setUserLocation(location);
  assert.equal(view.userLocationLayer.visible, true);
  assert.equal(
    view.userLocationLayer.userData.presentation.floorState,
    "unknown",
  );
  assert.equal(
    view.userLocationLayer.userData.presentation.label,
    "GPS · ±9 м",
  );
  view.mode = "overview";
  view.refreshUserLocation();
  const layer = view.userLocationLayer;
  assert.equal(layer.visible, true);
  assert.equal(layer.userData.role, "gps-location-floor-unknown");
  assert.equal(
    layer.getObjectByName("gps-provider-accuracy").geometry.parameters.radius,
    10,
  );
  view.userLocation.timestamp = Date.now() - GPS_MAX_AGE_MS - 1;
  view.refreshUserLocation();
  assert.equal(layer.visible, false);
});

test("manual map picking returns the existing room identity and rejects map gaps", () => {
  const view = harness();
  assert.equal(view.setLocationPicking(true), true);
  assert.equal(view.labelLayer.inert, true);
  const result = view.pickUserLocation({ clientX: 200, clientY: 200 });
  assert.equal(result.floorId, "f2");
  assert.equal(result.roomId, "room-1");
  assert.equal(result.areaId, "room-1");
  assert.equal(result.building, "Г");
  assert.ok(
    Math.abs(result.point[0]) < 1e-8 && Math.abs(result.point[1]) < 1e-8,
  );
  assert.equal(view.pickUserLocation({ clientX: 399, clientY: 399 }), null);
  view.setLocationPicking(false);
  assert.equal(view.pickUserLocation({ clientX: 200, clientY: 200 }), null);
  assert.equal(view.labelLayer.inert, false);
  view.mode = "overview";
  assert.equal(view.setLocationPicking(true), false);
});

test("stack builder views never dispose or move the real user's marker", () => {
  const parent = harness();
  parent.setUserLocation({
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [1, 2],
  });
  const layer = parent.userLocationLayer;
  const count = layer.children.length;
  const stack = Object.assign(Object.create(parent), { stackDisplay: true });
  stack.refreshUserLocation();
  assert.equal(layer.children.length, count);
  assert.equal(layer.visible, true);
  parent.setUserLocation(null);
});

function withLabelDocument(t, view) {
  const previous = globalThis.document;
  const element = () => ({
    style: {},
    dataset: {},
    hidden: false,
    attributes: {},
    children: [],
    textContent: "",
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    append(...children) {
      this.children.push(...children);
    },
    classList: { toggle() {} },
  });
  globalThis.document = { createElement: element, querySelectorAll: () => [] };
  t.after(() => {
    globalThis.document = previous;
  });
  const overlays = [];
  view.host.append = (overlay) => overlays.push(overlay);
  view.host.getBoundingClientRect = () => ({ x: 0, y: 0 });
  view.labelsOn = true;
  return { element, overlays };
}

test("current location owns its projected pixel ahead of a room label without moving world position", (t) => {
  const view = harness();
  const { element, overlays } = withLabelDocument(t, view);
  const ordinaryLabel = element();
  ordinaryLabel.textContent = "Г-209";
  const otherLabel = element();
  otherLabel.textContent = "Другая аудитория";
  view.roomLabels = [
    {
      el: ordinaryLabel,
      id: "room-1",
      kind: "room",
      position: new THREE.Vector3(1, 0.4, 2),
    },
    {
      el: otherLabel,
      id: "room-2",
      kind: "room",
      position: new THREE.Vector3(12, 0.4, -12),
    },
  ];
  const location = {
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [1, 2],
  };
  view.setUserLocation(location);
  const originalPosition = view.userLocationLayer.position.clone();
  view.updateLabels();
  assert.equal(
    ordinaryLabel.style.display,
    "none",
    "room text cannot cover the current position",
  );
  assert.equal(
    otherLabel.style.display,
    "block",
    "unrelated labels retain their normal layout",
  );
  assert.equal(overlays.length, 1);
  assert.equal(view.userLocationOverlay.hidden, false);
  assert.equal(view.userLocationCaption.textContent, "Я здесь");
  const projected = originalPosition.clone().project(view.camera);
  const expectedX = (projected.x * 0.5 + 0.5) * view.host.clientWidth;
  const expectedY = (-projected.y * 0.5 + 0.5) * view.host.clientHeight;
  assert.equal(
    view.userLocationOverlay.style.transform,
    `translate(${expectedX}px,${expectedY}px)`,
  );
  assert.deepEqual(
    view.userLocationLayer.position.toArray(),
    originalPosition.toArray(),
  );
  assert.deepEqual(location.point, [1, 2]);
  view.setUserLocation(null);
  assert.equal(view.userLocationOverlay.hidden, true);
});

test("route clearing and floor rebuilds preserve the current marker with explicit floor projection", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  view.roomLabels = [];
  view.refreshRoute = () => {};
  view.setUserLocation({
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [1, 2],
  });
  const layer = view.userLocationLayer;
  const overlay = view.userLocationOverlay;
  view.clearRoute({ rebuild: false });
  assert.equal(layer.visible, true);
  assert.equal(overlay.hidden, false);
  Object.assign(view, {
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: { replaceChildren() {} },
  });
  view.clear();
  assert.deepEqual(
    view.userLocation.point,
    [1, 2],
    "floor rebuild clears geometry without clearing the chosen position",
  );
  assert.equal(overlay.hidden, true);
  view.floor = { id: "f3" };
  view.refreshUserLocation();
  assert.equal(layer.visible, true);
  assert.equal(overlay.hidden, false);
  assert.match(view.userLocationCaption.textContent, /другой этаж/);
  assert.equal(overlay.dataset.projection, "true");
  view.floor = { id: "f2" };
  view.refreshUserLocation();
  assert.equal(layer.visible, true);
  assert.equal(overlay.hidden, false);
  assert.deepEqual(layer.position.toArray(), [1, 0.4, 2]);
  view.setUserLocation(null);
});

test("GPS is shown in every map view without assigning the viewed floor", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  t.after(() => view.setUserLocation(null));
  const location = {
    source: "gps",
    campusId: "v-78",
    point: [1, 2],
    floorId: null,
    floorEvidence: "unknown",
    accuracyMeters: 12,
    accuracyRadiusMap: 13,
    timestamp: Date.now(),
    trackingStatus: "live",
  };
  view.setUserLocation(location);
  for (const mode of [
    "overview",
    "floor",
    "building-overview",
    "route-overview",
  ]) {
    view.mode = mode;
    view.routeStages = [{ floorId: "f2", y: 7.2 }];
    view.refreshUserLocation();
    assert.equal(view.userLocationLayer.visible, true, mode);
    assert.equal(view.userLocationOverlay.dataset.floorState, "unknown", mode);
    assert.equal(view.userLocationOverlay.dataset.projection, "true", mode);
    assert.equal(view.userLocationCaption.textContent, "GPS · ±12 м");
    assert.match(
      view.userLocationOverlay.attributes["aria-label"],
      /этаж не определён автоматически/,
    );
    assert.equal(view.userLocation.floorId, null);
    assert.equal(view.userLocation.floorEvidence, "unknown");
    assert.ok(
      Math.abs(
        view.userLocationLayer.position.y -
          (mode.endsWith("-overview") ? 7.6 : 0.4),
      ) < 1e-10,
    );
  }
});

test("confirmed floor uses its real stack stage and a missing stage is visibly a projection", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  view.mode = "building-overview";
  view.floor = { id: "f3" };
  view.routeStages = [
    { floorId: "f2", y: 3.6 },
    { floorId: "f3", y: 7.2 },
  ];
  const location = {
    source: "manual",
    campusId: "v-78",
    point: [1, 2],
    floorId: "f2",
    floorEvidence: "manual",
    physicalLevel: 2,
  };
  view.setUserLocation(location);
  assert.equal(view.userLocationLayer.position.y, 4);
  assert.equal(view.userLocationOverlay.dataset.projection, "false");
  assert.match(view.userLocationCaption.textContent, /2 этаж/);
  view.routeStages = [{ floorId: "f3", y: 7.2 }];
  view.refreshUserLocation();
  assert.ok(Math.abs(view.userLocationLayer.position.y - 7.6) < 1e-10);
  assert.equal(view.userLocationOverlay.dataset.projection, "true");
  assert.equal(location.floorId, "f2");
  view.mode = "overview";
  view.refreshUserLocation();
  assert.equal(view.userLocationLayer.visible, true);
  assert.match(view.userLocationCaption.textContent, /2 этаж/);
  view.setUserLocation(null);
});

test("a live GPS point outside the selected wing remains visible without clamping its position", (t) => {
  const view = harness();
  t.after(() => view.setUserLocation(null));
  view.clipPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -10)];
  view.setUserLocation({
    source: "gps",
    campusId: "v-78",
    point: [1, 2],
    timestamp: Date.now(),
    accuracyRadiusMap: 15,
    accuracyMeters: 14,
    floorEvidence: "unknown",
    trackingStatus: "live",
  });
  assert.equal(view.userLocationLayer.visible, true);
  assert.deepEqual(view.userLocationLayer.position.toArray(), [1, 0.4, 2]);
  assert.equal(
    view.userLocationLayer.getObjectByName("gps-provider-accuracy").geometry
      .parameters.radius,
    15,
  );
});

test("continuous tracking retains a dim last position after expiry or signal loss", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  t.after(() => view.setUserLocation(null));
  const timestamp = Date.now() - GPS_MAX_AGE_MS - 100;
  view.setUserLocation({
    source: "gps",
    campusId: "v-78",
    point: [1, 2],
    timestamp,
    trackingStatus: "signal-lost",
    floorId: "f2",
    floorEvidence: "manual",
    physicalLevel: 2,
  });
  assert.equal(view.userLocationLayer.visible, true);
  assert.equal(view.userLocationOverlay.dataset.stale, "true");
  assert.match(
    view.userLocationCaption.textContent,
    /^Последняя позиция · 2 этаж/,
  );
  assert.equal(view.userLocationOverlay.style.opacity, "0.65");
  assert.equal(
    view.userLocation.timestamp,
    timestamp,
    "rendering never refreshes old evidence",
  );
});

test("Wi-Fi survey reference stays fixed while live GPS moves and is limited to its own floor", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  t.after(() => {
    view.setUserLocation(null);
    view.setSurveyLocation(null);
  });
  const reference = {
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    physicalLevel: 2,
    point: [-3, 2],
  };
  view.setSurveyLocation(reference);
  const layer = view.surveyLocationLayer;
  assert.equal(layer.visible, true);
  assert.equal(layer.userData.role, "wifi-survey-reference");
  assert.match(view.surveyLocationCaption.textContent, /^Точка замера/);
  for (const point of [
    [1, 2],
    [4, 5],
  ]) {
    view.setUserLocation({
      source: "gps",
      campusId: "v-78",
      point,
      timestamp: Date.now(),
      trackingStatus: "live",
    });
    assert.deepEqual(layer.position.toArray(), [-3, 0.4, 2]);
    assert.deepEqual(reference.point, [-3, 2]);
    assert.notEqual(view.userLocationLayer, layer);
  }
  view.floor = { id: "f3" };
  view.refreshUserLocation();
  assert.equal(layer.visible, false);
  assert.equal(view.userLocationLayer.visible, true);
  view.mode = "building-overview";
  view.routeStages = [
    { floorId: "f2", y: 3.6 },
    { floorId: "f3", y: 7.2 },
  ];
  view.refreshUserLocation();
  assert.equal(layer.visible, true);
  assert.deepEqual(layer.position.toArray(), [-3, 4, 2]);
  view.mode = "overview";
  view.refreshUserLocation();
  assert.equal(layer.visible, false);
});

test("focus current position keeps the map view and targets the visible stack height", () => {
  const view = harness();
  view.mode = "route-overview";
  view.routeStages = [{ floorId: "f2", y: 7.2 }];
  view.setUserLocation({
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    point: [1, 2],
  });
  let request;
  view.fit = (...args) => {
    request = args;
  };
  assert.equal(view.focusUserLocation(), true);
  assert.equal(view.mode, "route-overview");
  assert.deepEqual(request[0], [-11, -10, 13, 14]);
  assert.ok(Math.abs(request[3].targetY - 7.6) < 1e-10);
  assert.ok(Math.abs(request[3].verticalBounds[0] - 6.6) < 1e-10);
  assert.ok(Math.abs(request[3].verticalBounds[1] - 9.6) < 1e-10);
  view.setUserLocation(null);
});

test("active manual GPS offset is labelled as an approximate correction with unchanged provider accuracy", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  t.after(() => view.setUserLocation(null));
  const location = {
    source: "gps",
    campusId: "v-78",
    floorId: "f2",
    floorEvidence: "manual",
    physicalLevel: 2,
    point: [1, 2],
    timestamp: Date.now(),
    trackingStatus: "live",
    accuracyMeters: 23,
    accuracyRadiusMap: 25,
    correction: {
      type: "manual-offset",
      approximate: true,
      expiresAt: Date.now() + 30_000,
      offset: [2, 3],
    },
  };
  view.setUserLocation(location);
  assert.match(
    view.userLocationCaption.textContent,
    /^GPS с поправкой · 2 этаж · ±23 м$/,
  );
  assert.equal(
    view.userLocationLayer.getObjectByName("gps-provider-accuracy").geometry
      .parameters.radius,
    25,
  );
  location.correction.expiresAt = Date.now() - 1;
  view.refreshUserLocation();
  assert.match(view.userLocationCaption.textContent, /^Последняя позиция/);
  assert.equal(view.userLocationOverlay.dataset.stale, "true");
});

test("a manual anchor with no usable GPS update is explicitly labelled manual and unrefreshed", (t) => {
  const view = harness();
  withLabelDocument(t, view);
  view.setUserLocation({
    source: "manual",
    campusId: "v-78",
    floorId: "f2",
    floorEvidence: "manual",
    physicalLevel: 2,
    point: [1, 2],
    trackingStatus: "needs-refinement",
  });
  assert.equal(
    view.userLocationCaption.textContent,
    "Указано вручную · нет обновления · 2 этаж",
  );
  assert.equal(view.userLocationOverlay.dataset.source, "manual");
  assert.equal(view.userLocationOverlay.dataset.stale, "true");
  assert.equal(
    view.userLocationLayer.children.length,
    1,
    "a manual fallback never acquires GPS accuracy evidence",
  );
  view.setUserLocation(null);
});
