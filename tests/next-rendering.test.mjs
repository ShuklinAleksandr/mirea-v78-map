import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createAdaptiveQuality } from "../src/map/adaptive-quality.js";
import { mapQuality } from "../src/map/quality.js";
import { navigationLookAhead } from "../src/map/navigation-view.js";
import { AtlasScene } from "../src/map/scene.js";

function feed(
  controller,
  {
    start = 0,
    duration = 3000,
    rate = 60,
    cost = 2,
    target = rate,
    active = true,
  } = {},
) {
  const changes = [];
  for (let time = start; time < start + duration; time += 1000 / rate) {
    const level = controller.observe({ time, cost, active, frameRate: target });
    if (level != null) changes.push(level);
  }
  return changes;
}

test("Next adaptation does not confuse 30 fps, idle wakeups or a single stall with a slow device", () => {
  const quality = createAdaptiveQuality();
  assert.deepEqual(feed(quality, { rate: 30, duration: 10000 }), []);
  assert.deepEqual(
    feed(quality, {
      start: 20000,
      rate: 1,
      cost: 100,
      duration: 10000,
      target: 60,
    }),
    [],
  );
  quality.observe({ time: 31000, cost: 130, active: true, frameRate: 60 });
  assert.deepEqual(feed(quality, { start: 31100, duration: 3000 }), []);
  assert.deepEqual(
    feed(quality, { start: 40000, cost: 100, active: false }),
    [],
  );
  assert.equal(quality.level, 0);
});

test("sustained busy rendering reduces quality in bounded steps and recovery needs headroom", () => {
  const quality = createAdaptiveQuality();
  const changes = feed(quality, {
    duration: 11000,
    rate: 20,
    target: 60,
    cost: 30,
  });
  assert.deepEqual(changes, [1, 2]);
  // An intentional lower cap with little remaining headroom must not bounce to 60.
  assert.deepEqual(
    feed(quality, { start: 12000, duration: 10000, rate: 30, cost: 12 }),
    [],
  );
  assert.equal(quality.level, 2);
  assert.deepEqual(
    feed(quality, { start: 23000, duration: 9000, rate: 30, cost: 2 }),
    [1],
  );
  assert.deepEqual(
    feed(quality, { start: 33000, duration: 9000, rate: 60, cost: 2 }),
    [0],
  );
  quality.reset();
  assert.equal(quality.level, 0);
});

test("adaptive profiles change only automatic quality and keep 2D unlit", () => {
  const device = { pixelRatio: 2, cores: 8, memory: 8 };
  const base = mapQuality("auto", device);
  const first = mapQuality("auto", { ...device, adaptiveLevel: 1 });
  const second = mapQuality("auto", { ...device, adaptiveLevel: 2 });
  assert.equal(base.pixelRatio, 1.5);
  assert.equal(first.pixelRatio, 1);
  assert.equal(first.shadows, false);
  assert.equal(second.pixelRatio, 0.75);
  assert.equal(second.detail, false);
  assert.equal(second.autoFrameRate, 30);
  for (const setting of ["low", "balanced", "high"])
    assert.deepEqual(
      mapQuality(setting, device),
      mapQuality(setting, { ...device, adaptiveLevel: 2 }),
    );
  assert.equal(
    mapQuality("auto", { ...device, plan: true, adaptiveLevel: 1 }).shadows,
    false,
  );
});

