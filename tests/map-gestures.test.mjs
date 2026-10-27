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

function harness(plan = false, { fastTouch = true, rotateSpeed = 1 } = {}) {
  const element = Object.assign(new EventTarget(), {
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
  controls.rotateSpeed = rotateSpeed;
  configureMapTouchControls(controls, false);
  const touchRotation = fastTouch ? bindMapTouchRotation(controls) : null;
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

test("3D: two fingers rotate the view and a pinch changes its scale", () => {
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
    h.pointer("pointermove", 1, 130, 120);
    h.pointer("pointermove", 2, 270, 120);
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

test("two-finger 3D drag turns 2.5 times faster with the real OrbitControls", () => {
  const baseline = harness(false, { fastTouch: false, rotateSpeed: 1.3 });
  const faster = harness(false, { rotateSpeed: 1.3 });
  try {
    const normalTurn = dragTwoFingers(baseline);
    const fasterTurn = dragTwoFingers(faster);
    assert.ok(normalTurn > 0.01);
    assert.ok(
      Math.abs(fasterTurn / normalTurn - TWO_FINGER_ROTATION_MULTIPLIER) < 1e-8,
    );
    assert.equal(faster.controls.rotateSpeed, 1.3);
    assert.equal(faster.picks, 0);
  } finally {
    baseline.dispose();
    faster.dispose();
  }
});

test("two-finger rotation stays faster when a finger is lifted and replaced", () => {
  for (const endNotification of [false, true]) {
    const baseline = harness(false, { fastTouch: false, rotateSpeed: 1.3 });
    const faster = harness(false, { rotateSpeed: 1.3 });
    try {
      const turns = [];
      for (const h of [baseline, faster]) {
        h.pointer("pointerdown", 1, 100, 100);
        h.pointer("pointerdown", 2, 200, 100);
        h.pointer("pointerup", 2, 200, 100);
        assert.equal(h.controls.rotateSpeed, 1.3);
        if (endNotification) h.controls.dispatchEvent({ type: "end" });
        h.pointer("pointerdown", 3, 200, 100);
        assert.equal(
          h.controls.rotateSpeed,
          h === faster ? 1.3 * TWO_FINGER_ROTATION_MULTIPLIER : 1.3,
        );
        const angle = h.controls.getAzimuthalAngle();
        h.pointer("pointermove", 1, 120, 100);
        h.pointer("pointermove", 3, 220, 100);
        turns.push(Math.abs(h.controls.getAzimuthalAngle() - angle));
        h.pointer("pointerup", 3, 220, 100);
        h.pointer("pointerup", 1, 120, 100);
        assert.equal(h.controls.rotateSpeed, 1.3);
        assert.equal(h.picks, 0);
      }
      assert.ok(turns[0] > 0.01);
      assert.ok(
        Math.abs(turns[1] / turns[0] - TWO_FINGER_ROTATION_MULTIPLIER) < 1e-8,
      );
    } finally {
      baseline.dispose();
      faster.dispose();
    }
  }
});

test("faster touch rotation preserves one-finger panning and pinch scale", () => {
  for (const plan of [false, true]) {
    const baseline = harness(plan, { fastTouch: false });
    const faster = harness(plan);
    try {
      for (const h of [baseline, faster]) {
        h.pointer("pointerdown", 1, 100, 100);
        h.pointer("pointermove", 1, 140, 125);
        h.pointer("pointerup", 1, 140, 125);
      }
      assert.ok(
        baseline.controls.target.distanceTo(faster.controls.target) < 1e-8,
      );
      assert.ok(
        baseline.camera.position.distanceTo(faster.camera.position) < 1e-8,
      );
      for (const h of [baseline, faster]) {
        h.pointer("pointerdown", 2, 100, 100);
        h.pointer("pointerdown", 3, 200, 100);
        h.pointer("pointermove", 2, 80, 100);
        h.pointer("pointermove", 3, 220, 100);
        h.pointer("pointerup", 2, 80, 100);
        h.pointer("pointerup", 3, 220, 100);
      }
      assert.ok(
        Math.abs(
          baseline.camera.position.distanceTo(baseline.controls.target) -
            faster.camera.position.distanceTo(faster.controls.target),
        ) < 1e-8,
      );
      assert.ok(Math.abs(baseline.camera.zoom - faster.camera.zoom) < 1e-8);
      if (plan) {
        assert.ok(
          baseline.camera.position.distanceTo(faster.camera.position) < 1e-8,
        );
        const direction = faster.camera.position
          .clone()
          .sub(faster.controls.target)
          .normalize();
        assert.ok(Math.hypot(direction.x, direction.z) < 1e-5);
        assert.equal(faster.controls.rotateSpeed, 1);
      }
    } finally {
      baseline.dispose();
      faster.dispose();
    }
  }
});

test("desktop drag retains its speed, including while two touch contacts exist", () => {
  for (const simultaneousTouches of [false, true]) {
    const baseline = harness(false, { fastTouch: false, rotateSpeed: 1.4 });
    const faster = harness(false, { rotateSpeed: 1.4 });
    try {
      for (const h of [baseline, faster]) {
        if (simultaneousTouches) {
          h.pointer("pointerdown", 1, 100, 100);
          h.pointer("pointerdown", 2, 200, 100);
        }
        const mouse = { pointerType: "mouse", button: 0 };
        h.pointer("pointerdown", 3, 120, 100, mouse);
        h.pointer("pointermove", 3, 170, 110, mouse);
        assert.equal(h.controls.rotateSpeed, 1.4);
        h.pointer("pointerup", 3, 170, 110, mouse);
      }
      assert.ok(
        Math.abs(
          baseline.controls.getAzimuthalAngle() -
            faster.controls.getAzimuthalAngle(),
        ) < 1e-8,
      );
      assert.ok(
        baseline.camera.position.distanceTo(faster.camera.position) < 1e-8,
      );
    } finally {
      baseline.dispose();
      faster.dispose();
    }
  }
});

test("touch speed resets on release, cancellation, capture loss, blur and 2D", () => {
  for (const finish of [
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "blur",
    "plan",
  ]) {
    const h = harness(false, { rotateSpeed: 1.6 });
    try {
      h.pointer("pointerdown", 1, 100, 100);
      h.pointer("pointerdown", 2, 200, 100);
      assert.equal(
        h.controls.rotateSpeed,
        1.6 * TWO_FINGER_ROTATION_MULTIPLIER,
      );
      if (finish === "blur") h.window.dispatchEvent(new Event("blur"));
      else if (finish === "plan") configureMapTouchControls(h.controls, true);
      else h.pointer(finish, 2, 200, 100);
      assert.equal(h.controls.rotateSpeed, 1.6, finish);
    } finally {
      h.dispose();
    }
  }
});

test("disposing touch rotation restores speed and removes its gesture listeners", () => {
  const baseline = harness(false, { fastTouch: false });
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 100);
    h.pointer("pointerdown", 2, 200, 100);
    assert.equal(h.controls.rotateSpeed, TWO_FINGER_ROTATION_MULTIPLIER);
    h.touchRotation.dispose();
    h.touchRotation.dispose();
    assert.equal(h.controls.rotateSpeed, 1);
    h.pointer("pointerup", 1, 100, 100);
    h.pointer("pointerup", 2, 200, 100);
    assert.ok(Math.abs(dragTwoFingers(h) - dragTwoFingers(baseline)) < 1e-8);
  } finally {
    h.dispose();
    baseline.dispose();
  }
});
