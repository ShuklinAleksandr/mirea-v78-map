import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import registry from "../public/data/stair-layouts.json" with { type: "json" };
import upper from "../src/data/stair-scan-meshes/grand-upper.json" with { type: "json" };
import standard from "../src/data/stair-scan-meshes/standard-cell.json" with { type: "json" };
import lower from "../src/data/stair-scan-meshes/grand-lower.json" with { type: "json" };
import { AtlasScene } from "../src/map/scene.js";
import { pointInLocationPolygon } from "../src/location.js";
import {
  createStaircase,
  getMapStairMarkers,
  stairLayoutFor,
  getStairDisplayCutouts,
  withStairDisplayCutouts,
} from "../src/map/stairs.js";
import {
  createStairScanVisual,
  stairScanBinding,
  scanBackedStairLayoutsForFloor,
} from "../src/map/stair-scan-visual.js";
import { stairScanDisplayTopology } from "../src/map/stair-scan-repair.js";

const floor = (n) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${n}.json`,
        import.meta.url,
      ),
    ),
  );
function resolve(n, id) {
  const f = floor(n);
  const marker = getMapStairMarkers(f).find((m) => m.layoutId === id);
  assert.ok(marker, id);
  return { floor: f, marker, layout: stairLayoutFor(marker, f) };
}
function dispose(group) {
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
}
const bounds = (group) => new THREE.Box3().setFromObject(group);

test("real reconstructed assets retain raw source provenance and right-handed Z-up axes without texture data", () => {
  for (const asset of [upper, standard, lower]) {
    assert.equal(asset.upAxis, "Z");
    assert.equal(
      asset.source.facesPresent,
      false,
      "source PLY was a point cloud, not an original triangle mesh",
    );
    assert.equal(
      asset.reconstruction.method,
      "observed-surface-ball-pivoting-with-bounded-planar-regularization",
    );
    assert.equal(asset.reconstruction.targetTriangles, 24_000);
    assert.ok(asset.indices.length / 3 > 20_000, "tread detail is retained");
    assert.equal(asset.surfaceRegularization.noHoleFilling, true);
    assert.ok(asset.surfaceRegularization.maxMove <= 0.060001);
    assert.ok(asset.surfaceRegularization.nearestOriginalPointMax < 0.075);
    assert.ok(asset.surfaceRegularization.horizontalSnappedPoints > 10_000);
    assert.equal(asset.reconstruction.fillHoles, false);
    assert.match(asset.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      asset.indices.length / 3 > 1000 && asset.indices.length / 3 <= 24_000,
    );
    assert.equal(asset.textures, false);
    assert.equal(asset.uv, false);
    assert.equal(asset.vertexColors, false);
    const { u, v } = asset.horizontalAxes;
    // Raw XYZ -> scene [U,Z,V] has determinant -(U,V), so this is +1.
    assert.ok(Math.abs(-(u[0] * v[1] - u[1] * v[0]) - 1) < 1e-6);
  }
});

test("polished observed surfaces retain flat treads instead of rounding them into ramps", () => {
  for (const asset of [upper, standard, lower]) {
    let horizontalArea = 0;
    let flatArea = 0;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      normal = new THREE.Vector3();
    for (let i = 0; i < asset.indices.length; i += 3) {
      a.fromArray(asset.positions, asset.indices[i] * 3);
      b.fromArray(asset.positions, asset.indices[i + 1] * 3).sub(a);
      c.fromArray(asset.positions, asset.indices[i + 2] * 3).sub(a);
      normal.crossVectors(b, c);
      const area = normal.length();
      if (!area) continue;
      const up = normal.z / area;
      if (up > 0.9) horizontalArea += area;
      if (up > 0.9999) flatArea += area;
    }
    assert.ok(horizontalArea > 10, asset.id);
    assert.ok(
      flatArea / horizontalArea > (asset.id === "standard-cell" ? 0.85 : 0.7),
      `${asset.id}: actual horizontal surfaces remain planar`,
    );
  }
});

test("the displayed scan repairs leave the observed central stairwell open", () => {
  const display = stairScanDisplayTopology(standard);
  assert.ok(display.holes > 0, "the display actually repairs some closed gaps");
  assert.ok(display.isolatedTriangles > 0, "the display omits stray fragments");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(standard.positions, 3),
  );
  geometry.setIndex([...display.observedIndices, ...display.patchIndices]);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld(true);
  try {
    for (const [x, y] of [
      [0, 0],
      [-0.4, 0],
      [0.4, 0],
      [0, 0.5],
      [0, -0.5],
    ]) {
      const ray = new THREE.Raycaster(
        new THREE.Vector3(x, y, standard.floorRange[1] + 0.1),
        new THREE.Vector3(0, 0, -1),
        0,
        standard.floorRange[1] - standard.floorRange[0] + 0.2,
      );
      assert.equal(
        ray.intersectObject(mesh).length,
        0,
        `open well at ${x},${y}`,
      );
    }
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test("accepted main upper uses the actual scan once and preserves its original frame, flights, markers and source bytes", () => {
  const item = resolve(2, "v-78-floor2-photo-stair-wide-hall");
  const original = registry.layouts.find((l) => l.id === item.layout.id);
  const before = JSON.stringify([item.floor, original, upper]);
  const group = createStaircase(item.marker, item.floor);
  try {
    assert.equal(
      group.children.length,
      1,
      "no procedural stairs or enclosure under the scan",
    );
    assert.equal(group.userData.scanVisual.assetId, "grand-upper");
    assert.ok(group.userData.scanVisual.displayRepairs.displayedTriangles > 0);
    assert.ok(
      group.userData.scanVisual.displayRepairs.isolatedSourceTrianglesHidden >
        0,
    );
    assert.equal(
      group.userData.visualStepCounts.length,
      0,
      "scan geometry is not assigned invented tread counts",
    );
    assert.deepEqual(item.layout.frame, original.frame);
    assert.deepEqual(item.layout.flights, original.flights);
    assert.deepEqual(item.marker.sourceIds, [
      "v-78:edge:20744",
      "v-78:edge:20745",
    ]);
    const box = bounds(group);
    assert.ok(
      box.max.x - box.min.x > 18,
      "PCA registration keeps the main stair broad",
    );
    assert.ok(box.max.x - box.min.x <= 24);
    assert.ok(box.max.z - box.min.z <= 4.4);
    assert.equal(JSON.stringify([item.floor, original, upper]), before);
    assert.match(
      group.userData.scanVisual.verticalScaleStatus,
      /assumed-floor-rise/u,
    );
  } finally {
    dispose(group);
  }
});

test("horizontal placement uses one scale: a wider frame alone cannot stretch the scanned stair", () => {
  const item = resolve(2, "v-78-floor2-photo-stair-wide-hall");
  const wide = {
    ...item.layout,
    frame: { ...item.layout.frame, size: [48, 4.4] },
  };
  const a = createStairScanVisual(item.layout, item.marker);
  const b = createStairScanVisual(wide, item.marker);
  try {
    const ba = bounds(a),
      bb = bounds(b);
    assert.ok(Math.abs(ba.max.x - ba.min.x - (bb.max.x - bb.min.x)) < 1e-4);
    assert.equal(
      a.userData.scanVisual.horizontalScale,
      b.userData.scanVisual.horizontalScale,
    );
    assert.notEqual(
      a.userData.scanVisual.horizontalScale,
      a.userData.scanVisual.verticalScale,
      "vertical fit is explicit and separate",
    );
  } finally {
    dispose(a);
    dispose(b);
  }
});

test("each instance owns geometry and material, so rebuilding one floor cannot dispose another scan", () => {
  const item = resolve(2, "v78-Г-2-ЛК2");
  const a = createStaircase(item.marker, item.floor),
    b = createStaircase(item.marker, item.floor);
  try {
    const ma = a.children[0],
      mb = b.children[0];
    assert.notEqual(ma.geometry, mb.geometry);
    assert.notEqual(ma.material, mb.material);
    const old = mb.geometry.attributes.position.getX(0);
    ma.geometry.attributes.position.setX(0, 999);
    assert.equal(mb.geometry.attributes.position.getX(0), old);
    assert.deepEqual(Object.keys(mb.geometry.attributes).sort(), [
      "color",
      "normal",
      "position",
    ]);
    assert.equal(mb.material.map, null);
    assert.equal(mb.material.vertexColors, true);
    assert.equal(mb.material.color.getHex(), 0xffffff);
    assert.equal(mb.material.roughness, 0.9);
    assert.equal(mb.material.polygonOffset, true);
    assert.equal(mb.receiveShadow, false);
    assert.notEqual(ma.geometry.attributes.color, mb.geometry.attributes.color);
  } finally {
    dispose(a);
    dispose(b);
  }
});

test("scan display tones distinguish treads from risers without applying source RGB", () => {
  const stone = new THREE.Color(0xd7e0e5),
    riser = new THREE.Color(0xb9c7d1);
  const item = resolve(2, "v-78-floor2-photo-stair-wide-hall");
  const before = JSON.stringify(upper);
  const group = createStaircase(item.marker, item.floor);
  try {
    const geometry = group.children[0].geometry,
      colors = geometry.getAttribute("color"),
      normals = geometry.getAttribute("normal");
    assert.equal(colors.count, geometry.getAttribute("position").count);
    assert.equal(colors.itemSize, 3);
    assert.ok([...colors.array].every(Number.isFinite));
    let treadVertices = 0,
      riserVertices = 0,
      transitionVertices = 0;
    const expected = new THREE.Color();
    for (let i = 0; i < colors.count; i++) {
      const y = Math.abs(normals.getY(i));
      expected.copy(riser).lerp(stone, THREE.MathUtils.smoothstep(y, 0.5, 0.9));
      for (const [actual, target] of [
        [colors.getX(i), expected.r],
        [colors.getY(i), expected.g],
        [colors.getZ(i), expected.b],
      ])
        assert.ok(Math.abs(actual - target) < 1e-6);
      if (y >= 0.9) treadVertices++;
      else if (y <= 0.5) riserVertices++;
      else transitionVertices++;
    }
    assert.ok(treadVertices > 30 && riserVertices > 30);
    assert.ok(transitionVertices > 0, "slopes receive a continuous blend");
    assert.deepEqual(group.userData.scanVisual.normalSmoothing, {
      creaseDegrees: 20,
      positionsChanged: false,
    });
    assert.equal(group.userData.scanVisual.displayColor.sourceColors, false);
    assert.equal(group.userData.scanVisual.textures, false);
    assert.equal(JSON.stringify(upper), before);
  } finally {
    dispose(group);
  }
});

test("main lower scan is sliced into its two observed storeys, never squeezed whole and repeated", () => {
  const first = resolve(1, "v-78-floor1-photo-stair-A154");
  const arrival = resolve(2, "v-78-floor2-photo-stair-A154-arrival");
  const ivc = resolve(1, "v-78-floor1-user-stair-basement");
  const groups = [first, arrival, ivc].map((i) =>
    createStaircase(i.marker, i.floor),
  );
  try {
    assert.deepEqual(
      groups[0].userData.scanVisual.sourceFloorRange,
      [-5.475, -1.375],
    );
    assert.deepEqual(
      groups[1].userData.scanVisual.sourceFloorRange,
      [-5.475, -1.375],
    );
    assert.deepEqual(
      groups[2].userData.scanVisual.sourceFloorRange,
      [-9.375, -5.475],
    );
    assert.equal(ivc.marker.targets.length, 0);
    assert.equal(ivc.layout.pairedLayoutId, undefined);
    assert.equal(ivc.layout.routingStatus, "display-only-no-source-transition");
    assert.ok(bounds(groups[1]).min.y < -3);
    assert.ok(bounds(groups[2]).min.y < -3);
    assert.ok(bounds(groups[2]).max.y <= 0.14001);
    for (const g of groups) assert.equal(g.children.length, 1);
  } finally {
    groups.forEach(dispose);
  }
});

test("middle G/V floors show only the corresponding observed half-up and half-down surfaces", () => {
  for (const building of ["Г", "В"]) {
    const item = resolve(2, `v78-${building}-2-ЛК2`);
    const group = createStaircase(item.marker, item.floor);
    try {
      assert.deepEqual(group.userData.scanVisual.parts, [
        "outgoing-half",
        "incoming-half",
      ]);
      const box = bounds(group);
      assert.ok(box.min.y < -1 && box.max.y > 1);
      assert.ok(box.min.y >= 0.14 - 1.8 - 0.15 - 1e-5);
      assert.ok(box.max.y <= 0.14 + 1.8 + 0.9 + 1e-5);
      assert.equal(group.userData.middleFloorCutaway, true);
    } finally {
      dispose(group);
    }
  }
});

test("last available standard floor is an arrival below the slab, not a new flight to the roof", () => {
  const item = resolve(3, "v78-Г-3-ЛК2");
  const group = createStaircase(item.marker, item.floor);
  try {
    assert.equal(item.layout.levelRole, "upper-arrival");
    assert.deepEqual(group.userData.scanVisual.parts, ["upper-arrival"]);
    assert.ok(bounds(group).min.y < -3);
    assert.ok(bounds(group).max.y <= 1.041);
  } finally {
    dispose(group);
  }
});

test("stacked renderer still omits the repeated upper view of one physical stair", () => {
  const item = resolve(3, "v78-Г-3-ЛК2");
  for (const stackDisplay of [false, true]) {
    const view = {
      model: new THREE.Group(),
      pickables: [],
      stackDisplay,
      assumptions: { floorHeight: 3.6 },
      addLabel: () => ({ title: "" }),
    };
    AtlasScene.prototype.addConnections.call(view, item.floor);
    try {
      const markers = view.model.children.flatMap(
        (mesh) => mesh.userData.faceRooms || [],
      );
      assert.equal(
        markers.some((m) => m.layoutId === item.layout.id),
        !stackDisplay,
      );
    } finally {
      dispose(view.model);
    }
  }
});

test("D uses guarded existing portals and scan-derived openings bounded by the original cell", () => {
  for (const n of [1, 2, 3]) {
    const f = floor(n),
      before = JSON.stringify(f);
    const layouts = scanBackedStairLayoutsForFloor(f);
    assert.equal(layouts.length, 1);
    const layout = layouts[0];
    assert.match(layout.geometryEvidence, /source-portals/u);
    const marker = getMapStairMarkers(f).find((m) => m.layoutId === layout.id);
    const group = createStaircase(marker, f);
    try {
      assert.equal(group.userData.scanVisual.assetId, "standard-cell");
      const area = f.polygons.find((p) => p.id === layout.fitAreaId);
      const points = group.children[0].geometry.attributes.position;
      for (let i = 0; i < points.count; i++)
        assert.ok(
          pointInLocationPolygon(
            [
              points.getX(i) + group.position.x,
              points.getZ(i) + group.position.z,
            ],
            area,
          ),
        );
      const cuts = getStairDisplayCutouts(f).filter((c) =>
        c.sourcePolygonIds.includes(area.id),
      );
      assert.ok(
        cuts.length > 0,
        "a descending mesh must not hide under an unchanged solid slab",
      );
      for (const cut of cuts) {
        assert.match(cut.geometryEvidence, /observed-descending-scan-surface/u);
        assert.equal(
          polygonClipping.difference(
            [cut.points],
            [area.points, ...(area.holes || [])],
          ).length,
          0,
        );
      }
      const displayArea = withStairDisplayCutouts(area, cuts);
      assert.notEqual(displayArea, area);
      assert.ok(displayArea.holes.length >= cuts.length);
      assert.equal(
        JSON.stringify(f),
        before,
        "no source floor, room, wall, opening or graph mutation",
      );
    } finally {
      dispose(group);
    }
  }
});

test("a changed D cell or portal fails closed, while its unregistered first-floor region remains a source symbol", () => {
  const changed = floor(2);
  changed.polygons.find((p) => p.id === "v-78-floor2-area-264").points[0][0] +=
    0.1;
  assert.deepEqual(scanBackedStairLayoutsForFloor(changed), []);
  const alteredPortal = floor(2);
  for (const list of [alteredPortal.markers, alteredPortal.transitions])
    for (const m of list) if (m.id === "v-78:edge:20743") m.position[0] += 1;
  assert.deepEqual(scanBackedStairLayoutsForFloor(alteredPortal), []);
  assert.deepEqual(scanBackedStairLayoutsForFloor(floor(0)), []);
});

test("library, compact side-U and unknown stair markers keep their distinct existing visuals", () => {
  const library = resolve(2, "v-78-floor2-user-stair-library");
  assert.equal(stairScanBinding(library.layout), null);
  const compact = registry.layouts.find(
    (l) => l.building === "Г" && l.shape === "side-left-U",
  );
  assert.equal(stairScanBinding(compact), null);
  const group = createStaircase(library.marker, library.floor);
  try {
    assert.equal(group.userData.scanVisual, undefined);
  } finally {
    dispose(group);
  }
});

test("observed descending tread centres in main lower and G/V views are exposed by the display openings", () => {
  for (const [n, id] of [
    [2, "v-78-floor2-photo-stair-A154-arrival"],
    [1, "v-78-floor1-user-stair-basement"],
    [2, "v78-Г-2-ЛК2"],
    [2, "v78-В-2-ЛК2"],
  ]) {
    const item = resolve(n, id),
      before = JSON.stringify(item.floor);
    const group = createStaircase(item.marker, item.floor);
    const cell = item.floor.polygons.find(
      (p) => p.id === (item.layout.containerAreaId || item.layout.fitAreaId),
    );
    const cuts = getStairDisplayCutouts(item.floor).filter(
      (c) => c.layoutId === id || c.layoutId === `${id}:incoming`,
    );
    assert.ok(
      cuts.some((c) => /scan-projection/u.test(c.geometryEvidence || "")),
      id,
    );
    let tested = 0;
    try {
      const p = group.children[0].geometry.attributes.position;
      for (let i = 0; i < p.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, i),
          b = new THREE.Vector3().fromBufferAttribute(p, i + 1),
          c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
        const normal = b.clone().sub(a).cross(c.clone().sub(a));
        const center = a
          .clone()
          .add(b)
          .add(c)
          .multiplyScalar(1 / 3);
        const xz = [center.x + group.position.x, center.z + group.position.z];
        if (
          !normal.lengthSq() ||
          normal.y / normal.length() < 0.7 ||
          center.y >= -0.12 ||
          center.y <= -3.3 ||
          !pointInLocationPolygon(xz, cell)
        )
          continue;
        assert.ok(
          cuts.some((cut) =>
            pointInLocationPolygon(xz, { points: cut.points }),
          ),
          `${id}: descending tread remains covered at ${xz}`,
        );
        tested++;
      }
      assert.ok(
        tested > 10,
        `${id}: test actual observed treads, not only declared metadata`,
      );
      const display = withStairDisplayCutouts(cell, cuts);
      assert.ok(display.holes.length > 0);
      assert.equal(JSON.stringify(item.floor), before);
    } finally {
      dispose(group);
    }
  }
});

test("overlapping new display openings merge with existing source holes without mutating the source polygon", () => {
  const polygon = {
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    holes: [
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ],
    ],
  };
  const before = JSON.stringify(polygon);
  const display = withStairDisplayCutouts(polygon, [
    {
      points: [
        [3, 3],
        [6, 3],
        [6, 6],
        [3, 6],
      ],
    },
  ]);
  assert.equal(display.holes.length, 1);
  assert.ok(pointInLocationPolygon([2.5, 2.5], { points: display.holes[0] }));
  assert.ok(pointInLocationPolygon([5, 5], { points: display.holes[0] }));
  assert.equal(JSON.stringify(polygon), before);
});
