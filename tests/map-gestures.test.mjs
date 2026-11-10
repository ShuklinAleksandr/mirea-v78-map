import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AtlasScene } from "../src/map/scene.js";
import {
  configureMapTouchControls,
  bindMapTouchRotation,
} from "../src/map/gestures.js";
import { bindMapTapActions } from "../src/map/pointer-actions.js";

// Match the browser's capture-before-target order. stopPropagation at the map
// leaves other capture listeners (tap protection) active, but excludes the
// stock OrbitControls target listener from the custom touch stream.
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
      let stopped = false,
        immediate = false;
      const stop = event.stopPropagation.bind(event);
      const stopImmediate = event.stopImmediatePropagation.bind(event);
      event.stopPropagation = () => {
        stopped = true;
        stop();
      };
      event.stopImmediatePropagation = () => {
        immediate = stopped = true;
        stopImmediate();
      };
      const entries = [...(listeners.get(event.type) || [])];
      for (const capture of [true, false]) {
        for (const entry of entries) {
          if (immediate) break;
          if (
            entry.capture === capture &&
            listeners.get(event.type)?.includes(entry)
          )
            entry.callback.call(this, event);
        }
        if (stopped) break;
      }
      return !event.defaultPrevented;
    },
  };
}

function harness(
  plan = false,
  {
    binding = true,
    damping = false,
    width = 390,
    height = 844,
    left = 15,
    top = 42,
  } = {},
) {
  const frames = new Map(),
    captures = new Set();
  let nextFrame = 0,
    timestamp = 0,
    picks = 0;
  const document = Object.assign(new EventTarget(), {
    defaultView: new EventTarget(),
  });
  const element = Object.assign(pointerElement(), {
    style: {},
    clientWidth: width,
    clientHeight: height,
    ownerDocument: document,
    setPointerCapture: (id) => captures.add(id),
    releasePointerCapture: (id) => captures.delete(id),
    hasPointerCapture: (id) => captures.has(id),
    getRootNode: () => document,
    getBoundingClientRect: () => ({ left, top, width, height }),
    contains: (target) => target === label || target === element,
  });
  const label = {
    closest: () => label,
    isConnected: true,
    click: () => picks++,
  };
  const perspectiveCamera = new THREE.PerspectiveCamera(
    38,
    width / height,
    0.5,
    5000,
  );
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
  const controls = new OrbitControls(perspectiveCamera, element);
  controls.target.set(12, 7, -4);
  controls.screenSpacePanning = true;
  controls.enableDamping = damping;
  controls.enableTouchRotate = true;
  configureMapTouchControls(controls, false);
  const touch = binding
    ? bindMapTouchRotation(controls, {
        requestFrame(callback) {
          const id = ++nextFrame;
          frames.set(id, callback);
          return id;
        },
        cancelFrame(id) {
          frames.delete(id);
        },
      })
    : null;
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    perspectiveCamera,
    planCamera,
    camera: perspectiveCamera,
    controls,
    plan: false,
    invalidate() {},
    applyProjectionStyle() {},
  });
  if (plan) view.setProjection(true);
  controls.update();
  const taps = bindMapTapActions(element, (_event, target) =>
    target ? target.click() : picks++,
  );
  element.addEventListener("click", (event) => {
    if (event.target === label) label.click();
  });
  function pointer(type, id, x, y, extra = {}) {
    const { target = element, ...properties } = extra;
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: id,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      ...properties,
    });
    Object.defineProperty(event, "target", { value: target });
    element.dispatchEvent(event);
    return event;
  }
  return {
    controls,
    element,
    label,
    pointer,
    touch,
    view,
    captures,
    window: document.defaultView,
    get camera() {
      return controls.object;
    },
    get picks() {
      return picks;
    },
    get pendingFrames() {
      return frames.size;
    },
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      timestamp += 16;
      for (const callback of pending) callback(timestamp);
      controls.update();
    },
    dispose() {
      taps.dispose();
      touch?.dispose();
      controls.dispose();
    },
  };
}

