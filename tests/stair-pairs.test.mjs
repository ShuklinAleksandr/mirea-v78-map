import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { AtlasScene } from "../src/map/scene.js";
import {
  getMapStairMarkers,
  stairLayoutFor,
  resolveStairTarget,
  createStaircase,
} from "../src/map/stairs.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import { photoCounterpartStairLayoutsForFloor } from "../src/map/stair-counterparts.js";
import { photographedStairCounterparts } from "../src/data/stair-counterparts.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const floors = [0, 1, 2, 3, 4].map((n) =>
  read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
);
const byId = new Map(floors.map((f) => [f.id, f]));
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.001;
const dispose = (group) =>
  group.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) m.dispose();
  });

test("all 94 source stair records retain a selectable marker, target and correct counterpart on every plan", () => {
  let audited = 0;
  for (const floor of floors) {
    const before = JSON.stringify(floor),
      markers = getMapStairMarkers(floor);
    for (const source of floor.transitions.filter((t) => t.kind === "stairs")) {
      const hits = markers.filter(
        (m) =>
          m.sourceIds.includes(source.id) &&
          [m.position, ...(m.graphAnchors || []).map((a) => a.position)].some(
            (p) => near(p, source.position),
          ),
      );
      assert.equal(hits.length, 1, `${floor.id} ${source.id}`);
      assert.ok(
        stairLayoutFor(hits[0], floor),
        "every known source endpoint has a bounded volumetric depiction",
      );
      const marker = hits[0],
        target = marker.targets.find(
          (t) =>
            t.floorId === source.targetFloorId &&
            near(t.center, source.targetPosition),
        );
      assert.ok(target, `${source.id} retains its exact target`);
      const destination = byId.get(target.floorId);
      const counterpart = resolveStairTarget(
        marker,
        floor,
        destination,
        target,
      );
      assert.ok(
        counterpart,
        `${floor.id} ${source.id} resolves its other endpoint`,
      );
      assert.ok(
        counterpart.sourceIds.includes(source.id),
        `${source.id} cannot select another nearby stair`,
      );
      assert.ok(
        counterpart.targets.some(
          (t) => t.floorId === floor.id && near(t.center, source.position),
        ),
      );
      audited++;
    }
    assert.equal(JSON.stringify(floor), before, "source plan is immutable");
  }
  assert.equal(audited, 94);
});

test("the actual scene batching retains every stair depiction and pickability in 2D/3D", () => {
  let sourceOnlyGlyphs = 0;
  for (const floor of floors)
    for (const plan of [false, true]) {
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
        for (const marker of getMapStairMarkers(floor).filter(
          (m) => m.kind === "stairs",
        )) {
          const owned = view.pickables.filter((mesh) =>
            mesh.userData.faceRooms.some((m) => m.id === marker.id),
          );
          assert.ok(
            owned.length,
            `${floor.id} ${marker.id} remains selectable in ${plan ? "2D" : "3D"}`,
          );
          if (!plan && !stairLayoutFor(marker, floor)) {
            assert.ok(
              owned.some((mesh) => mesh.material.color.getHex() === 0xf2f7ef),
              "white arrows must survive the Mesh-only batch, not disappear as LineSegments",
            );
            assert.ok(
              owned.some((mesh) => mesh.material.color.getHex() === 0x5475a5),
              "contrast marker background retained",
            );
            sourceOnlyGlyphs++;
          }
        }
      } finally {
        dispose(view.model);
      }
    }
  assert.equal(
    sourceOnlyGlyphs,
    0,
    "all 94 known source endpoints have volumetric depictions, including conditional shapes",
  );
  assert.deepEqual(
    floors.flatMap((f) =>
      getMapStairMarkers(f).filter((m) => !stairLayoutFor(m, f)),
    ),
    [],
  );
});

test("unknown stair symbols stay flat and have finite mesh-only geometry", () => {
  const fallbackFloor = structuredClone(floors[4]);
  fallbackFloor.polygons.find(
    (p) => p.id === "v-78-floor4-area-51",
  ).points[0][0] += 0.1;
  const marker = getMapStairMarkers(fallbackFloor).find(
    (m) => m.kind === "stairs" && !stairLayoutFor(m, fallbackFloor),
  );
  assert.ok(marker, "stale geometry must still fail closed to a source symbol");
  const group = createStaircase(marker, fallbackFloor);
  try {
    assert.equal(group.userData.geometryStatus, "source-marker-only");
    assert.equal(group.userData.visualStepCounts, undefined);
    assert.ok(
      group.children.every((o) => o.isMesh),
      "renderer supports every symbol part",
    );
    const bounds = new THREE.Box3().setFromObject(group);
    assert.ok(bounds.max.y - bounds.min.y < 0.03, "no invented rise or shaft");
    assert.ok(
      bounds.max.x - bounds.min.x > 1.8,
      "symbol remains recognizable on a floor overview",
    );
    group.traverse((o) => {
      if (o.geometry)
        assert.ok(
          [...o.geometry.attributes.position.array].every(Number.isFinite),
        );
    });
  } finally {
    dispose(group);
  }
});

