import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { iMainStairReferences } from "../src/data/i-main-stair.js";
import { iMainStairLayoutsForFloor } from "../src/map/i-main-stair.js";
import {
  getMapStairMarkers,
  stairLayoutFor,
  createStaircase,
  getStairDisplayCutouts,
  resolveStairTarget,
} from "../src/map/stairs.js";
import { stairEndpointCandidates } from "../src/data/stair-routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import { AtlasScene } from "../src/map/scene.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const floors = [1, 2, 3].map((n) =>
  read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
);
const markerOf = (floor) =>
  getMapStairMarkers(floor).find(
    (m) =>
      m.layoutId ===
      iMainStairReferences.find((r) => r.floorId === floor.id).layoutId,
  );
const dispose = (g) =>
  g.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });
const world = (layout, [u, v]) =>
  layout.frame.origin.map(
    (n, i) =>
      n +
      layout.frame.axisU[i] * u * layout.frame.size[0] +
      layout.frame.axisV[i] * v * layout.frame.size[1],
  );

test("the one confirmed I main stair owns the existing I1-I2-I3 portals with four flights, two side landings and a common central landing", () => {
  for (const [i, floor] of floors.entries()) {
    const before = JSON.stringify(floor),
      marker = markerOf(floor),
      layout = stairLayoutFor(marker, floor);
    assert.ok(marker);
    assert.equal(
      layout.geometryEvidence,
      "user-confirmed-I-main-stair-2026-11-12",
    );
    assert.equal(marker.building, "И");
    assert.equal(layout.physicalFloor, i + 1);
    assert.equal(layout.flights.length, 4);
    assert.deepEqual(
      layout.sourcePhotoIds,
      [],
      "not presented as a photographed plan",
    );
    assert.equal(
      layout.landings.filter((l) => l.role === "intermediate").length,
      2,
    );
    const arrival = layout.landings.find((l) => l.role === "central-arrival");
    assert.deepEqual(arrival.points[0], [0.4, 0.59]);
    assert.deepEqual(arrival.points[2], [0.6, 0.91]);
    assert.deepEqual(
      marker.targets.map((t) => t.floorId).sort(),
      i === 0
        ? [floors[1].id]
        : i === 1
          ? [floors[0].id, floors[2].id]
          : [floors[1].id],
    );
    for (const target of marker.targets) {
      const opposite = resolveStairTarget(
        marker,
        floor,
        floors.find((f) => f.id === target.floorId),
        target,
      );
      assert.ok(opposite.layoutId.startsWith("v78-И-"));
      assert.ok(opposite.targets.some((t) => t.floorId === floor.id));
    }
    assert.equal(
      getMapStairMarkers(getBuildingFloorView(floor, "И")).filter(
        (m) => m.layoutId === layout.id,
      ).length,
      1,
    );
    assert.equal(JSON.stringify(floor), before);
  }
});

test("I1 rises, I2 has visible up and down flights, I3 only arrives from below; all actual mesh vertices fit their own native cells", () => {
  for (const [i, floor] of floors.entries()) {
    const marker = markerOf(floor),
      layout = stairLayoutFor(marker, floor);
    const area = floor.polygons.find((p) => p.id === layout.fitAreaId);
    const group = createStaircase(marker, floor);
    try {
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      assert.ok(
        i === 0 ? bounds.min.y > -0.4 && bounds.max.y > 3 : bounds.min.y < -1.5,
      );
      if (i === 1) {
        assert.ok(bounds.max.y > 1.7);
        assert.equal(group.userData.middleFloorCutaway, true);
      }
      if (i === 2) {
        assert.ok(
          bounds.max.y < 1.5,
          "only handrails may rise above the top floor",
        );
        assert.ok(
          layout.flights.every(
            (f) => f.baseFraction <= 0 && f.topFraction <= 0,
          ),
        );
        assert.equal(marker.targets.length, 1);
      }
      const point = new THREE.Vector3();
      group.traverse((mesh) => {
        if (!mesh.geometry) return;
        const attr = mesh.geometry.attributes.position;
        for (let j = 0; j < attr.count; j++) {
          point.fromBufferAttribute(attr, j).applyMatrix4(mesh.matrixWorld);
          assert.ok([point.x, point.y, point.z].every(Number.isFinite));
          // A tiny triangle around the sample makes containment robust at roundoff boundaries.
          const tiny = [
            [point.x - 1e-5, point.z - 1e-5],
            [point.x + 1e-5, point.z - 1e-5],
            [point.x, point.z + 1e-5],
          ];
          assert.equal(
            polygonClipping.difference([tiny], [area.points]).length,
            0,
            `${floor.id}: mesh escaped its source cell`,
          );
        }
      });
    } finally {
      dispose(group);
    }
  }
});