const close = (a, b, message, epsilon = 1e-6) =>
  assert.ok(Math.abs(a - b) < epsilon, `${message}: ${a} vs ${b}`);

test("mouse pan and rotation retain their roles after switching 2D and 3D", () => {
  const h = harness();
  try {
    h.view.setProjection(true);
    h.view.setProjection(false);
    const target = h.controls.target.clone();
    const offset = h.camera.position.clone().sub(target);
    const mouse = { pointerType: "mouse" };
    h.pointer("pointerdown", 1, 120, 400, mouse);
    h.pointer("pointermove", 1, 170, 420, mouse);
    h.pointer("pointerup", 1, 170, 420, mouse);
    assert.ok(h.controls.target.distanceTo(target) > 1);
    assert.ok(
      h.camera.position.clone().sub(h.controls.target).distanceTo(offset) <
        1e-6,
    );
    const panned = h.controls.target.clone();
    const right = { pointerType: "mouse", button: 2, buttons: 2 };
    h.pointer("pointerdown", 2, 120, 400, right);
    h.pointer("pointermove", 2, 170, 420, right);
    h.pointer("pointerup", 2, 170, 420, { ...right, buttons: 0 });
    assert.ok(h.controls.target.distanceTo(panned) < 1e-6);
    assert.ok(h.camera.position.clone().sub(panned).distanceTo(offset) > 1);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});
const offset = (h) => h.camera.position.clone().sub(h.controls.target);
const pair = (x, y, radius = 50, angle = 0) => {
  const a = (angle * Math.PI) / 180;
  return [
    [x - radius * Math.cos(a), y - radius * Math.sin(a)],
    [x + radius * Math.cos(a), y + radius * Math.sin(a)],
  ];
};
function startPair(h, points, target) {
  h.pointer("pointerdown", 1, ...points[0], target ? { target } : {});
  h.pointer("pointerdown", 2, ...points[1]);
}
function movePair(h, points, { frame = true, order = [1, 2] } = {}) {
  for (const id of order) h.pointer("pointermove", id, ...points[id - 1]);
  if (frame) h.frame();
}
function endPair(h, points, order = [2, 1]) {
  for (const id of order) h.pointer("pointerup", id, ...points[id - 1]);
}
function worldAt(h, x, y) {
  const rect = h.element.getBoundingClientRect();
  h.camera.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(
    new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      1 - ((y - rect.top) / rect.height) * 2,
    ),
    h.camera,
  );
  const point = ray.ray.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -h.controls.target.y),
    new THREE.Vector3(),
  );
  assert.ok(point, "test point must intersect the gesture plane");
  return point;
}
function assertAnchor(h, world, x, y) {
  h.camera.updateMatrixWorld();
  const rect = h.element.getBoundingClientRect(),
    p = world.clone().project(h.camera);
  close(rect.left + ((p.x + 1) * rect.width) / 2, x, "anchor screen x", 1e-4);
  close(rect.top + ((1 - p.y) * rect.height) / 2, y, "anchor screen y", 1e-4);
}
function snapshot(h) {
  return {
    position: h.camera.position.toArray(),
    target: h.controls.target.toArray(),
    up: h.camera.up.toArray(),
    zoom: h.camera.zoom,
  };
}
function assertStill(h, before) {
  const after = snapshot(h);
  for (const key of ["position", "target", "up"])
    after[key].forEach((value, i) => close(value, before[key][i], key));
  close(after.zoom, before.zoom, "zoom");
}