test("scene adaptation respects an explicit frame cap and never schedules idle measurement frames", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const automatic of [false, true]) {
    let requests = 0;
    const view = Object.assign(Object.create(AtlasScene.prototype), {
      interfaceVariant: "next",
      adaptiveQuality: createAdaptiveQuality(),
      quality: "auto",
      qualityProfile: mapQuality("auto", { pixelRatio: 2 }),
      frameRateLimit: 60,
      host: { dataset: {} },
      mode: "floor",
      scene: {},
      camera: new THREE.PerspectiveCamera(),
      callbacks: {},
      roomLabels: [],
      controls: { target: new THREE.Vector3(), update: () => true },
      renderer: {
        shadowMap: {},
        render: () => {
          now += 30;
        },
        info: { render: {}, memory: {} },
      },
      renderLifecycle: { requestFrame: () => requests++, setFrameRate() {} },
      updateLabels() {},
      updateRoute() {},
      updateUserLocationScale() {},
      applyProjectionStyle() {
        this.qualityProfile = mapQuality("auto", {
          pixelRatio: 2,
          adaptiveLevel: this.adaptiveQuality.level,
        });
      },
    });
    view.setFrameRate(60, { automatic });
    for (let time = 0; time < 11000; time += 50) {
      now = time;
      view.dirty = true;
      view.animate(time);
    }
    assert.equal(view.adaptiveQuality.level, 2);
    assert.equal(view.frameRateLimit, automatic ? 30 : 60);
    assert.ok(requests <= 3, "only profile changes need an extra repaint");
    view.controls.update = () => false;
    view.dirty = true;
    now = 30000;
    assert.equal(
      view.animate(now),
      false,
      "measurement does not keep an idle scene awake",
    );
    const observed = view.adaptiveQuality.level;
    view.quality = "high";
    view.adaptiveQuality.reset();
    view.controls.update = () => true;
    for (let time = 40000; time < 45000; time += 50) {
      now = time;
      view.dirty = true;
      view.animate(time);
    }
    assert.equal(observed, 2);
    assert.equal(
      view.adaptiveQuality.level,
      0,
      "explicit quality bypasses adaptation",
    );
  }
});

function wallScene(variant) {
  return Object.assign(Object.create(AtlasScene.prototype), {
    interfaceVariant: variant,
    navigationMode: false,
    mode: "floor",
    plan: false,
    wallHeight: 2.7,
    route: { ok: true },
    model: new THREE.Group(),
    invalidate() {},
  });
}

test("only Next guidance fades current-floor walls and restores exact material/instance state", () => {
  for (const variant of ["classic", "next"]) {
    const view = wallScene(variant);
    view.addWalls([{ a: [0, 0], b: [8, 0], width: 0.2 }]);
    const [mesh, caps] = view.navigationWalls;
    const matrix = Array.from(mesh.instanceMatrix.array);
    const geometry = mesh.geometry;
    const original = {
      opacity: mesh.material.opacity,
      depthWrite: mesh.material.depthWrite,
      transparent: mesh.material.transparent,
    };
    view.setNavigationMode(true);
    assert.equal(mesh.material.opacity, variant === "next" ? 0.24 : 1);
    assert.equal(caps.material.opacity, variant === "next" ? 0.35 : 0.75);
    assert.equal(mesh.geometry, geometry);
    assert.deepEqual(Array.from(mesh.instanceMatrix.array), matrix);
    view.setNavigationMode(false);
    assert.deepEqual(
      {
        opacity: mesh.material.opacity,
        depthWrite: mesh.material.depthWrite,
        transparent: mesh.material.transparent,
      },
      original,
    );
    assert.equal(caps.material.opacity, 0.75);
    view.setNavigationMode(true);
    view.plan = true;
    view.applyNavigationStyle();
    assert.equal(
      mesh.material.opacity,
      1,
      "2D never inherits transparent wall styling",
    );
    mesh.geometry.dispose();
    mesh.material.dispose();
    caps.geometry.dispose();
    caps.material.dispose();
  }
});

test("a new floor created during Next guidance receives the same rendering-only wall treatment", () => {
  const view = wallScene("next");
  view.setNavigationMode(true);
  view.addWalls([{ a: [2, 3], b: [6, 3] }]);
  assert.equal(view.navigationWalls[0].material.opacity, 0.24);
  view.stackDisplay = true;
  view.applyNavigationStyle();
  assert.equal(
    view.navigationWalls[0].material.opacity,
    1,
    "all-floor preview has its own material treatment",
  );
});

test("camera lead requires fresh compass evidence and does not change the location point", () => {
  const input = {
    enabled: true,
    bearing: Math.PI / 2,
    headingTimestamp: 1000,
    now: 2000,
    maxAge: 3000,
  };
  const lead = navigationLookAhead(input);
  assert.ok(Math.abs(lead[0] + 4) < 1e-8);
  assert.ok(Math.abs(lead[1]) < 1e-8);
  assert.deepEqual(navigationLookAhead({ ...input, enabled: false }), [0, 0]);
  assert.deepEqual(navigationLookAhead({ ...input, now: 5000 }), [0, 0]);
  assert.deepEqual(navigationLookAhead({ ...input, bearing: null }), [0, 0]);
  assert.deepEqual(navigationLookAhead({ ...input, now: 500 }), [0, 0]);
  assert.ok(
    Math.hypot(...navigationLookAhead({ ...input, distance: 100 })) <= 5,
  );
});
