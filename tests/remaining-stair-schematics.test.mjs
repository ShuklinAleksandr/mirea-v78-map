import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import pc from "polygon-clipping";
import { remainingStairSchematics as refs } from "../src/data/remaining-stair-schematics.js";
import {
  getMapStairMarkers,
  stairLayoutFor,
  createStaircase,
  getStairDisplayCutouts,
  withStairDisplayCutouts,
} from "../src/map/stairs.js";
import { remainingStairSchematicLayoutsForFloor } from "../src/map/first-floor-stair-schematics.js";
import { stairEndpointCandidates } from "../src/data/stair-routing.js";
import { placeLocation } from "../src/data/place-location.js";
import { AtlasScene } from "../src/map/scene.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const floors = [0, 1, 2, 3, 4].map((n) =>
  read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
);
const floorOf = (r) => floors.find((f) => f.id === r.floorId);
const markerOf = (r, f = floorOf(r)) =>
  getMapStairMarkers(f).find((m) => m.layoutId === r.layoutId);
const dispose = (g) =>
  g.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });
const ring = (x, y, X, Y) => [
  [x, y],
  [X, y],
  [X, Y],
  [x, Y],
];

test("eight final source endpoints have short conditional depictions and unknown physical levels remain unknown", () => {
  assert.equal(refs.length, 8);
  for (const ref of refs) {
    const f = floorOf(ref),
      before = JSON.stringify(f),
      m = markerOf(ref),
      l = stairLayoutFor(m, f);
    assert.ok(l, ref.layoutId);
    assert.equal(l.geometryStatus, "user-authorized-schematic");
    assert.equal(m.source, "source-navigation-graph");
    assert.equal(m.confidence, "source-graph");
    assert.deepEqual(l.frame.size, [1.4, 2.4]);
    assert.equal(placeLocation(m, f).physicalLevel, ref.physicalFloor);
    assert.deepEqual(m.position, ref.portals[0].position);
    assert.deepEqual(m.sourceIds, [ref.portals[0].sourceEdgeId]);
    assert.deepEqual(
      m.targets.map((t) => [t.floorId, t.center]),
      ref.portals.map((p) => [p.targetFloorId, p.targetPosition]),
    );
    assert.match(l.note, /условн/);
    assert.equal(JSON.stringify(f), before);
  }
  const samePlan = refs.find(
    (r) => r.layoutId === "v78-source-floor1-schematic-20726",
  );
  assert.equal(samePlan.physicalFloor, null);
  assert.equal(samePlan.building, null);
  assert.equal(samePlan.portals[0].floorId, samePlan.portals[0].targetFloorId);
  const conditional = floors
    .flatMap((f) => getMapStairMarkers(f))
    .filter((m) => m.shapeReviewStatus === "user-authorized-schematic");
  assert.equal(
    conditional.length,
    20,
    "12 first-floor models plus these 8, separately from user-confirmed I topology",
  );
});

test("all actual mesh vertices stay in local source cells and upper fragments descend without adding another storey", () => {
  for (const ref of refs) {
    const f = floorOf(ref),
      m = markerOf(ref),
      l = stairLayoutFor(m, f),
      g = createStaircase(m, f);
    g.updateMatrixWorld(true);
    try {
      const box = new THREE.Box3().setFromObject(g);
      assert.ok(box.max.y - box.min.y > 1, "real volume");
      assert.equal(g.userData.geometryStatus, "user-authorized-schematic");
      assert.match(g.userData.note, /условн/);
      if (ref.levelRole === "upper-arrival") {
        assert.ok(box.min.y < -1);
        assert.ok(box.max.y < 1.1, "upper floor has no extra ascent");
        assert.ok(l.flights.every((f) => f.topFraction <= 0));
      } else assert.ok(box.max.y > 1);
      const v = new THREE.Vector3();
      g.traverse((o) => {
        if (!o.geometry) return;
        const p = o.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
          assert.ok([v.x, v.y, v.z].every(Number.isFinite));
          assert.equal(
            pc.difference(
              [ring(v.x - 1e-5, v.z - 1e-5, v.x + 1e-5, v.z + 1e-5)],
              [ref.sourceArea.points],
            ).length,
            0,
            ref.layoutId,
          );
        }
      });
    } finally {
      dispose(g);
    }
  }
  const sports = refs.filter((r) => r.sourceArea.id === "v-78-floor0-area-40");
  const world = (r) =>
    ring(0, 0, 1, 1).map(([u, v]) =>
      r.frame.origin.map(
        (n, i) => n + u * r.frame.axisU[i] * 1.4 + v * r.frame.axisV[i] * 2.4,
      ),
    );
  assert.equal(
    pc.intersection([world(sports[0])], [world(sports[1])]).length,
    0,
    "separate sports points do not overlap or fill the gym",
  );
});