for (const plan of [false, true]) {
  const mode = plan ? "2D" : "3D";
  test(`${mode}: one finger pans on the map plane and retains orientation and scale`, () => {
    const h = harness(plan);
    try {
      const anchor = worldAt(h, 160, 450),
        initialOffset = offset(h),
        zoom = h.camera.zoom;
      h.pointer("pointerdown", 1, 160, 450);
      h.pointer("pointermove", 1, 205, 485);
      h.frame();
      assertAnchor(h, anchor, 205, 485);
      assert.ok(offset(h).distanceTo(initialOffset) < 1e-6);
      close(h.camera.zoom, zoom, "one finger scale");
      h.pointer("pointerup", 1, 205, 485);
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  });

  test(`${mode}: sequential two-finger translation is coalesced into a pan without zoom or twist`, () => {
    const h = harness(plan);
    try {
      const initial = snapshot(h),
        anchor = worldAt(h, 170, 450),
        initialOffset = offset(h);
      startPair(h, pair(170, 450));
      h.pointer("pointermove", 1, 145, 470);
      assertStill(h, initial);
      h.pointer("pointermove", 2, 245, 470);
      assert.equal(h.pendingFrames, 1);
      h.frame();
      assertAnchor(h, anchor, 195, 470);
      assert.ok(offset(h).distanceTo(initialOffset) < 1e-6);
      close(h.camera.zoom, initial.zoom, "parallel pan scale");
      endPair(h, pair(195, 470));
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    test(`${mode} ${viewport.width}×${viewport.height}: combined pinch, twist and pan preserve the ground pivot without locking gesture intent`, () => {
      const h = harness(plan, { ...viewport, damping: true });
      try {
        const x = viewport.width * 0.48,
          y = viewport.height * 0.62;
        const anchor = worldAt(h, x, y),
          initialOffset = offset(h),
          initialUp = h.camera.up.clone();
        startPair(h, pair(x, y, 50, 10));
        let last;
        for (const [dx, dy, radius, angle] of [
          [20, 10, 70, 35],
          [-15, 5, 60, -10],
          [10, -8, 80, 20],
        ]) {
          last = pair(x + dx, y + dy, radius, angle);
          movePair(h, last, { order: angle < 0 ? [2, 1] : [1, 2] });
          assertAnchor(h, anchor, x + dx, y + dy);
          const turn = ((angle - 10) * Math.PI) / 180;
          if (plan) {
            close(h.camera.zoom, radius / 50, "combined scale");
            assert.ok(
              h.camera.up.distanceTo(
                initialUp
                  .clone()
                  .applyAxisAngle(new THREE.Vector3(0, 1, 0), turn),
              ) < 1e-5,
            );
            assert.ok(
              Math.hypot(offset(h).x, offset(h).z) / offset(h).length() < 1e-5,
              "plan remains vertical",
            );
          } else {
            close(
              offset(h).length(),
              (initialOffset.length() * 50) / radius,
              "combined perspective distance",
            );
            assert.ok(
              offset(h)
                .clone()
                .normalize()
                .distanceTo(
                  initialOffset
                    .clone()
                    .normalize()
                    .applyAxisAngle(new THREE.Vector3(0, 1, 0), turn),
                ) < 1e-5,
            );
          }
        }
        endPair(h, last);
        const final = snapshot(h);
        for (let i = 0; i < 60; i++) h.controls.update();
        assertStill(h, final);
        assert.equal(h.picks, 0);
      } finally {
        h.dispose();
      }
    });
  }

  test(`${mode}: a pure twist crosses either ±180° boundary by two degrees, not a full turn`, () => {
    for (const [from, to] of [
      [179, 181],
      [-179, -181],
    ]) {
      const h = harness(plan);
      try {
        const anchor = worldAt(h, 180, 450),
          initialOffset = offset(h),
          up = h.camera.up.clone(),
          zoom = h.camera.zoom;
        startPair(h, pair(180, 450, 70, from));
        movePair(h, pair(180, 450, 70, to));
        const expected = (
          plan ? up : initialOffset.clone().normalize()
        ).applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          ((to - from) * Math.PI) / 180,
        );
        assert.ok(
          (plan ? h.camera.up : offset(h).normalize()).distanceTo(expected) <
            1e-5,
        );
        assertAnchor(h, anchor, 180, 450);
        close(h.camera.zoom, zoom, "twist zoom");
        close(offset(h).length(), initialOffset.length(), "twist distance");
      } finally {
        h.dispose();
      }
    }
  });

  test(`${mode}: a stationary first finger and final pointerup retain both pinch and midpoint movement`, () => {
    const h = harness(plan);
    try {
      const anchor = worldAt(h, 150, 450),
        distance = offset(h).length();
      startPair(h, [
        [100, 450],
        [200, 450],
      ]);
      h.pointer("pointermove", 2, 240, 450);
      h.pointer("pointerup", 2, 240, 450); // flush the queued final sample, without an animation frame
      assertAnchor(h, anchor, 170, 450);
      if (plan) close(h.camera.zoom, 1.4, "one fixed finger zoom");
      else
        close(offset(h).length(), distance / 1.4, "one fixed finger distance");
      h.pointer("pointerup", 1, 100, 450);
      assert.equal(h.pendingFrames, 0);
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  });

  test(`${mode}: zoom limits and disabled zoom do not disable independent translation`, () => {
    for (const enabled of [true, false]) {
      const h = harness(plan);
      try {
        const anchor = worldAt(h, 170, 450),
          distance = offset(h).length();
        h.controls.enableZoom = enabled;
        h.controls.minDistance = distance * 0.9;
        h.controls.maxZoom = 1.1;
        startPair(h, pair(170, 450));
        movePair(h, pair(195, 470, 100));
        assertAnchor(h, anchor, 195, 470);
        if (plan) close(h.camera.zoom, enabled ? 1.1 : 1, "bounded plan zoom");
        else
          close(
            offset(h).length(),
            distance * (enabled ? 0.9 : 1),
            "bounded perspective distance",
          );
      } finally {
        h.dispose();
      }
    }
  });

  test(`${mode}: disabling touch rotation preserves pinch and pan; disabling pan leaves the target fixed`, () => {
    const h = harness(plan);
    try {
      h.controls.enableTouchRotate = false;
      const direction = offset(h).normalize(),
        up = h.camera.up.clone(),
        anchor = worldAt(h, 170, 450);
      startPair(h, pair(170, 450));
      movePair(h, pair(185, 460, 70, 30));
      assertAnchor(h, anchor, 185, 460);
      assert.ok(offset(h).normalize().distanceTo(direction) < 1e-5);
      assert.ok(h.camera.up.distanceTo(up) < 1e-5);
      endPair(h, pair(185, 460, 70, 30));
      h.controls.enablePan = false;
      h.controls.enableZoom = false;
      const before = snapshot(h);
      startPair(h, pair(170, 450));
      movePair(h, pair(200, 470));
      assertStill(h, before);
    } finally {
      h.dispose();
    }
  });
}

test("1→2→1 contacts rebase continuously, and a later independent tap still selects", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 100, 450);
    h.pointer("pointermove", 1, 120, 460);
    h.frame();
    const beforePair = snapshot(h);
    h.pointer("pointerdown", 2, 220, 460);
    h.frame();
    assertStill(h, beforePair);
    movePair(h, [
      [110, 450],
      [250, 470],
    ]);
    h.pointer("pointerup", 2, 250, 470);
    const beforeSingle = snapshot(h),
      anchor = worldAt(h, 110, 450);
    h.frame();
    assertStill(h, beforeSingle);
    h.pointer("pointermove", 1, 130, 465);
    h.frame();
    assertAnchor(h, anchor, 130, 465);
    h.pointer("pointerup", 1, 130, 465);
    assert.equal(h.picks, 0);
    h.pointer("pointerdown", 3, 130, 465);
    h.pointer("pointerup", 3, 130, 465);
    assert.equal(h.picks, 1);
  } finally {
    h.dispose();
  }
});

