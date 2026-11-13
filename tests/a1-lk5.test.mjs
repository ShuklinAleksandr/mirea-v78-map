import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { photographedStairCounterparts } from "../src/data/stair-counterparts.js";
import { photoCounterpartStairLayoutsForFloor } from "../src/map/stair-counterparts.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import {
  createStaircase,
  getMapStairMarkers,
  resolveStairTarget,
} from "../src/map/stairs.js";

const readFloor = (level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
    ),
  );
const floor = readFloor(1),
  upper = readFloor(2);
const reference = photographedStairCounterparts.find(
  (ref) => ref.sourceEdgeId === "v-78:edge:20727",
);
const layoutFor = (floor) =>
  photoCounterpartStairLayoutsForFloor(floor).find(
    (layout) => layout.id === reference.layoutId,
  );

test("A1 LK5 uses its IMG3220 cell and original portal, while the return flights remain explicitly schematic", () => {
  const before = JSON.stringify(floor);
  const scoped = getBuildingFloorView(floor, "А");
  for (const view of [floor, scoped]) {
    const layout = layoutFor(view);
    assert.ok(layout);
    assert.equal(layout.fitAreaId, "v-78-floor1-area-174");
    assert.deepEqual(layout.center, [-4.95, 2.8714]);
    assert.deepEqual(layout.sourcePhotoIds, ["photo-3220"]);
    assert.deepEqual(layout.sourcePhotos, ["/data/photos/IMG_3220.jpg"]);
    assert.equal(layout.shapeStatus, "user-authorized-schematic");
    assert.equal(layout.shapeReviewStatus, "user-authorized-schematic");
    assert.deepEqual(layout.shapeSourcePhotoIds, []);
    assert.match(layout.landmarkNote, /А-172/);
    assert.match(layout.geometryEvidence.description, /не подтверждённая/);
    assert.equal(layout.pairedLayoutId, undefined);
    assert.equal(layout.displayCutout, undefined);
    assert.equal(layout.levelRole, "lower-departure");

    const area = view.polygons.find((p) => p.id === layout.fitAreaId);
    const { frame } = layout;
    const world = ([u, v]) =>
      frame.origin.map(
        (value, i) =>
          value +
          frame.axisU[i] * frame.size[0] * u +
          frame.axisV[i] * frame.size[1] * v,
      );
    assert.deepEqual(
      polygonClipping.difference([layout.footprint.map(world)], [area.points]),
      [],
      "the model stays inside the independently guarded first-floor cell",
    );
    assert.equal(layout.flights.length, 2);
    assert.ok(
      layout.flights.every((flight) => flight.treadCount === null),
      "the photo does not supply a measured step count",
    );

    const marker = getMapStairMarkers(view).find(
      (m) => m.layoutId === reference.layoutId,
    );
    assert.ok(marker);
    assert.deepEqual(marker.sourceIds, [reference.sourceEdgeId]);
    assert.equal(marker.targets.length, 1);
    assert.deepEqual(marker.targets[0].center, reference.targetPosition);
    const counterpart = resolveStairTarget(
      marker,
      view,
      upper,
      marker.targets[0],
    );
    assert.ok(counterpart.sourceIds.includes(reference.sourceEdgeId));

    const group = createStaircase(marker, view);
    try {
      assert.equal(group.userData.geometryStatus, "user-authorized-schematic");
      assert.ok(new THREE.Box3().setFromObject(group).max.y > 3.5);
      assert.ok(group.userData.visualStepCounts.length > 0);
      group.updateMatrixWorld(true);
      group.traverse((mesh) => {
        if (!mesh.geometry) return;
        const vertices = mesh.geometry.attributes.position;
        assert.ok([...vertices.array].every(Number.isFinite));
        for (let i = 0; i < vertices.count; i++) {
          const point = new THREE.Vector3()
            .fromBufferAttribute(vertices, i)
            .applyMatrix4(mesh.matrixWorld);
          for (const [dimension, axis] of [
            frame.axisU,
            frame.axisV,
          ].entries()) {
            const value =
              ((point.x - frame.origin[0]) * axis[0] +
                (point.z - frame.origin[1]) * axis[1]) /
              frame.size[dimension];
            assert.ok(
              value >= -1e-5 && value <= 1 + 1e-5,
              "actual rendered flights and rails stay in the guarded footprint",
            );
          }
        }
      });
    } finally {
      group.traverse((object) => {
        object.geometry?.dispose();
        for (const material of [].concat(object.material || []))
          material.dispose();
      });
    }
  }
  assert.equal(JSON.stringify(floor), before);
});

test("LK5 source guards reject a changed cell or transition without removing source navigation", () => {
  const mutations = [
    (copy) => {
      copy.polygons.find((p) => p.id === reference.sourceAreaId).center[0] +=
        0.1;
    },
    (copy) => {
      copy.polygons.find((p) => p.id === reference.sourceAreaId).points[0][0] +=
        0.1;
    },
    (copy) => {
      copy.polygons
        .find((p) => p.id === reference.sourceAreaId)
        .holes.push([
          [-5, 3],
          [-4.8, 3],
          [-4.8, 3.2],
        ]);
    },
    (copy) => {
      copy.transitions.find((t) => t.id === reference.sourceEdgeId).sourceId =
        "changed-source-transition";
    },
    (copy) => {
      copy.markers.find(
        (t) => t.id === reference.sourceEdgeId,
      ).targetPosition[0] += 0.1;
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(floor);
    mutate(copy);
    assert.equal(layoutFor(copy), undefined);
    assert.ok(
      getMapStairMarkers(copy).some((m) =>
        m.sourceIds.includes(reference.sourceEdgeId),
      ),
      "the retained source transition is still represented",
    );
  }
});