test("I cutaways stay in the known stair cell and preserve the shared central floor platform", () => {
  for (const [i, floor] of floors.entries()) {
    const layout = stairLayoutFor(markerOf(floor), floor);
    const cuts = getStairDisplayCutouts(floor).filter((c) =>
      c.layoutId.startsWith(layout.id),
    );
    assert.equal(cuts.length, i === 0 ? 0 : 2);
    const area = floor.polygons.find((p) => p.id === layout.fitAreaId);
    const central = [
      [0.42, 0.08],
      [0.58, 0.08],
      [0.58, 0.92],
      [0.42, 0.92],
    ].map((p) => world(layout, p));
    for (const cut of cuts) {
      assert.equal(
        polygonClipping.difference([cut.points], [area.points]).length,
        0,
      );
      assert.equal(
        polygonClipping.intersection([cut.points], [central]).length,
        0,
      );
    }
  }
});

test("I stair remains selectable in real 2D/3D scene batches with one combined middle-floor action candidate", () => {
  for (const floor of floors)
    for (const plan of [true, false]) {
      const marker = markerOf(floor);
      const view = Object.assign(Object.create(AtlasScene.prototype), {
        model: new THREE.Group(),
        pickables: [],
        assumptions: { floorHeight: 3.6 },
        building: null,
        neighborsOn: false,
        stackDisplay: false,
        plan,
        callbacks: {},
        addLabel() {
          return {};
        },
      });
      view.addConnections(floor);
      try {
        assert.ok(
          view.pickables.some((m) =>
            m.userData.faceRooms.some((r) => r.id === marker.id),
          ),
        );
        assert.equal(
          view.stairCandidates.filter((c) => c.marker.id === marker.id).length,
          1,
        );
      } finally {
        dispose(view.model);
      }
    }
});

test("I geometry fails closed on changed portal or native contour and never appears on another campus/floor", () => {
  for (const original of floors)
    for (const mutate of [
      (f) => {
        const ref = iMainStairReferences.find((r) => r.floorId === f.id);
        f.transitions.find(
          (t) => t.id === ref.portals[0].sourceEdgeId,
        ).targetPosition[0] += 1;
      },
      (f) => {
        const ref = iMainStairReferences.find((r) => r.floorId === f.id);
        f.polygons.find((p) => p.id === ref.sourceArea.id).points[0][0] += 1;
      },
      (f) => {
        f.campusId = "v-86";
      },
    ]) {
      const f = structuredClone(original);
      mutate(f);
      assert.deepEqual(iMainStairLayoutsForFloor(f), []);
    }
  for (const n of [0, 4])
    assert.deepEqual(
      iMainStairLayoutsForFloor(
        read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
      ),
      [],
    );
});

test("all three I cards resolve original portals, including both middle-floor endpoints, and route in both directions without connectors", () => {
  const graph = read("../public/data/routing/v-78.json"),
    before = JSON.stringify(graph);
  for (const [i, floor] of floors.entries()) {
    const card = markerOf(floor),
      ref = iMainStairReferences[i];
    for (const endpoint of [card, card.id]) {
      const candidates = stairEndpointCandidates(graph, endpoint);
      assert.equal(candidates.length, ref.portals.length);
      for (const c of candidates) {
        const n = graph.nodes.find((n) => n.id === c.nodeId);
        assert.ok(
          ref.portals.some(
            (p) =>
              Math.hypot(
                n.position[0] - p.position[0],
                n.position[1] - p.position[1],
              ) < 0.001,
          ),
        );
      }
    }
    for (const [from, to] of [
      [card, "v-78--floor-3--cvi"],
      ["v-78--floor-3--cvi", card.id],
    ]) {
      const route = findNavigationRoute(graph, from, to);
      assert.equal(route.ok, true, route.message);
      assert.deepEqual(route.diagnostics.localConnectorIds, []);
    }
  }
  assert.equal(JSON.stringify(graph), before);
  const changed = structuredClone(graph),
    ref = iMainStairReferences[1];
  changed.edges.find((e) => e.id === ref.portals[0].sourceEdgeId).sourceId =
    "different-source";
  assert.equal(
    stairEndpointCandidates(changed, `photo-stair:${ref.layoutId}`).length,
    1,
    "a mismatched source transition cannot remain an alias",
  );
});