test("a third touch interrupts transformation without allowing a room tap or stale-pair jump", () => {
  const h = harness();
  try {
    startPair(h, pair(160, 450));
    movePair(h, pair(170, 460, 65, 15));
    h.pointer("pointerdown", 3, 310, 500);
    const frozen = snapshot(h);
    movePair(h, pair(190, 480, 85, 30));
    assertStill(h, frozen);
    h.pointer("pointerup", 3, 310, 500);
    h.frame();
    assertStill(h, frozen);
    // Whatever two-contact recovery policy is selected, releasing all contacts
    // must leave a clean baseline for the next deliberate pair.
    endPair(h, pair(190, 480, 85, 30));
    const anchor = worldAt(h, 160, 450);
    startPair(h, pair(160, 450));
    movePair(h, pair(180, 460, 60, 5));
    assertAnchor(h, anchor, 180, 460);
    assert.equal(h.picks, 0);
  } finally {
    h.dispose();
  }
});

test("tiny/coincident spans never create non-finite zoom or bearing, and recover after separation", () => {
  for (const plan of [false, true]) {
    const h = harness(plan);
    try {
      startPair(h, pair(170, 450, 0));
      movePair(h, pair(180, 455, 2, 100));
      movePair(h, pair(190, 460, 30, 100));
      movePair(h, pair(195, 460, 40, 110));
      for (const value of [
        ...h.camera.position.toArray(),
        ...h.controls.target.toArray(),
        ...h.camera.up.toArray(),
        h.camera.zoom,
      ])
        assert.ok(Number.isFinite(value));
      assert.ok(h.camera.zoom > 0 && offset(h).length() > 0);
    } finally {
      h.dispose();
    }
  }
});

