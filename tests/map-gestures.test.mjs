import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AtlasScene } from "../src/map/scene.js";
import {
  configureMapTouchControls,
  bindMapTouchRotation,
  TWO_FINGER_ROTATION_MULTIPLIER,
  createMapTapGuard,
} from "../src/map/gestures.js";

// Node's EventTarget invokes capture listeners in registration order instead of
// the browser's capture-before-target order. Exercise the actual input boundary
// here: the gesture classifier precedes OrbitControls even on pointerdown.
function pointerElement() {
  const listeners = new Map();
  const captureOf = (options) =>
    typeof options === "boolean" ? options : Boolean(options?.capture);
  return {
    addEventListener(type, callback, options) {
      const entries = listeners.get(type) || [];
      const capture = captureOf(options);
      if (
        !entries.some(
          (entry) => entry.callback === callback && entry.capture === capture,
        )
      )
        entries.push({ callback, capture });
      listeners.set(type, entries);
    },
    removeEventListener(type, callback, options) {
      const capture = captureOf(options);
      listeners.set(
        type,
        (listeners.get(type) || []).filter(
          (entry) => entry.callback !== callback || entry.capture !== capture,
        ),
      );
    },
    dispatchEvent(event) {
      const entries = [...(listeners.get(event.type) || [])];
      for (const capture of [true, false])
        for (const entry of entries) {
          if (
            entry.capture === capture &&
            listeners.get(event.type)?.includes(entry)
          )
            entry.callback.call(this, event);
        }
      return !event.defaultPrevented;
    },
  };
}

function harness(
  plan = false,
  {
    fastTouch = true,
    rotateSpeed = 1,
    multiplier = TWO_FINGER_ROTATION_MULTIPLIER,
    damping = false,
  } = {},
) {
  const timers = new Map();
  let nextTimer = 0;
  const element = Object.assign(pointerElement(), {
    style: {},
    clientWidth: 390,
    clientHeight: 844,
    setPointerCapture() {},
    releasePointerCapture() {},
    getRootNode: () => document,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }),
  });
  const document = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(),
  });
  element.ownerDocument = document;
  const perspectiveCamera = new THREE.PerspectiveCamera(
    38,
    390 / 844,
    0.5,
    5000,
  );
  const planCamera = new THREE.OrthographicCamera(
    -100,
    100,
    100,
    -100,
    0.5,
    5000,
  );
  perspectiveCamera.position.set(110, 90, 130);
  planCamera.up.set(0, 0, -1);
  const controls = new OrbitControls(perspectiveCamera, element);
  controls.screenSpacePanning = true;
  controls.enableDamping = damping;
  controls.rotateSpeed = rotateSpeed;
  configureMapTouchControls(controls, false);
  const touchRotation = fastTouch
    ? bindMapTouchRotation(controls, {
        multiplier,
        setTimer(callback) {
          const id = ++nextTimer;
          timers.set(id, callback);
          return id;
        },
        clearTimer(id) {
          timers.delete(id);
        },
      })
    : null;
  if (plan)
    AtlasScene.prototype.setProjection.call(
      {
        perspectiveCamera,
        planCamera,
        camera: perspectiveCamera,
        controls,
        plan: false,
        invalidate() {},
      },
      true,
    );
  controls.update();
  const camera = plan ? planCamera : perspectiveCamera;
  const tap = createMapTapGuard();
  let picks = 0;
  element.addEventListener("pointerdown", (event) => tap.down(event));
  element.addEventListener("pointermove", (event) => tap.move(event));
  element.addEventListener("pointerup", (event) => {
    if (tap.up(event)) picks++;
  });
  element.addEventListener("pointercancel", (event) => tap.cancel(event));
  element.addEventListener("lostpointercapture", (event) => tap.cancel(event));
  const pointer = (type, id, x, y, extra = {}) => {
    const event = Object.assign(new Event(type), {
      pointerId: id,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      ...extra,
    });
    element.dispatchEvent(event);
  };
  return {
    camera,
    controls,
    pointer,
    element,
    window: document.defaultView,
    touchRotation,
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    get pendingTimers() {
      return timers.size;
    },
    dispose() {
      touchRotation?.dispose();
      controls.dispose();
    },
    get picks() {
      return picks;
    },
  };
}