test("five downward depictions have only bounded local display openings in the original cell and slab", () => {
  assert.equal(refs.filter((r) => r.levelRole === "upper-arrival").length, 5);
  for (const ref of refs) {
    const f = floorOf(ref),
      before = JSON.stringify(f),
      cutouts = getStairDisplayCutouts(f).filter(
        (c) => c.layoutId === ref.layoutId,
      );
    assert.equal(cutouts.length, ref.levelRole === "upper-arrival" ? 1 : 0);
    for (const c of cutouts) {
      assert.equal(
        pc.difference([c.points], [ref.sourceArea.points]).length,
        0,
      );
      const area = f.polygons.find((p) => p.id === ref.sourceArea.id);
      assert.equal(withStairDisplayCutouts(area, [c]).holes.length, 1);
      assert.ok(
        f.footprints.some((p) => withStairDisplayCutouts(p, [c]) !== p),
        "underlying slab does not conceal the fragment",
      );
      const xs = c.points.map((p) => p[0]),
        zs = c.points.map((p) => p[1]);
      assert.ok(Math.max(...xs) - Math.min(...xs) < 3);
      assert.ok(Math.max(...zs) - Math.min(...zs) < 3);
    }
    assert.equal(JSON.stringify(f), before);
  }
});

test("new aliases retain exact portals including two same-edge endpoints on one plan; no graph mutation", () => {
  const graph = read("../public/data/routing/v-78.json"),
    before = JSON.stringify(graph);
  for (const ref of refs)
    for (const endpoint of [markerOf(ref), `photo-stair:${ref.layoutId}`]) {
      const cs = stairEndpointCandidates(graph, endpoint);
      assert.equal(cs.length, 1, ref.layoutId);
      const node = graph.nodes.find((n) => n.id === cs[0].nodeId);
      assert.equal(node.floorId, ref.floorId);
      assert.ok(
        Math.hypot(
          ...node.position.map((v, i) => v - ref.portals[0].position[i]),
        ) < 0.001,
      );
    }
  assert.equal(JSON.stringify(graph), before);
});

test("every remaining model survives actual 2D/3D scene batching, scoped when the building is established", () => {
  for (const ref of refs)
    for (const scoped of ref.building ? [false, true] : [false])
      for (const plan of [false, true]) {
        const f = scoped
            ? getBuildingFloorView(floorOf(ref), ref.building)
            : floorOf(ref),
          m = markerOf(ref, f);
        assert.ok(m);
        const view = Object.assign(Object.create(AtlasScene.prototype), {
          model: new THREE.Group(),
          pickables: [],
          assumptions: { floorHeight: 3.6 },
          building: scoped ? ref.building : null,
          neighborsOn: false,
          stackDisplay: false,
          plan,
          callbacks: {},
          addLabel() {
            return {};
          },
        });
        view.addConnections(f);
        try {
          assert.ok(
            view.pickables.some((mesh) =>
              mesh.userData.faceRooms.some((x) => x.id === m.id),
            ),
            `${ref.layoutId} ${plan} ${scoped}`,
          );
        } finally {
          dispose(view.model);
        }
      }
});

test("a changed source cell or exact portal disables a conditional model and preserves the source fallback", () => {
  for (const ref of refs)
    for (const field of ["cell", "portal"]) {
      const f = structuredClone(floorOf(ref));
      if (field === "cell")
        f.polygons.find((p) => p.id === ref.sourceArea.id).points[0][0] += 0.02;
      else
        f.transitions.find(
          (t) =>
            t.id === ref.portals[0].sourceEdgeId &&
            t.sourceId === ref.portals[0].sourceTransitionId &&
            Math.hypot(
              ...t.position.map((v, i) => v - ref.portals[0].position[i]),
            ) < 0.001,
        ).targetPosition[0] += 0.02;
      assert.ok(
        !remainingStairSchematicLayoutsForFloor(f).some(
          (l) => l.id === ref.layoutId,
        ),
      );
    }
});