test("cancel, lost capture, blur and disposal discard queued motion and release custom touch state", () => {
  for (const ending of [
    "pointercancel",
    "lostpointercapture",
    "blur",
    "dispose",
  ]) {
    const h = harness(false, { damping: true });
    try {
      const initial = snapshot(h);
      startPair(h, pair(170, 450));
      movePair(h, pair(190, 460, 80, 30), { frame: false });
      assert.equal(h.pendingFrames, 1);
      if (ending === "blur") h.window.dispatchEvent(new Event("blur"));
      else if (ending === "dispose") h.touch.dispose();
      else h.pointer(ending, 2, 250, 450);
      h.frame();
      assert.equal(h.pendingFrames, 0);
      assertStill(h, initial);
      assert.equal(h.controls.enabled, true);
      assert.equal(h.controls.rotateSpeed, 1);
      assert.equal(h.controls.zoomSpeed, 1);
      assert.equal(h.controls.panSpeed, 1);
      assert.equal(h.picks, 0);
    } finally {
      h.dispose();
    }
  }
});

test("changing projection during a contact pair discards queued old-camera motion", () => {
  const h = harness();
  try {
    startPair(h, pair(170, 450));
    movePair(h, pair(200, 470, 90, 30), { frame: false });
    h.view.setProjection(true);
    const projected = snapshot(h);
    h.frame();
    assertStill(h, projected);
    endPair(h, pair(200, 470, 90, 30));
    const anchor = worldAt(h, 170, 450);
    startPair(h, pair(170, 450));
    movePair(h, pair(190, 460, 70, 20));
    assertAnchor(h, anchor, 190, 460);
    assert.ok(Math.hypot(offset(h).x, offset(h).z) / offset(h).length() < 1e-5);
  } finally {
    h.dispose();
  }
});

test("disabled controls and location-picking rotation gates cannot be bypassed by touch", () => {
  const h = harness();
  try {
    h.controls.enabled = false;
    const before = snapshot(h);
    startPair(h, pair(170, 450));
    movePair(h, pair(200, 470, 90, 45));
    endPair(h, pair(200, 470, 90, 45));
    assertStill(h, before);
    h.controls.enabled = true;
    h.controls.enableTouchRotate = false;
    const direction = offset(h).normalize();
    startPair(h, pair(170, 450));
    movePair(h, pair(170, 450, 50, 45));
    assert.ok(offset(h).normalize().distanceTo(direction) < 1e-5);
  } finally {
    h.dispose();
  }
});

test("desktop left/right drags retain stock behavior in both projections", () => {
  for (const [plan, button] of [
    [false, 0],
    [false, 2],
    [true, 0],
  ]) {
    const baseline = harness(plan, { binding: false }),
      h = harness(plan);
    try {
      for (const view of [baseline, h]) {
        const mouse = { pointerType: "mouse", button };
        view.pointer("pointerdown", 5, 120, 400, mouse);
        view.pointer("pointermove", 5, 160, 430, mouse);
        view.pointer("pointerup", 5, 160, 430, mouse);
      }
      assertStill(h, snapshot(baseline));
      assert.equal(h.picks, 0);
    } finally {
      baseline.dispose();
      h.dispose();
    }
  }
});

