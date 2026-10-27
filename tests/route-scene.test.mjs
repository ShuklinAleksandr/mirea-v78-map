import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createRouteLayer,
  createSchematicConnection,
  disposeRouteLayer,
  routeArrowAnchors,
  routeBounds,
  visibleRouteSegments,
} from "../src/map/route.js";
import { AtlasScene } from "../src/map/scene.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const route = {
  segments: [
    {
      floorId: "f1",
      points: [
        [0, 0],
        [0, 0],
        [12, 0],
        [12, 15],
      ],
    },
    {
      floorId: "f2",
      points: [
        [12, 15],
        [12, 30],
      ],
    },
    {
      floorId: "f1",
      points: [
        [12, 30],
        [20, 30],
      ],
    },
  ],
  start: { floorId: "f1", point: [0, 0] },
  end: { floorId: "f1", point: [20, 30], label: "А-101" },
  transitions: [
    {
      fromFloorId: "f1",
      toFloorId: "f2",
      point: [12, 15],
      targetPoint: [12, 15],
      label: "Поднимитесь",
    },
  ],
};

test("route render preserves separate visits to a floor without inventing a connecting leg", () => {
  const segments = visibleRouteSegments(route, "f1");
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].points, [
    [0, 0],
    [12, 0],
    [12, 15],
  ]);
  const layer = createRouteLayer(route, "f1");
  try {
    const lines = layer.group.children.filter((object) => object.isLine2);
    assert.equal(
      lines.length,
      4,
      "two independent paths, each with its own underlay",
    );
    assert.ok(
      lines.every((line) => !line.material.worldUnits),
      "stroke width is screen-space",
    );
    assert.equal(
      layer.labels.filter((label) => label.type === "transition").length,
      1,
    );
    assert.deepEqual(routeBounds(route, "f2", 0), [12, 15, 12, 30]);
    assert.equal(routeBounds(route, "missing"), null);
  } finally {
    disposeRouteLayer(layer);
  }
});

test("invalid route vertices do not become fabricated shortcuts", () => {
  const invalid = {
    segments: [
      {
        floorId: "f1",
        points: [
          [0, 0],
          [NaN, 10],
          [20, 20],
        ],
      },
    ],
  };
  assert.deepEqual(visibleRouteSegments(invalid, "f1"), []);
});

test("stacked route draws after transparent slabs, with all path cues visible through upper floors", () => {
  const stairPaths = [
    {
      sourcePoint: [11, 15],
      points: [
        [12, 0.35, 15],
        [12, 1.8, 18],
        [12, 3.95, 15],
      ],
      status: "photo-backed",
      sourceEdgeId: "stairs",
    },
  ];
  const overlay = createRouteLayer(route, "f1", { overlay: true, stairPaths });
  const singleFloor = createRouteLayer(route, "f1");
  const connector = createSchematicConnection([
    [12, 3.95, 15],
    [14, 3.95, 15],
  ]);
  try {
    for (const layer of [overlay, connector]) {
      layer.group.traverse((object) => {
        for (const material of [].concat(object.material || [])) {
          assert.equal(
            material.transparent,
            true,
            "same queue as translucent architecture",
          );
          assert.equal(
            material.depthTest,
            false,
            "upper floors cannot hide a lower path",
          );
          assert.equal(
            material.depthWrite,
            false,
            "route does not obscure other floors",
          );
          assert.ok(
            object.renderOrder > 0,
            "draw after the architecture, including endpoint markers",
          );
        }
      });
    }
    singleFloor.group.traverse((object) => {
      for (const material of [].concat(object.material || []))
        assert.equal(
          material.depthTest,
          true,
          "single-floor view retains physical occlusion",
        );
    });
  } finally {
    for (const layer of [overlay, singleFloor, connector])
      disposeRouteLayer(layer);
  }
});

test("direction arrows follow each actual source leg, including sharp corners", () => {
  const arrows = routeArrowAnchors([
    [0, 0],
    [12, 0],
    [12, 15],
  ]);
  assert.ok(arrows.length > 2);
  for (const arrow of arrows) {
    const [x, z] = arrow.point;
    assert.ok(
      (z === 0 && x >= 0 && x <= 12) || (x === 12 && z >= 0 && z <= 15),
    );
    assert.ok(arrow.angle === 0 || Math.abs(arrow.angle + Math.PI / 2) < 1e-8);
  }
});

