import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { detailLabelVisibleAtScale } from "../src/map/room-labels.js";
import { createStaircase, getMapStairMarkers } from "../src/map/stairs.js";

test("a neighboring building keeps its room labels while another building is selected", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    ),
  );
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    plan: true,
    neighborsOn: true,
    floorHeight: 3.6,
    wallHeight: 2.7,
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: { replaceChildren() {} },
    addLabel(text, point, height, kind, onClick, id, roomRadius) {
      this.roomLabels.push({ text, point, kind, id, roomRadius });
      return {};
    },
    invalidate() {},
  });
  try {
    view.setFloor(floor, "А", { fit: false });
    for (const text of ["А-203", "Г-310"]) {
      const label = view.roomLabels.find((item) => item.text === text);
      assert.ok(label?.roomRadius, `${text} has a fitted indoor badge`);
      assert.equal(label.kind, "room");
    }
  } finally {
    view.clear();
  }
});

test("room badges keep the same size at both zooms and skip overlapping neighbors", () => {
  for (const plan of [true, false]) {
    const width = 390,
      height = 844;
    const aspect = width / height;
    const camera = plan
      ? new THREE.OrthographicCamera(
          -55 * aspect,
          55 * aspect,
          55,
          -55,
          0.1,
          1000,
        )
      : new THREE.PerspectiveCamera(38, aspect, 0.1, 1000);
    if (plan) camera.up.set(0, 0, -1);
    const labels = Array.from({ length: 32 }, (_, index) => ({
      kind: "room",
      id: `room-${index}`,
      roomRadius: 1.8,
      position: new THREE.Vector3(
        ((index % 8) - 3.5) * 3.5,
        0.13,
        (Math.floor(index / 8) - 1.5) * 5,
      ),
      el: { textContent: "А-111", style: {}, classList: { toggle() {} } },
    }));
    const view = Object.assign(Object.create(AtlasScene.prototype), {
      mode: "floor",
      plan,
      labelsOn: true,
      camera,
      host: {
        clientWidth: width,
        clientHeight: height,
        getBoundingClientRect: () => ({ x: 0, y: 0 }),
      },
      labelObstacles: [],
      roomLabels: labels,
      updateUserLocationOverlay: () => null,
    });
    camera.position.set(0, 90, plan ? 0 : 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    view.updateLabels();
    const visible = () =>
      labels.filter((label) => label.el.style.display === "block");
    const closerCount = visible().length;
    assert.ok(closerCount > 0);
    for (const { el } of visible())
      assert.doesNotMatch(el.style.transform, /scale/);

    if (plan) {
      camera.zoom = 0.4;
      camera.updateProjectionMatrix();
    } else {
      camera.position.multiplyScalar(3);
      camera.updateMatrixWorld();
    }
    view.updateLabels();
    assert.ok(visible().length > 0 && visible().length < closerCount);
    for (const { el } of visible())
      assert.doesNotMatch(el.style.transform, /scale/);

    if (plan) {
      camera.zoom = 0.1;
      camera.updateProjectionMatrix();
    } else {
      camera.position.multiplyScalar(4);
      camera.updateMatrixWorld();
    }
    view.updateLabels();
    assert.equal(
      visible().length,
      0,
      "very distant rooms no longer leave floating badges",
    );

    view.labelsOn = false;
    view.updateLabels();
    assert.ok(labels.every((label) => label.el.style.display === "none"));
  }
});

test("detail scale hysteresis keeps room and stair names stable around zoom thresholds", () => {
  let visible;
  for (const [scale, expected] of [
    [0.31, true],
    [0.36, true],
    [0.39, true],
    [0.41, false],
    [0.39, false],
    [0.33, false],
    [0.31, true],
  ]) {
    visible = detailLabelVisibleAtScale(visible, scale);
    assert.equal(visible, expected, `room scale ${scale}`);
  }
  assert.equal(detailLabelVisibleAtScale(undefined, 0.14, "stairs"), true);
  assert.equal(detailLabelVisibleAtScale(true, 0.17, "stairs"), true);
  assert.equal(detailLabelVisibleAtScale(true, 0.18, "stairs"), false);
  assert.equal(detailLabelVisibleAtScale(false, 0.17, "stairs"), false);
  assert.equal(detailLabelVisibleAtScale(false, 0.13, "stairs"), true);
});

function labelHarness(plan, width = 390, height = 844) {
  const aspect = width / height;
  const camera = plan
    ? new THREE.OrthographicCamera(
        -400 * aspect,
        400 * aspect,
        400,
        -400,
        0.1,
        5000,
      )
    : new THREE.PerspectiveCamera(38, aspect, 0.1, 5000);
  camera.up.set(0, 0, -1);
  camera.position.set(0, plan ? 100 : 1400, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return Object.assign(Object.create(AtlasScene.prototype), {
    camera,
    plan,
    mode: "floor",
    building: "А",
    labelsOn: true,
    host: {
      clientWidth: width,
      clientHeight: height,
      getBoundingClientRect: () => ({ x: 0, y: 0 }),
    },
    roomLabels: [],
    labelObstacles: [],
    updateUserLocationOverlay: () => null,
  });
}
function badge(kind, id, x, z, text = id) {
  return {
    kind,
    id,
    roomRadius: kind === "room" ? 2 : undefined,
    position: new THREE.Vector3(x, kind === "stairs" ? 4.2 : 0.13, z),
    el: { textContent: text, style: {}, classList: { toggle() {} } },
  };
}
for (const plan of [true, false]) {
  test(`${plan ? "2D" : "3D"}: far zoom hides detail even with a building selected, preserving selected point and building names`, () => {
    const view = labelHarness(plan);
    const room = badge("room", "А-312", 0, 0);
    const selected = badge("room", "А-311", -150, 0);
    const building = badge("building", "building-А", 150, 0, "А");
    const stair = badge("stairs", "stair", 0, 100);
    view.roomLabels = [room, selected, building, stair];
    view.selectedId = selected.id;
    view.updateLabels();
    assert.equal(room.el.style.display, "none");
    assert.equal(stair.el.style.display, "none");
    assert.equal(selected.el.style.display, "block");
    assert.equal(building.el.style.display, "block");
    if (plan) {
      view.camera.zoom = 8;
      view.camera.updateProjectionMatrix();
    } else {
      view.camera.position.y = 100;
      view.camera.updateMatrixWorld();
    }
    view.updateLabels();
    assert.equal(room.el.style.display, "block", "nearby room names return");
    assert.equal(
      selected.el.style.display,
      "none",
      "an offscreen selection is not pinned to the viewport",
    );
    assert.equal(
      view.selectedId,
      "А-311",
      "panning/zooming does not clear the user's selected card",
    );
  });
}

test("A3 small stair keeps its actual anchor and hides instead of floating around an obstacle or viewport edge", () => {
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor3.json", import.meta.url),
    ),
  );
  const marker = getMapStairMarkers(floor).find(
    (item) => item.layoutId === "v-78-floor3-photo-stair-small-straight",
  );
  const stair = createStaircase(marker, floor);
  const box = new THREE.Box3().setFromObject(stair);
  assert.ok(marker.center[0] >= box.min.x && marker.center[0] <= box.max.x);
  assert.ok(marker.center[1] >= box.min.z && marker.center[1] <= box.max.z);
  const view = labelHarness(true, 1000, 400);
  view.camera.zoom = 16;
  view.camera.position.set(marker.center[0], 100, marker.center[1]);
  view.camera.lookAt(marker.center[0], 0, marker.center[1]);
  view.camera.updateProjectionMatrix();
  view.camera.updateMatrixWorld();
  const label = badge(
    "stairs",
    marker.id,
    ...marker.center,
    "Малая прямая лестница холла",
  );
  view.roomLabels = [label];
  view.labelObstacles = [
    {
      getBoundingClientRect: () => ({ x: 475, y: 125, width: 50, height: 150 }),
    },
  ];
  view.updateLabels();
  assert.equal(
    label.el.style.display,
    "none",
    "cannot relocate the stair name a badge-width away",
  );
  view.labelObstacles = [];
  view.updateLabels();
  assert.equal(label.el.style.display, "block");
  const coordinates = label.el.style.transform.match(
    /translate\(([\d.]+)px,([\d.]+)px\)/,
  );
  assert.ok(Math.abs(Number(coordinates[1]) - 500) < 1e-8);
  assert.ok(Math.abs(Number(coordinates[2]) - 200) < 1e-8);
  view.camera.position.x += 60;
  view.camera.lookAt(marker.center[0] + 60, 0, marker.center[1]);
  view.camera.updateMatrixWorld();
  view.updateLabels();
  assert.equal(
    label.el.style.display,
    "none",
    "does not clamp a long name far away from an edge anchor",
  );
  stair.traverse((object) => {
    object.geometry?.dispose();
    for (const material of [].concat(object.material || [])) material.dispose();
  });
});