test("disposal is idempotent and restores ordinary OrbitControls two-touch handling", () => {
  const baseline = harness(false, { binding: false }),
    h = harness();
  try {
    h.touch.dispose();
    h.touch.dispose();
    for (const view of [baseline, h]) {
      startPair(view, pair(170, 450));
      movePair(view, pair(195, 470, 70));
      endPair(view, pair(195, 470, 70));
    }
    assertStill(h, snapshot(baseline));
  } finally {
    baseline.dispose();
    h.dispose();
  }
});

test("combined label/canvas touch stream never selects; later tap and keyboard activation each select once", () => {
  for (const release of [
    [1, 2],
    [2, 1],
  ]) {
    const h = harness();
    try {
      startPair(h, pair(170, 450), h.label);
      movePair(h, pair(195, 470, 75, 25));
      endPair(h, pair(195, 470, 75, 25), release);
      h.pointer("click", 1, 100, 400, { target: h.label, detail: 1 });
      assert.equal(h.picks, 0);
      h.pointer("pointerdown", 3, 100, 450, { target: h.label });
      h.pointer("pointerup", 3, 100, 450);
      assert.equal(h.picks, 1);
      h.pointer("click", 3, 100, 450, { target: h.label, detail: 1 });
      assert.equal(h.picks, 1);
      h.pointer("click", 3, 100, 450, { target: h.label, detail: 0 });
      assert.equal(h.picks, 2, "keyboard activation remains a native click");
    } finally {
      h.dispose();
    }
  }
});

test("single taps work, but a returning drag, canceled touch or secondary mouse click never selects", () => {
  const h = harness();
  try {
    h.pointer("pointerdown", 1, 170, 450);
    h.pointer("pointerup", 1, 172, 451);
    assert.equal(h.picks, 1);
    h.pointer("pointerdown", 2, 170, 450);
    h.pointer("pointermove", 2, 210, 450);
    h.frame();
    h.pointer("pointermove", 2, 170, 450);
    h.frame();
    h.pointer("pointerup", 2, 170, 450);
    h.pointer("pointerdown", 3, 170, 450);
    h.pointer("pointercancel", 3, 170, 450);
    h.pointer("pointerup", 3, 170, 450);
    const mouse = { pointerType: "mouse", button: 2 };
    h.pointer("pointerdown", 4, 170, 450, mouse);
    h.pointer("pointerup", 4, 170, 450, mouse);
    assert.equal(h.picks, 1);
  } finally {
    h.dispose();
  }
});

test("a stationary two-finger touch never selects in either release order", () => {
  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    const h = harness();
    try {
      const before = snapshot(h);
      startPair(h, pair(170, 450), h.label);
      endPair(h, pair(170, 450), order);
      assertStill(h, before);
      assert.equal(h.picks, 0);
      h.pointer("pointerdown", 3, 120, 450, { target: h.label });
      h.pointer("pointerup", 3, 120, 450);
      assert.equal(h.picks, 1);
    } finally {
      h.dispose();
    }
  }
});

test("label microjitter does not move the map, but accumulated slow movement still becomes a drag", () => {
  const h = harness();
  try {
    const before = snapshot(h);
    h.pointer("pointerdown", 1, 170, 450, { target: h.label });
    h.pointer("pointermove", 1, 172, 451);
    h.frame();
    h.pointer("pointerup", 1, 172, 451);
    assertStill(h, before);
    assert.equal(h.picks, 1);
    const anchor = worldAt(h, 170, 450);
    h.pointer("pointerdown", 2, 170, 450, { target: h.label });
    for (let dx = 1; dx <= 6; dx++) {
      h.pointer("pointermove", 2, 170 + dx, 450);
      h.frame();
    }
    assertAnchor(h, anchor, 176, 450);
    h.pointer("pointerup", 2, 176, 450);
    assert.equal(h.picks, 1);
  } finally {
    h.dispose();
  }
});