test("route fitting leaves a mobile bottom sheet clear in orthographic projection", () => {
  const camera = new THREE.OrthographicCamera(-30, 30, 50, -50, 0.1, 5000);
  camera.up.set(0, 0, -1);
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    host: { clientWidth: 390, clientHeight: 844 },
    perspectiveCamera: { aspect: 390 / 844 },
    planCamera: camera,
    camera,
    plan: true,
    mode: "floor",
    model: new THREE.Group(),
    controls: { maxDistance: 0 },
    sun: new THREE.DirectionalLight(),
    invalidate() {},
    moveCamera(position, target) {
      camera.position.copy(position);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
    },
  });
  view.fit([0, 0, 20, 40], false, {
    top: 100,
    bottom: 300,
    left: 20,
    right: 40,
  });
  for (const point of [
    [0, 0],
    [20, 40],
    [0, 40],
    [20, 0],
  ]) {
    const projected = new THREE.Vector3(point[0], 0, point[1]).project(camera);
    const x = (projected.x / 2 + 0.5) * 390;
    const y = (-projected.y / 2 + 0.5) * 844;
    assert.ok(x >= 20 && x <= 350, `x=${x}`);
    assert.ok(y >= 100 && y <= 544, `y=${y}`);
  }
});

test("perspective route fitting keeps route corners outside mobile controls", () => {
  const camera = new THREE.PerspectiveCamera(38, 390 / 844, 0.1, 5000);
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(50, 4, 20)));
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    host: { clientWidth: 390, clientHeight: 844 },
    perspectiveCamera: camera,
    camera,
    plan: false,
    mode: "floor",
    model,
    controls: { maxDistance: 0 },
    sun: new THREE.DirectionalLight(),
    invalidate() {},
    moveCamera(position, target) {
      camera.position.copy(position);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
    },
  });
  view.fit([0, 0, 50, 20], false, {
    top: 100,
    bottom: 300,
    left: 20,
    right: 60,
  });
  for (const point of [
    [0, 0],
    [50, 20],
    [0, 20],
    [50, 0],
  ]) {
    const projected = new THREE.Vector3(point[0], 0.3, point[1]).project(
      camera,
    );
    const x = (projected.x / 2 + 0.5) * 390;
    const y = (-projected.y / 2 + 0.5) * 844;
    assert.ok(x >= 20 && x <= 330, `x=${x}`);
    assert.ok(y >= 100 && y <= 544, `y=${y}`);
  }
  model.children[0].geometry.dispose();
  model.children[0].material.dispose();
});

