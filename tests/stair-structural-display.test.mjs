import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { pointInLocationPolygon } from "../src/location.js";
import {
  createStaircase,
  getMapStairMarkers,
  getStairDisplayCutouts,
  stairLayoutFor,
} from "../src/map/stairs.js";
import { stairScanMetadata } from "../src/map/stair-model-bindings.js";

const fixtures = [
  [2, "v-78-floor2-photo-stair-wide-hall"],
  [3, "v-78-floor3-photo-stair-wide-hall"],
  [1, "v-78-floor1-photo-stair-A154"],
  [2, "v-78-floor2-photo-stair-A154-arrival"],
  [1, "v-78-floor1-user-stair-basement"],
  [2, "v78-Г-2-ЛК2"],
  [3, "v78-Г-3-ЛК2"],
  [2, "v78-В-2-ЛК2"],
  [2, "v78-Д-scan-v-78-floor2"],
  [3, "v78-Д-scan-v-78-floor3"],
];
function fixture(level, id) {
  const floor = JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
    ),
  );
  const marker = getMapStairMarkers(floor).find((item) => item.layoutId === id);
  assert.ok(marker, id);
  return { floor, marker, layout: stairLayoutFor(marker, floor) };
}
function dispose(group) {
  group.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });
}
const world = (layout, [u, v]) => [
  layout.frame.origin[0] +
    layout.frame.axisU[0] * u * layout.frame.size[0] +
    layout.frame.axisV[0] * v * layout.frame.size[1],
  layout.frame.origin[1] +
    layout.frame.axisU[1] * u * layout.frame.size[0] +
    layout.frame.axisV[1] * v * layout.frame.size[1],
];

test("clean default keeps compact scan provenance, source topology and independent GPU resources", () => {
  for (const [id, metadata] of Object.entries(stairScanMetadata)) {
    const asset = JSON.parse(
      readFileSync(
        new URL(`../src/data/stair-scan-meshes/${id}.json`, import.meta.url),
      ),
    );
    assert.equal(metadata.sourceSha256, asset.sourceSha256);
    assert.deepEqual(metadata.floorRange, asset.floorRange);
  }
  for (const args of fixtures) {
    const { floor, marker, layout } = fixture(...args);
    const before = JSON.stringify([floor, layout]);
    const a = createStaircase(marker, floor),
      b = createStaircase(marker, floor);
    try {
      assert.equal(
        a.userData.scanVisual,
        undefined,
        "incomplete triangle scan is diagnostic-only",
      );
      assert.equal(a.userData.scanReference.observedMeshPreserved, true);
      assert.equal(
        a.userData.visualDimensionStatus,
        "model-approximation-not-measured",
      );
      assert.ok(a.userData.visualStepCounts.length > 0);
      assert.notEqual(a.children[0].geometry, b.children[0].geometry);
      assert.notEqual(a.children[0].material, b.children[0].material);
      const triangles = a.children.reduce(
        (sum, object) => sum + object.geometry.attributes.position.count / 3,
        0,
      );
      assert.ok(
        triangles < 4500,
        `${layout.id}: ${triangles} bounded triangles, no scan debris`,
      );
      assert.equal(JSON.stringify([floor, layout]), before);
    } finally {
      dispose(a);
      dispose(b);
    }
  }
});