test("touch drains old mouse damping without changing the current view or letting inertia fight the fingers", () => {
  const h = harness(false, { damping: true });
  try {
    const mouse = { pointerType: "mouse" };
    h.pointer("pointerdown", 4, 120, 400, mouse);
    h.pointer("pointermove", 4, 165, 430, mouse);
    h.pointer("pointerup", 4, 165, 430, mouse);
    const beforeTouch = snapshot(h);
    h.pointer("pointerdown", 1, 170, 450);
    assertStill(h, beforeTouch);
    for (let i = 0; i < 60; i++) h.controls.update();
    assertStill(h, beforeTouch);
    const anchor = worldAt(h, 170, 450);
    h.pointer("pointermove", 1, 195, 460);
    h.frame();
    assertAnchor(h, anchor, 195, 460);
  } finally {
    h.dispose();
  }
});

test("the first touch stream owns the gesture and later mouse input cannot alter or pollute it", () => {
  const baseline = harness(),
    h = harness();
  const mouse = { pointerType: "mouse" };
  try {
    for (const view of [baseline, h]) {
      startPair(view, pair(170, 450));
      movePair(view, pair(190, 460, 80, 25), { frame: false });
    }
    h.pointer("pointerdown", 5, 120, 400, mouse);
    h.pointer("pointermove", 5, 160, 430, mouse);
    for (const view of [baseline, h]) view.frame();
    assertStill(h, snapshot(baseline));
    for (const view of [baseline, h]) endPair(view, pair(190, 460, 80, 25));
    const afterTouch = snapshot(h);
    h.pointer("pointermove", 5, 180, 440, mouse);
    h.pointer("pointerup", 5, 180, 440, mouse);
    h.frame();
    assertStill(h, afterTouch);
    for (const view of [baseline, h]) {
      view.pointer("pointerdown", 6, 120, 400, mouse);
      view.pointer("pointermove", 6, 160, 430, mouse);
      view.pointer("pointerup", 6, 160, 430, mouse);
      view.frame();
    }
    assertStill(h, snapshot(baseline));
    assert.equal(h.pendingFrames, 0);
    assert.equal(h.picks, 0);
  } finally {
    baseline.dispose();
    h.dispose();
  }
});

test("the first mouse stream retains stock behavior while later touches remain ignored until release", () => {
  const baseline = harness(false, { binding: false }),
    h = harness();
  const mouse = { pointerType: "mouse" };
  try {
    for (const view of [baseline, h])
      view.pointer("pointerdown", 5, 120, 400, mouse);
    startPair(h, pair(170, 450));
    movePair(h, pair(190, 460, 80, 25));
    for (const view of [baseline, h]) {
      view.pointer("pointermove", 5, 160, 430, mouse);
      view.pointer("pointerup", 5, 160, 430, mouse);
      view.frame();
    }
    assertStill(h, snapshot(baseline));
    const afterMouse = snapshot(h);
    movePair(h, pair(210, 470, 90, 45));
    endPair(h, pair(210, 470, 90, 45));
    assertStill(h, afterMouse);
    assert.equal(h.picks, 0);
    const anchor = worldAt(h, 170, 450);
    h.pointer("pointerdown", 7, 170, 450);
    h.pointer("pointermove", 7, 195, 460);
    h.frame();
    assertAnchor(h, anchor, 195, 460);
  } finally {
    baseline.dispose();
    h.dispose();
  }
});

test("viewport changes invalidate an old screen-space baseline instead of jumping to stale finger coordinates", () => {
  const h = harness();
  try {
    startPair(h, pair(170, 450));
    movePair(h, pair(195, 470, 70, 25), { frame: false });
    const before = snapshot(h);
    h.element.getBoundingClientRect = () => ({
      left: 15,
      top: 42,
      width: 844,
      height: 390,
    });
    h.frame();
    assertStill(h, before);
    const anchor = worldAt(h, 195, 470);
    movePair(h, pair(205, 475, 80, 30));
    assertAnchor(h, anchor, 205, 475);
  } finally {
    h.dispose();
  }
});
