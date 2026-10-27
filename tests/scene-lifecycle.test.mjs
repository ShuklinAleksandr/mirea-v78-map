import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";

// Run the scene's real frame method and lifecycle wiring with a deterministic
// browser scheduler. GPU rendering is the boundary; camera interpolation is real.
function sceneHarness({ hidden = false, nativeActive = true } = {}) {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.hidden = hidden;
  documentTarget.documentElement = {
    dataset: { appActive: String(nativeActive) },
  };
  let nextFrame = 0;
  const pending = new Map();
  const counts = { controls: 0, renders: 0, resizes: 0, labels: 0, routes: 0 };
  windowTarget.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    pending.set(id, callback);
    return id;
  };
  windowTarget.cancelAnimationFrame = (id) => pending.delete(id);
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    host: { dataset: {} },
    scene: {},
    camera: new THREE.PerspectiveCamera(),
    controls: {
      target: new THREE.Vector3(),
      update: () => counts.controls++,
    },
    renderer: {
      shadowMap: { needsUpdate: false },
      render: () => counts.renders++,
      info: { render: { calls: 1, triangles: 2 }, memory: { geometries: 3 } },
    },
    callbacks: {},
    mode: "overview",
    roomLabels: [],
    resize: () => counts.resizes++,
    updateLabels: () => counts.labels++,
    updateRoute: () => counts.routes++,
  });
  const options = { windowTarget, documentTarget };
  view.startRendering(options);
  return {
    view,
    counts,
    pending,
    options,
    frame() {
      assert.equal(pending.size, 1, "only one frame may be pending");
      const [id, callback] = pending.entries().next().value;
      pending.delete(id);
      callback(performance.now());
    },
    app(isActive) {
      windowTarget.dispatchEvent(
        new CustomEvent("atlas:app-state", { detail: { isActive } }),
      );
    },
    visibility(isHidden) {
      documentTarget.hidden = isHidden;
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    },
    page(name) {
      windowTarget.dispatchEvent(new Event(name));
    },
    dispose: () => view.renderLifecycle.dispose(),
  };
}

test("native background stops scene updates; foreground resizes and repaints once", (t) => {
  const h = sceneHarness();
  t.after(h.dispose);
  h.frame();
  assert.deepEqual(h.counts, {
    controls: 1,
    renders: 1,
    resizes: 1,
    labels: 1,
    routes: 1,
  });
  h.view.mouseEvent = { clientX: 20 };
  h.app(false);
  h.app(false);
  assert.equal(h.pending.size, 0);
  assert.equal(h.view.mouseEvent, null);
  assert.equal(h.counts.controls, 1);
  assert.equal(h.counts.renders, 1);

  h.view.renderer.shadowMap.needsUpdate = false;
  h.app(true);
  h.app(true);
  h.page("pageshow");
  h.visibility(false);
  assert.equal(h.pending.size, 1);
  assert.equal(h.counts.resizes, 2);
  assert.equal(h.view.renderer.shadowMap.needsUpdate, true);
  h.frame();
  assert.equal(h.counts.renders, 2, "resume repaints even a clean scene");
  h.frame();
  assert.equal(h.counts.controls, 3);
  assert.equal(
    h.counts.renders,
    2,
    "idle frames keep the existing dirty check",
  );
});

test("visibility and page lifecycle cannot override a still-inactive native app", (t) => {
  const h = sceneHarness();
  t.after(h.dispose);
  h.frame();
  h.visibility(true);
  assert.equal(h.pending.size, 0);
  h.app(false);
  h.visibility(false);
  h.page("pageshow");
  assert.equal(h.pending.size, 0);
  h.app(true);
  assert.equal(h.pending.size, 1);

  h.page("pagehide");
  assert.equal(h.pending.size, 0);
  h.visibility(false);
  h.app(true);
  assert.equal(h.pending.size, 0, "pagehide requires a matching pageshow");
  h.page("pageshow");
  h.frame();
  assert.equal(h.counts.renders, 2);

  h.visibility(true);
  h.app(false);
  h.app(true);
  assert.equal(h.pending.size, 0, "foreground cannot render a hidden document");
  h.visibility(false);
  h.frame();
  assert.equal(h.counts.renders, 3);
});

test("a scene created in background waits for all visibility conditions", (t) => {
  const h = sceneHarness({ hidden: true, nativeActive: false });
  t.after(h.dispose);
  assert.equal(h.pending.size, 0);
  assert.equal(h.counts.resizes, 0);
  h.visibility(false);
  assert.equal(h.pending.size, 0);
  h.app(true);
  h.frame();
  assert.equal(h.counts.resizes, 1);
  assert.equal(h.counts.renders, 1);
});

test("cancelled callbacks arriving after resume cannot duplicate the frame loop", (t) => {
  const h = sceneHarness();
  t.after(h.dispose);
  const stale = [...h.pending.values()][0];
  h.app(false);
  h.app(true);
  stale(performance.now());
  assert.equal(h.counts.controls, 0);
  assert.equal(h.pending.size, 1);
  h.frame();
  assert.equal(h.counts.controls, 1);
  assert.equal(h.pending.size, 1);

  h.view.startRendering(h.options);
  assert.equal(h.pending.size, 1, "replacing lifecycle cancels the old loop");
  h.frame();
  assert.equal(h.counts.controls, 2);
  h.dispose();
  h.dispose();
  h.app(false);
  h.app(true);
  h.visibility(false);
  h.page("pageshow");
  assert.equal(
    h.pending.size,
    0,
    "disposed listeners must not restart rendering",
  );
});

test("camera transitions keep their progress instead of jumping over background time", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const h = sceneHarness();
  t.after(h.dispose);
  h.view.transition = {
    start: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(10, 20, 30),
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(1, 2, 3),
  };
  h.frame();
  const before = h.view.camera.position.clone();
  h.app(false);
  now = 5100;
  h.app(true);
  h.frame();
  assert.ok(h.view.camera.position.distanceTo(before) < 1e-10);
  assert.ok(h.view.transition, "animation must retain its remaining time");
  now += 550;
  h.frame();
  assert.equal(h.view.transition, null);
  assert.deepEqual(h.view.camera.position.toArray(), [10, 20, 30]);
});

test("a camera transition created while hidden starts on the first visible frame", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const h = sceneHarness({ hidden: true });
  t.after(h.dispose);
  now = 200;
  h.view.transition = {
    start: now,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(10, 20, 30),
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(1, 2, 3),
  };
  now = 5100;
  h.visibility(false);
  h.frame();
  assert.deepEqual(h.view.camera.position.toArray(), [0, 0, 0]);
  assert.equal(h.view.transition.start, 5100);
});