test("every clean flight is a closed solid with uninterrupted flat treads, including descending mirrored branches", () => {
  for (const args of fixtures) {
    const { floor, marker, layout } = fixture(...args);
    const group = createStaircase(marker, floor);
    try {
      group.updateMatrixWorld(true);
      const structure = group.children.find((mesh) =>
        mesh.name.endsWith(" · structure"),
      );
      assert.ok(structure);
      const positions = structure.geometry.attributes.position;
      const edges = new Map();
      for (let i = 0; i < positions.count; i += 3) {
        const vertices = [0, 1, 2].map((offset) =>
          new THREE.Vector3().fromBufferAttribute(positions, i + offset),
        );
        assert.ok(
          vertices[1]
            .clone()
            .sub(vertices[0])
            .cross(vertices[2].clone().sub(vertices[0]))
            .lengthSq() > 1e-12,
          "no degenerate debris faces",
        );
        const keys = vertices.map((vertex) =>
          vertex
            .toArray()
            .map((value) => Math.round(value * 10000))
            .join(","),
        );
        for (let edge = 0; edge < 3; edge++) {
          const key = [keys[edge], keys[(edge + 1) % 3]].sort().join("|");
          edges.set(key, (edges.get(key) || 0) + 1);
        }
      }
      assert.ok(
        [...edges.values()].every((count) => count === 2),
        `${layout.id}: all solid edges closed`,
      );
      const flights = layout.incomingDisplay
        ? [
            ...layout.flights.filter(
              (flight) => Math.abs(flight.baseFraction) < 1e-6,
            ),
            ...layout.incomingDisplay.flights.filter(
              (flight) => Math.abs(flight.topFraction) < 1e-6,
            ),
          ]
        : layout.flights;
      assert.equal(group.userData.visualStepCounts.length, flights.length);
      for (const [index, flight] of flights.entries()) {
        const lowerFirst = flight.baseFraction < flight.topFraction;
        const a = world(layout, lowerFirst ? flight.from : flight.to),
          b = world(layout, lowerFirst ? flight.to : flight.from);
        const dx = b[0] - a[0],
          dz = b[1] - a[1],
          run = Math.hypot(dx, dz);
        const alongU =
          Math.abs(flight.to[0] - flight.from[0]) >
          Math.abs(flight.to[1] - flight.from[1]);
        const width =
          flight.width ??
          flight.widthFraction * layout.frame.size[alongU ? 1 : 0];
        const count = group.userData.visualStepCounts[index];
        for (let step = 0; step < count; step++) {
          const expectedY =
            0.14 +
            3.6 *
              (Math.min(flight.baseFraction, flight.topFraction) +
                ((step + 1) / count) *
                  Math.abs(flight.topFraction - flight.baseFraction));
          for (const across of [-0.4, 0, 0.4]) {
            const t = (step + 0.55) / count;
            const x = a[0] + dx * t - (dz / run) * width * across;
            const z = a[1] + dz * t + (dx / run) * width * across;
            const ray = new THREE.Raycaster(
              new THREE.Vector3(x, expectedY + 0.1, z),
              new THREE.Vector3(0, -1, 0),
              0,
              0.2,
            );
            const hit = ray.intersectObject(structure)[0];
            assert.ok(
              hit,
              `${layout.id}: solid tread ${index}/${step}/${across}`,
            );
            assert.ok(
              Math.abs(hit.point.y - expectedY) < 1e-5,
              "tread stays horizontal, no ramp or pinhole",
            );
          }
        }
      }
    } finally {
      dispose(group);
    }
  }
});

test("profile cutouts expose the actual descent but retain main landings and the standard cell well", () => {
  for (const args of fixtures) {
    const { floor, marker, layout } = fixture(...args);
    const cuts = getStairDisplayCutouts(floor).filter(
      (cut) =>
        cut.layoutId === layout.id || cut.layoutId === `${layout.id}:incoming`,
    );
    if (!cuts.length) continue;
    const group = createStaircase(marker, floor);
    try {
      const cell =
        floor.polygons.find((area) => area.id === layout.fitAreaId) ||
        floor.polygons.find((area) => area.id === layout.containerAreaId);
      for (const cut of cuts) {
        assert.equal(
          polygonClipping.difference(
            [cut.points],
            [cell.points, ...(cell.holes || [])],
          ).length,
          0,
          "no adjacent room is cut",
        );
        assert.match(cut.geometryEvidence, /accepted-descending-flight/);
      }
      const contains = (p) =>
        cuts.some((cut) => pointInLocationPolygon(p, { points: cut.points }));
      if (group.userData.scanReference.assetId === "standard-cell") {
        assert.equal(
          contains(world(layout, [0.5, 0.45])),
          true,
          "observed central well stays open",
        );
        assert.equal(
          contains(world(layout, [0.5, 0.85])),
          false,
          "front entrance landing stays intact",
        );
      } else {
        const center =
          group.userData.scanReference.assetId === "grand-upper"
            ? [0.5, 0.5]
            : [0.5, 0.75];
        assert.equal(
          contains(world(layout, center)),
          false,
          "central arrival/departure must not become a black gap",
        );
      }
      let checked = 0;
      for (const mesh of group.children.filter((object) =>
        / · (structure|landing)$/.test(object.name),
      )) {
        const p = mesh.geometry.attributes.position;
        for (let i = 0; i < p.count; i += 3) {
          const a = new THREE.Vector3().fromBufferAttribute(p, i),
            b = new THREE.Vector3().fromBufferAttribute(p, i + 1),
            c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
          const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
          const center = a
            .add(b)
            .add(c)
            .multiplyScalar(1 / 3);
          const xz = [center.x + group.position.x, center.z + group.position.z];
          if (
            normal.y < 0.99 ||
            center.y >= -0.05 ||
            !pointInLocationPolygon(xz, cell)
          )
            continue;
          assert.ok(
            contains(xz),
            `${layout.id}: no floor covers descending tread/landing ${xz}`,
          );
          checked++;
        }
      }
      assert.ok(checked > 10, "verify actual descending surfaces");
    } finally {
      dispose(group);
    }
  }
});
