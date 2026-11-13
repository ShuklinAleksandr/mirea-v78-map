import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { firstFloorStairSchematics as refs } from "../src/data/first-floor-stair-schematics.js";
import { firstFloorSchematicLayoutsForFloor } from "../src/map/first-floor-stair-schematics.js";
import {
  getMapStairMarkers,
  stairLayoutFor,
  createStaircase,
  presentStairIdentity,
  withConfirmedStairSearch,
} from "../src/map/stairs.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import { AtlasScene } from "../src/map/scene.js";
import { stairEndpointCandidates } from "../src/data/stair-routing.js";
import { placeLocation } from "../src/data/place-location.js";
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const floors = [0, 1].map((n) =>
  read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
);
const floorOf = (ref) => floors.find((f) => f.id === ref.floorId);
const markerOf = (ref, floor = floorOf(ref)) =>
  getMapStairMarkers(floor).find((m) => m.layoutId === ref.layoutId);
const dispose = (g) =>
  g.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });

test("eleven explicitly authorized first-floor depictions retain source cells and honest unverified shape status", () => {
  assert.equal(refs.length, 11);
  for (const ref of refs) {
    const f = floorOf(ref),
      before = JSON.stringify(f),
      marker = markerOf(ref),
      l = stairLayoutFor(marker, f);
    assert.ok(l, ref.layoutId);
    assert.equal(l.shapeReviewStatus, "user-authorized-schematic");
    assert.equal(l.geometryStatus, "user-authorized-schematic");
    assert.deepEqual(l.shapeSourcePhotoIds, []);
    assert.match(l.note, /форма.*не проверена|форма показана условно/);
    assert.equal(
      l.displayCutout,
      undefined,
      "conditional model adds no floor hole",
    );
    assert.equal(
      placeLocation(marker, f).physicalLevel,
      1,
      `${ref.building} must not become raw plan 0`,
    );
    assert.equal(placeLocation(marker, f).building, ref.building);
    assert.deepEqual(
      marker.sourceIds,
      ref.portals.map((p) => p.sourceEdgeId),
    );
    assert.equal(marker.targets.length, ref.portals.length);
    assert.equal(JSON.stringify(f), before);
  }
});

test("all real mesh vertices stay in their own cells and local frames; large halls get bounded local modules", () => {
  for (const ref of refs) {
    const f = floorOf(ref),
      m = markerOf(ref),
      l = stairLayoutFor(m, f),
      g = createStaircase(m, f);
    g.updateMatrixWorld(true);
    try {
      assert.equal(g.userData.geometryStatus, "user-authorized-schematic");
      assert.match(g.name, /условная модель/);
      assert.ok(
        new THREE.Box3().setFromObject(g).max.y > 1,
        "a real volumetric flight, not only a marker",
      );
      assert.ok(
        l.frame.size[0] <= 4.51 && l.frame.size[1] <= 6.51,
        "never stretch across the whole D/E hall",
      );
      const v = new THREE.Vector3();
      g.traverse((o) => {
        if (!o.geometry) return;
        const a = o.geometry.attributes.position;
        for (let i = 0; i < a.count; i++) {
          v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
          assert.ok([v.x, v.y, v.z].every(Number.isFinite));
          assert.equal(
            polygonClipping.difference(
              [
                [
                  [v.x - 1e-5, v.z - 1e-5],
                  [v.x + 1e-5, v.z - 1e-5],
                  [v.x, v.z + 1e-5],
                ],
              ],
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
});

test("every new first-floor model survives actual scoped and unscoped scene batching in 2D and 3D", () => {
  for (const ref of refs)
    for (const scoped of [false, true])
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
              mesh.userData.faceRooms.some((room) => room.id === m.id),
            ),
            `${ref.layoutId} ${scoped} ${plan}`,
          );
        } finally {
          dispose(view.model);
        }
      }
});

test("named E stair polygons open stair cards without inventing targets or duplicate search rows", () => {
  const source = read("../public/data/search-index.json"),
    shown = withConfirmedStairSearch(source, floors);
  for (const ref of refs.filter(
    (r) => r.building === "Е" && !r.portals.length,
  )) {
    const f = floorOf(ref),
      p = f.polygons.find((p) => p.id === ref.sourceArea.id),
      m = presentStairIdentity(p, f);
    assert.equal(m.kind, "stairs");
    assert.equal(m.building, "Е");
    assert.equal(m.sourceLabel, p.label);
    assert.deepEqual(m.targets, []);
    assert.equal(
      shown.filter(
        (p) =>
          p.id === ref.sourceArea.id || p.id === `photo-stair:${ref.layoutId}`,
      ).length,
      1,
    );
  }
});

test("new route aliases retain exact original portals, while unconnected E/G depictions remain unconnected", () => {
  const g = read("../public/data/routing/v-78.json"),
    before = JSON.stringify(g);
  for (const ref of refs)
    for (const endpoint of [markerOf(ref), `photo-stair:${ref.layoutId}`]) {
      const candidates = stairEndpointCandidates(g, endpoint);
      assert.equal(candidates.length, ref.portals.length);
      for (const c of candidates) {
        const n = g.nodes.find((n) => n.id === c.nodeId);
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
  assert.equal(JSON.stringify(g), before);
});

test("changed contours and portal targets fail closed without applying old conditional geometry", () => {
  for (const ref of refs) {
    const f = structuredClone(floorOf(ref));
    f.polygons.find((p) => p.id === ref.sourceArea.id).points[0][0] += 0.1;
    assert.ok(
      !firstFloorSchematicLayoutsForFloor(f).some((l) => l.id === ref.layoutId),
    );
    if (ref.portals.length) {
      const changed = structuredClone(floorOf(ref));
      changed.transitions.find(
        (t) => t.id === ref.portals[0].sourceEdgeId,
      ).targetPosition[0] += 0.1;
      assert.ok(
        !firstFloorSchematicLayoutsForFloor(changed).some(
          (l) => l.id === ref.layoutId,
        ),
      );
    }
  }
});