test("A1 LK8/LK9 use their own IMG3219 cells, retain portals, and fit without cutting neighbouring rooms", () => {
  const floor = floors[1],
    before = JSON.stringify(floor);
  const layouts = photoCounterpartStairLayoutsForFloor(floor).filter((layout) =>
    layout.sourcePhotoIds.includes("photo-3219"),
  );
  assert.equal(layouts.length, 2);
  const scoped = getBuildingFloorView(floor, "А");
  for (const layout of layouts) {
    const ref = photographedStairCounterparts.find(
      (r) => r.layoutId === layout.id,
    );
    const area = floor.polygons.find((p) => p.id === layout.fitAreaId);
    assert.deepEqual(layout.sourcePhotoIds, ["photo-3219"]);
    assert.deepEqual(layout.center, ref.position);
    assert.equal(layout.physicalFloor, 1);
    assert.equal(layout.levelRole, "lower-departure");
    assert.equal(
      layout.pairedLayoutId,
      undefined,
      "source plans are not claimed to be geometrically registered",
    );
    assert.equal(layout.displayCutout, undefined, "no new floor hole");
    const world = ([u, v]) =>
      layout.frame.origin.map(
        (n, i) =>
          n +
          u * layout.frame.axisU[i] * layout.frame.size[0] +
          v * layout.frame.axisV[i] * layout.frame.size[1],
      );
    assert.equal(
      polygonClipping.difference([layout.footprint.map(world)], [area.points])
        .length,
      0,
    );
    const marker = getMapStairMarkers(scoped).find(
      (m) => m.layoutId === layout.id,
    );
    assert.ok(marker, "building filter retains the original cell and stair");
    assert.deepEqual(marker.sourceIds, [ref.sourceEdgeId]);
    assert.equal(marker.targets.length, 1);
    assert.deepEqual(marker.targets[0].center, ref.targetPosition);
    const group = createStaircase(marker, scoped);
    try {
      assert.ok(new THREE.Box3().setFromObject(group).max.y > 3.5);
      assert.equal(
        group.userData.geometryStatus,
        "photo-plan-layout-approximate-vertical",
      );
      assert.ok(group.userData.visualStepCounts.length > 0);
    } finally {
      dispose(group);
    }
  }
  assert.equal(JSON.stringify(floor), before);
});

test("changed counterpart evidence fails closed to a source symbol without deleting the transition", () => {
  for (const mutate of [
    (f) => {
      f.polygons.find(
        (p) => p.id === photographedStairCounterparts[0].sourceAreaId,
      ).points[0][0] += 0.02;
    },
    (f) => {
      f.transitions.find(
        (t) => t.id === photographedStairCounterparts[0].sourceEdgeId,
      ).targetPosition[0] += 0.02;
    },
    (f) => {
      f.markers.find(
        (t) => t.id === photographedStairCounterparts[0].sourceEdgeId,
      ).sourceId = "other";
    },
  ]) {
    const floor = structuredClone(floors[1]);
    mutate(floor);
    assert.equal(
      photoCounterpartStairLayoutsForFloor(floor).some(
        (l) => l.id === photographedStairCounterparts[0].layoutId,
      ),
      false,
    );
    assert.ok(
      getMapStairMarkers(floor).some((m) =>
        m.sourceIds.includes(photographedStairCounterparts[0].sourceEdgeId),
      ),
    );
  }
  assert.deepEqual(
    photoCounterpartStairLayoutsForFloor({ ...floors[1], campusId: "v-86" }),
    [],
  );
});

test("the actual new stair card endpoints build in both directions on original graph edges", () => {
  const graph = read("../public/data/routing/v-78.json"),
    before = JSON.stringify(graph);
  const originalEdges = new Map(graph.edges.map((e) => [e.id, e]));
  const destination = "v-78--floor-3--cvi";
  for (const reference of photographedStairCounterparts) {
    const card = getMapStairMarkers(floors[1]).find(
      (m) => m.layoutId === reference.layoutId,
    );
    for (const [from, to] of [
      [card, destination],
      [destination, card.id],
    ]) {
      const route = findNavigationRoute(graph, from, to);
      assert.equal(route.ok, true, `${reference.label}: ${route.message}`);
      assert.ok(
        near(
          (from === card ? route.start : route.end).point,
          reference.position,
        ),
      );
      assert.ok(
        (from === card ? route.start : route.end).label.includes(
          reference.label,
        ),
      );
      assert.deepEqual(route.diagnostics.localConnectorIds, []);
      route.edges.forEach((e) => assert.deepEqual(e, originalEdges.get(e.id)));
    }
  }
  assert.equal(JSON.stringify(graph), before);
});