test("stacked route preserves source level heights, keeps focus, and disposes geometry on return", () => {
  const previousDocument = globalThis.document;
  function element() {
    return {
      style: {},
      dataset: {},
      children: [],
      append(child) {
        this.children.push(child);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute() {},
      remove() {},
    };
  }
  globalThis.document = { createElement: element };
  const floors = [0, 1, 2].map((level) => ({
    id: `test-floor${level}`,
    level,
    label: `${level + 1} этаж`,
    polygons: [
      {
        id: `corridor-${level}`,
        kind: "corridor",
        points: [
          [0, 0],
          [30, 0],
          [30, 30],
          [0, 30],
        ],
        center: [15, 15],
      },
    ],
    footprints: [
      {
        points: [
          [0, 0],
          [30, 0],
          [30, 30],
          [0, 30],
        ],
      },
    ],
    markers: [],
    transitions: [],
    walls: [],
    doors: [],
  }));
  const route = {
    ok: true,
    segments: [floors[0], floors[2]].map((floor) => ({
      floorId: floor.id,
      points: [
        [5, 5],
        [20, 5],
      ],
      nodes: [
        {
          building: "А",
          physicalLevel: floor.level + 1,
          sourceLevel: floor.level,
        },
      ],
    })),
    transitions: [
      {
        fromFloorId: floors[0].id,
        toFloorId: floors[2].id,
        point: [20, 5],
        targetPoint: [5, 5],
        sourceEdgeId: "source-stair",
      },
    ],
    start: { floorId: floors[0].id, point: [5, 5] },
    end: { floorId: floors[2].id, point: [20, 5], label: "А-301" },
  };
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.1, 5000);
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    host: { clientWidth: 900, clientHeight: 600 },
    scene: new THREE.Scene(),
    model: new THREE.Group(),
    context: new THREE.Group(),
    selection: new THREE.Group(),
    hover: new THREE.Group(),
    labelLayer: element(),
    roomLabels: [],
    pickables: [],
    perspectiveCamera: camera,
    camera,
    plan: false,
    controls: new OrbitControls(camera, null),
    renderer: { shadowMap: {} },
    sun: new THREE.DirectionalLight(),
    ground: new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial(),
    ),
    theme: "light",
    callbacks: {},
    floorHeight: 3.6,
    wallHeight: 2.7,
    floors,
    floor: floors[0],
    route,
  });
  view.scene.add(view.model, view.context, view.selection, view.hover);
  try {
    view.setRouteOverview(true);
    assert.equal(view.routeOverview, true);
    assert.equal(view.mode, "route-overview");
    assert.equal(view.floor.id, floors[0].id);
    assert.deepEqual(
      view.routeStages.map((stage) => stage.floorId),
      [floors[0].id, floors[2].id],
    );
    assert.equal(
      view.routeStages[1].group.position.y,
      7.2,
      "two source levels retain two 3.6-unit rises",
    );
    assert.ok(
      view.roomLabels.some((label) => label.el.textContent === "А · 3 этаж"),
    );
    for (const [index, stage] of view.routeStages.entries()) {
      const layer = stage.view.routeLayer;
      assert.ok(layer, "each visited floor renders its own route");
      for (const material of layer.materials) {
        assert.equal(material.transparent, true);
        assert.equal(material.depthTest, false);
        assert.equal(material.depthWrite, false);
        assert.equal(material.opacity, index === 0 ? 1 : 0.88);
        assert.ok(
          material.linewidth >= 6.3,
          "inactive floor route remains a substantial screen-space stroke",
        );
      }
    }
    const geometries = new Set();
    let disposed = 0;
    view.model.traverse((object) => {
      if (!object.geometry) return;
      assert.ok(
        !geometries.has(object.geometry),
        "stage geometry is not shared",
      );
      geometries.add(object.geometry);
      object.geometry.addEventListener("dispose", () => disposed++);
    });
    assert.ok(
      view.routeLayers.some((layer) =>
        layer.group.children.some(
          (child) =>
            child.userData.status === "source-stair-placement-approximate",
        ),
      ),
    );
    view.setRouteOverview(false);
    assert.equal(view.routeOverview, false);
    assert.equal(view.mode, "floor");
    assert.equal(view.route, route);
    assert.equal(
      disposed,
      geometries.size,
      "all stage geometries are disposed once",
    );
    view.clearRoute();
    for (const floor of floors) {
      floor.polygons[0].building = "А";
      floor.buildingLevels = { А: floor.level + 2 };
    }
    assert.equal(view.setBuildingOverview("А"), true);
    assert.equal(view.buildingOverview, true);
    assert.equal(view.routeOverview, false);
    assert.equal(view.route, null, "exploration does not fabricate a route");
    assert.deepEqual(
      view.routeStages.map((stage) => stage.y),
      [0, 3.6, 7.2],
    );
    assert.ok(
      view.roomLabels.some(
        (label) => label.el.textContent === "В фокусе · А · 2 этаж",
      ),
    );
    assert.ok(
      view.roomLabels.some((label) => label.el.textContent === "А · 4 этаж"),
    );
    for (const stage of view.routeStages.slice(1)) {
      stage.view.model.traverse((object) => {
        assert.equal(
          object.castShadow,
          false,
          "transparent floors cannot cast solid shadows onto the focus",
        );
      });
    }
    view.setRouteOverview(false);
    assert.equal(view.buildingOverview, false);
    assert.equal(view.floor.id, floors[0].id);
  } finally {
    view.clear();
    view.clearRoute({ rebuild: false });
    view.ground.geometry.dispose();
    view.ground.material.dispose();
    globalThis.document = previousDocument;
  }
});

test("architecture theme roundtrip preserves original colors and uses a slate dark palette", () => {
  const material = new THREE.MeshStandardMaterial({ color: 0xb7ccc2 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const original = material.color.clone();
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    model: new THREE.Group(),
    context: new THREE.Group(),
    theme: "dark",
  });
  view.model.add(mesh);
  try {
    view.applyTheme();
    const hsl = {};
    material.color.getHSL(hsl);
    assert.ok(Math.abs(hsl.h - 0.61) < 1e-6);
    view.theme = "light";
    view.applyTheme();
    assert.deepEqual(material.color.toArray(), original.toArray());
    view.theme = "dark";
    view.applyTheme();
    view.applyTheme();
    material.color.getHSL(hsl);
    assert.ok(
      Math.abs(hsl.h - 0.61) < 1e-6,
      "reapplying dark does not accumulate color changes",
    );
  } finally {
    mesh.geometry.dispose();
    material.dispose();
  }
});