test("3D: one finger moves the map without rotating or zooming", () => {
  const h = harness();
  try {
    const target = h.controls.target.clone();
    const offset = h.camera.position.clone().sub(target);
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointermove", 1, 160, 140);
    h.pointer("pointerup", 1, 160, 140);
    assert.ok(h.controls.target.distanceTo(target) > 1);
    assert.ok(
      h.camera.position.clone().sub(h.controls.target).distanceTo(offset) <
        1e-8,
    );
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

test("3D: parallel two-finger drag rotates; a fresh pinch changes only scale", () => {
  const h = harness();
  try {
    const target = h.controls.target.clone();
    const angle = h.controls.getAzimuthalAngle();
    const distance = h.camera.position.distanceTo(target);
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    h.pointer("pointermove", 1, 150, 120);
    h.pointer("pointermove", 2, 250, 120);
    assert.ok(Math.abs(h.controls.getAzimuthalAngle() - angle) > 0.1);
    assert.ok(h.controls.target.distanceTo(target) < 1e-8);
    assert.ok(Math.abs(h.camera.position.distanceTo(target) - distance) < 1e-8);
    h.pointer("pointerup", 2, 250, 120);
    h.pointer("pointerup", 1, 150, 120);
    const pinchAngle = h.controls.getAzimuthalAngle();
    h.pointer("pointerdown", 1, 150, 120);
    h.pointer("pointerdown", 2, 250, 120);
    h.pointer("pointermove", 1, 130, 120);
    h.pointer("pointermove", 2, 270, 120);
    assert.ok(Math.abs(h.controls.getAzimuthalAngle() - pinchAngle) < 1e-8);
    assert.ok(h.camera.position.distanceTo(target) < distance);
    h.pointer("pointerup", 2, 270, 120);
    h.pointer("pointerup", 1, 130, 120);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

test("2D: one finger pans, two fingers pan and pinch without tilting the plan", () => {
  const h = harness(true);
  try {
    const target = h.controls.target.clone();
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointermove", 1, 140, 140);
    assert.ok(h.controls.target.distanceTo(target) > 1);
    h.pointer("pointerdown", 2, 240, 140);
    const twoFingerTarget = h.controls.target.clone();
    h.pointer("pointermove", 1, 180, 180);
    h.pointer("pointermove", 2, 280, 180);
    assert.ok(h.controls.target.distanceTo(twoFingerTarget) > 1);
    assert.ok(Math.abs(h.camera.zoom - 1) < 1e-8);
    h.pointer("pointerup", 2, 280, 180);
    h.pointer("pointerup", 1, 180, 180);
    h.pointer("pointerdown", 1, 180, 180);
    h.pointer("pointerdown", 2, 280, 180);
    h.pointer("pointermove", 1, 160, 180);
    h.pointer("pointermove", 2, 300, 180);
    assert.ok(h.camera.zoom > 1);
    const direction = h.camera.position
      .clone()
      .sub(h.controls.target)
      .normalize();
    assert.ok(Math.hypot(direction.x, direction.z) < 0.00001);
    h.pointer("pointerup", 1, 160, 180);
    h.pointer("pointerup", 2, 300, 180);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

test("desktop: left drag still rotates 3D, right drag pans, and left drag pans 2D", () => {
  for (const [plan, button] of [
    [false, 0],
    [false, 2],
    [true, 0],
  ]) {
    const h = harness(plan);
    try {
      const target = h.controls.target.clone();
      const angle = h.controls.getAzimuthalAngle();
      const mouse = { pointerType: "mouse", button };
      h.pointer("pointerdown", 1, 100, 100, mouse);
      h.pointer("pointermove", 1, 150, 140, mouse);
      h.pointer("pointerup", 1, 150, 140, mouse);
      if (!plan && button === 0) {
        assert.ok(Math.abs(h.controls.getAzimuthalAngle() - angle) > 0.1);
        assert.ok(h.controls.target.distanceTo(target) < 1e-8);
      } else assert.ok(h.controls.target.distanceTo(target) > 1);
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  }
});

test("a single stationary touch or primary mouse click selects once", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerup", 1, 102, 101);
    assert.equal(h.picks, 1);
    const mouse = { pointerType: "mouse" };
    h.pointer("pointerdown", 2, 100, 100, mouse);
    h.pointer("pointerup", 2, 100, 100, mouse);
    assert.equal(h.picks, 2);
  } finally {
    h.dispose();
  }
});

test("neither finger selects after an unmoved two-finger gesture in either release order", () => {
  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    const h = harness();
    try {
      h.pointer("pointerdown", 1, 100, 100);
      h.pointer("pointerdown", 2, 200, 100);
      for (const id of order) h.pointer("pointerup", id, id * 100, 100);
      assert.equal(h.picks, 0);
      h.pointer("pointerdown", 3, 100, 100);
      h.pointer("pointerup", 3, 100, 100);
      assert.equal(h.picks, 1, "a later independent tap still works");
    } finally {
      h.dispose();
    }
  }
});

test("a returning drag, cancelled or uncaptured pointer, and secondary click never select", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointermove", 1, 150, 100);
    h.pointer("pointermove", 1, 100, 100);
    h.pointer("pointerup", 1, 100, 100);
    h.pointer("pointerdown", 2, 100, 100);
    h.pointer("pointercancel", 2, 100, 100);
    h.pointer("pointerup", 2, 100, 100);
    const mouse = { pointerType: "mouse", button: 2 };
    h.pointer("pointerdown", 3, 100, 100, mouse);
    h.pointer("pointerup", 3, 100, 100, mouse);
    h.pointer("pointerdown", 4, 100, 100);
    h.pointer("lostpointercapture", 4, 100, 100);
    h.pointer("pointerup", 4, 100, 100);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

function dragTwoFingers(h) {
  const angle = h.controls.getAzimuthalAngle();
  h.pointer("pointerdown", 1, 100, 100);
  h.pointer("pointerdown", 2, 200, 100);
  h.pointer("pointermove", 1, 120, 100);
  h.pointer("pointermove", 2, 220, 100);
  const rotation = Math.abs(h.controls.getAzimuthalAngle() - angle);
  h.pointer("pointerup", 2, 220, 100);
  h.pointer("pointerup", 1, 120, 100);
  return rotation;
}

test("deliberate parallel drag retains its 2.5x speed after the intent threshold", () => {
  const baseline = harness(false, { multiplier: 1, rotateSpeed: 1.3 });
  const faster = harness(false, { rotateSpeed: 1.3 });
  try {
    const normalTurn = dragTwoFingers(baseline);
    const fasterTurn = dragTwoFingers(faster);
    assert.ok(normalTurn > 0.01);
    assert.ok(
      Math.abs(fasterTurn / normalTurn - TWO_FINGER_ROTATION_MULTIPLIER) < 1e-8,
    );
    assert.equal(faster.controls.rotateSpeed, 1.3);
    assert.equal(faster.controls.zoomSpeed, 1);
    assert.equal(faster.picks, 0);
  } finally {
    baseline.dispose();
    faster.dispose();
  }
});

test("sequential parallel pointer events never produce even a temporary zoom", () => {
  for (const plan of [false, true]) {
    const h = harness(plan);
    try {
      const distance = h.camera.position.distanceTo(h.controls.target);
      const zoom = h.camera.zoom;
      h.pointer("pointerdown", 1, 100, 100);
      h.pointer("pointerdown", 2, 200, 100);
      for (let step = 1; step <= 5; step++) {
        for (const id of [1, 2]) {
          h.pointer("pointermove", id, id * 100 + step * 10, 100 + step * 4);
          assert.ok(
            Math.abs(
              h.camera.position.distanceTo(h.controls.target) - distance,
            ) < 1e-8,
          );
          assert.equal(h.camera.zoom, zoom);
        }
      }
      assert.equal(h.pendingTimers, 0);
    } finally {
      h.dispose();
    }
  }
});

test("asymmetric pinch changes scale without rotation or panning in either projection", () => {
  for (const plan of [false, true]) {
    const h = harness(plan, { damping: true });
    try {
      const offset = h.camera.position
        .clone()
        .sub(h.controls.target)
        .normalize();
      const target = h.controls.target.clone();
      const distance = h.camera.position.distanceTo(target);
      h.pointer("pointerdown", 1, 100, 100);
      h.pointer("pointerdown", 2, 200, 100);
      for (let step = 1; step <= 5; step++) {
        h.pointer("pointermove", 1, 100 - step * 6, 100 + step);
        h.pointer("pointermove", 2, 200 + step * 12, 100 + step * 2);
        assert.ok(
          h.camera.position
            .clone()
            .sub(h.controls.target)
            .normalize()
            .distanceTo(offset) < 1e-8,
        );
        assert.ok(h.controls.target.distanceTo(target) < 1e-8);
      }
      if (plan) assert.ok(h.camera.zoom > 1.5);
      else assert.ok(h.camera.position.distanceTo(target) < distance * 0.75);
      h.pointer("pointerup", 2, 260, 110);
      h.pointer("pointerup", 1, 70, 105);
      const finalDistance = h.camera.position.distanceTo(target),
        finalZoom = h.camera.zoom;
      for (let i = 0; i < 60; i++) h.controls.update();
      assert.ok(
        Math.abs(h.camera.position.distanceTo(target) - finalDistance) < 1e-8,
      );
      assert.equal(h.camera.zoom, finalZoom, "no zoom continues after release");
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  }
});

test("a short pinch with one stationary finger finishes without another move", () => {
  for (const plan of [false, true])
    for (const finish of ["timer", "release"]) {
      const h = harness(plan);
      try {
        const distance = h.camera.position.distanceTo(h.controls.target);
        const direction = h.camera.position
          .clone()
          .sub(h.controls.target)
          .normalize();
        h.pointer("pointerdown", 1, 100, 100);
        h.pointer("pointerdown", 2, 200, 100);
        h.pointer("pointermove", 2, 240, 100);
        assert.ok(
          Math.abs(h.camera.position.distanceTo(h.controls.target) - distance) <
            1e-8,
        );
        assert.equal(h.camera.zoom, 1);
        if (finish === "timer") h.flushTimers();
        else h.pointer("pointerup", 2, 240, 100);
        if (plan) assert.ok(Math.abs(h.camera.zoom - 1.4) < 1e-8);
        else
          assert.ok(
            Math.abs(
              h.camera.position.distanceTo(h.controls.target) - distance / 1.4,
            ) < 1e-8,
          );
        assert.ok(
          h.camera.position
            .clone()
            .sub(h.controls.target)
            .normalize()
            .distanceTo(direction) < 1e-8,
        );
        assert.equal(h.pendingTimers, 0);
        assert.equal(h.picks, 0);
      } finally {
        h.dispose();
      }
    }
});

test("pinch respects public distance/zoom limits and disabled zoom", () => {
  for (const plan of [false, true])
    for (const enabled of [false, true]) {
      const h = harness(plan);
      try {
        const distance = h.camera.position.distanceTo(h.controls.target);
        h.controls.enableZoom = enabled;
        h.controls.minDistance = distance * 0.9;
        h.controls.maxZoom = 1.1;
        h.pointer("pointerdown", 1, 100, 100);
        h.pointer("pointerdown", 2, 200, 100);
        h.pointer("pointermove", 2, 300, 100);
        h.flushTimers();
        if (plan)
          assert.ok(Math.abs(h.camera.zoom - (enabled ? 1.1 : 1)) < 1e-8);
        else
          assert.ok(
            Math.abs(
              h.camera.position.distanceTo(h.controls.target) -
                distance * (enabled ? 0.9 : 1),
            ) < 1e-8,
          );
      } finally {
        h.dispose();
      }
    }
});

test("gesture intent remains stable until a finger lifts, then a new pinch works", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    h.pointer("pointermove", 1, 120, 100);
    h.pointer("pointermove", 2, 220, 100);
    const distance = h.camera.position.distanceTo(h.controls.target);
    h.pointer("pointermove", 1, 100, 100);
    h.pointer("pointermove", 2, 250, 100);
    assert.ok(
      Math.abs(h.camera.position.distanceTo(h.controls.target) - distance) <
        1e-8,
    );
    h.pointer("pointerup", 2, 250, 100);
    assert.equal(h.controls.rotateSpeed, 1);
    h.pointer("pointerdown", 3, 250, 100);
    h.pointer("pointermove", 1, 80, 100);
    h.pointer("pointermove", 3, 280, 100);
    assert.ok(h.camera.position.distanceTo(h.controls.target) < distance);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

test("desktop drag retains its speed, including while touch contacts exist", () => {
  for (const simultaneousTouches of [false, true]) {
    const baseline = harness(false, { fastTouch: false, rotateSpeed: 1.4 });
    const separated = harness(false, { rotateSpeed: 1.4 });
    try {
      for (const h of [baseline, separated]) {
        if (simultaneousTouches) {
          h.pointer("pointerdown", 1, 100, 100);
          h.pointer("pointerdown", 2, 200, 100);
        }
        const mouse = { pointerType: "mouse", button: 0 };
        h.pointer("pointerdown", 3, 120, 100, mouse);
        h.pointer("pointermove", 3, 170, 110, mouse);
        assert.equal(h.controls.rotateSpeed, 1.4);
        assert.equal(h.controls.zoomSpeed, 1);
        h.pointer("pointerup", 3, 170, 110, mouse);
      }
      assert.ok(
        baseline.camera.position.distanceTo(separated.camera.position) < 1e-8,
      );
    } finally {
      baseline.dispose();
      separated.dispose();
    }
  }
});

test("third contact blocks the old intent and lifting back to one permits a fresh pair", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    h.pointer("pointermove", 1, 120, 100);
    h.pointer("pointermove", 2, 220, 100);
    h.pointer("pointerdown", 3, 300, 100);
    h.pointer("pointerup", 3, 300, 100);
    const position = h.camera.position.clone();
    h.pointer("pointermove", 1, 90, 100);
    h.pointer("pointermove", 2, 250, 100);
    h.flushTimers();
    assert.ok(h.camera.position.distanceTo(position) < 1e-8);
    h.pointer("pointerup", 2, 250, 100);
    h.pointer("pointerdown", 4, 250, 100);
    const distance = h.camera.position.distanceTo(h.controls.target);
    h.pointer("pointermove", 1, 70, 100);
    h.pointer("pointermove", 4, 280, 100);
    assert.ok(h.camera.position.distanceTo(h.controls.target) < distance);
  } finally {
    h.dispose();
  }
});

test("cancel, capture loss, blur and disposal discard pending zoom and restore speeds", () => {
  for (const finish of [
    "pointercancel",
    "lostpointercapture",
    "blur",
    "dispose",
  ]) {
    const h = harness(false, { rotateSpeed: 1.6 });
    try {
      const position = h.camera.position.clone();
      h.pointer("pointerdown", 1, 100, 100);
      h.pointer("pointerdown", 2, 200, 100);
      h.pointer("pointermove", 2, 240, 100);
      assert.equal(h.pendingTimers, 1);
      if (finish === "blur") h.window.dispatchEvent(new Event("blur"));
      else if (finish === "dispose") h.touchRotation.dispose();
      else h.pointer(finish, 2, 240, 100);
      h.flushTimers();
      assert.equal(h.pendingTimers, 0);
      assert.ok(h.camera.position.distanceTo(position) < 1e-8);
      assert.equal(h.controls.rotateSpeed, 1.6, finish);
      assert.equal(h.controls.zoomSpeed, 1, finish);
      assert.equal(h.controls.panSpeed, 1, finish);
    } finally {
      h.dispose();
    }
  }
});

test("changing projection during a pair cancels pending zoom until a fresh pair", () => {
  const h = harness();
  try {
    const position = h.camera.position.clone();
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    h.pointer("pointermove", 2, 240, 100);
    configureMapTouchControls(h.controls, true);
    h.controls.enableRotate = false;
    h.flushTimers();
    h.pointer("pointermove", 1, 80, 100);
    h.pointer("pointermove", 2, 280, 100);
    assert.ok(h.camera.position.distanceTo(position) < 1e-8);
    h.pointer("pointerup", 2, 280, 100);
    h.pointer("pointerup", 1, 80, 100);
    assert.equal(h.controls.rotateSpeed, 1);
    assert.equal(h.controls.zoomSpeed, 1);
    assert.equal(h.controls.panSpeed, 1);
  } finally {
    h.dispose();
  }
});

test("disposing restores standard OrbitControls behavior and removes gesture listeners", () => {
  const baseline = harness(false, { fastTouch: false });
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    h.touchRotation.dispose();
    h.touchRotation.dispose();
    assert.equal(h.controls.rotateSpeed, 1);
    assert.equal(h.controls.zoomSpeed, 1);
    h.pointer("pointerup", 1, 100, 100);
    h.pointer("pointerup", 2, 200, 100);
    const afterDispose = dragTwoFingers(h),
      unbound = dragTwoFingers(baseline);
    assert.ok(
      Math.abs(afterDispose - unbound) < 1e-8,
      `${afterDispose} versus ${unbound}`,
    );
  } finally {
    h.dispose();
    baseline.dispose();
  }
});
