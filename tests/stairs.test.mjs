import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { getFloorMarkers } from "../src/data/utils.js";
import {
  createStaircase,
  getMapStairMarkers,
  getPhotoStairMarkers,
  getStairDisplayCutouts,
  getStairRoutePaths,
  resolveStairTarget,
  stairLayoutFor,
  withStairDisplayCutouts,
} from "../src/map/stairs.js";

const read = (path) =>
  JSON.parse(
    readFileSync(new URL(`../public/data/${path}`, import.meta.url), "utf8"),
  );
const registry = read("stair-layouts.json");
const manifest = read("manifest.json");
const floors = manifest.campuses.flatMap((campus) =>
  campus.floors.map((floor) => read(floor.url.replace("/data/", ""))),
);
const byId = new Map(floors.map((floor) => [floor.id, floor]));

test("main stair floor buttons select its paired arrival rather than the overlapping broad stair", () => {
  const lower = byId.get("v-78-floor1"),
    upper = byId.get("v-78-floor2");
  const ascent = getMapStairMarkers(lower).find(
    (marker) => marker.layoutId === "v-78-floor1-photo-stair-A154",
  );
  const target = ascent.targets.find((entry) => entry.floorId === upper.id);
  const arrival = resolveStairTarget(ascent, lower, upper, target);
  assert.equal(arrival.layoutId, "v-78-floor2-photo-stair-A154-arrival");
  const back = arrival.targets.find((entry) => entry.floorId === lower.id);
  assert.equal(
    resolveStairTarget(arrival, upper, lower, back).layoutId,
    ascent.layoutId,
  );
});

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

test("photo stair layouts preserve explicit source footprints and declare uncertain dimensions", () => {
  assert.equal(registry.layouts.length, 61);
  for (const layout of registry.layouts) {
    const floor = byId.get(layout.floorId);
    assert.ok(floor, layout.id);
    assert.ok(layout.sourcePhotoIds.length);
    assert.ok(
      layout.sourcePolygonIds.every((id) =>
        floor.polygons.some((polygon) => polygon.id === id),
      ),
    );
    assert.equal(
      layout.shapeStatus,
      layout.existenceStatus === "user-confirmed-existence"
        ? "user-confirmed-existence-approximate-shape"
        : "photo-plan-observed",
    );
    assert.equal(layout.verticalStatus, "approximate");
    assert.equal(
      layout.ascentDirectionStatus,
      "not-inferred-from-evacuation-arrows",
    );
    assert.ok(layout.frame.size.every((n) => Number.isFinite(n) && n > 0));
    assert.ok(layout.frame.origin.every(Number.isFinite));
    for (const flight of layout.flights) {
      assert.ok(
        [...flight.from, ...flight.to].every((n) => n >= 0 && n <= 1),
        layout.id,
      );
      assert.equal(flight.treadCount, null);
      assert.equal(flight.treadCountStatus, "not-reliably-readable");
      assert.ok(flight.widthFraction > 0 && flight.widthFraction <= 1);
    }
    for (const landing of layout.landings)
      assert.ok(landing.points.flat().every((n) => n >= 0 && n <= 1));
    if (layout.containerAreaId)
      assert.match(layout.placementStatus, /approximate/);
  }
});

test("central G V B stairs retain their wide well while side stairs use a different orientation", () => {
  const wells = registry.layouts.filter(
    (layout) => layout.shape === "wide-well-U",
  );
  assert.equal(wells.length, 11);
  for (const layout of wells) {
    assert.equal(layout.flights.length, 2);
    assert.ok(
      layout.flights[0].from[0] < 0.25 && layout.flights[1].from[0] > 0.75,
    );
    assert.ok(
      layout.flights.every((flight) => flight.from[0] === flight.to[0]),
    );
    assert.ok(
      layout.landings.every((landing) => !inRing([0.5, 0.5], landing.points)),
    );
    const bridge = layout.landings[0];
    assert.equal(bridge.railEdges.length, 1);
    const railA = bridge.points[bridge.railEdges[0]];
    const railB =
      bridge.points[(bridge.railEdges[0] + 1) % bridge.points.length];
    assert.ok(railA[0] <= 0.76 && railA[0] >= 0.24);
    assert.ok(railB[0] <= 0.76 && railB[0] >= 0.24);
  }
  const side = registry.layouts.find(
    (layout) => layout.shape === "side-left-U",
  );
  assert.ok(side.flights.every((flight) => flight.from[1] === flight.to[1]));
});

test("the small A3 stair stays a single straight flight and A1 grouping preserves the separate edge endpoint", () => {
  const small = registry.layouts.find(
    (layout) => layout.id === "v-78-floor3-photo-stair-small-straight",
  );
  assert.equal(small.shape, "straight-singleflight");
  assert.equal(small.flights.length, 1);
  assert.ok(small.sourcePhotoIds.includes("photo-3230"));
  const floor = byId.get("v-78-floor1");
  const sharedEdge = getFloorMarkers(floor).filter((marker) =>
    marker.sourceIds.includes("v-78:edge:20726"),
  );
  assert.equal(sharedEdge.length, 2);
  const matches = sharedEdge.map((marker) => stairLayoutFor(marker, floor));
  assert.equal(matches.filter(Boolean).length, 1);
  assert.equal(matches.find(Boolean).id, "v-78-floor1-photo-stair-A154");
});

test("ground central landing discrepancies are explicitly sourced, not silently claimed as native footprints", () => {
  const exceptions = registry.layouts.filter(
    (layout) => layout.nativeCoverageException,
  );
  assert.equal(exceptions.length, 2);
  for (const layout of exceptions) {
    assert.equal(layout.floorId, "v-78-floor0");
    assert.ok(["Г", "В"].includes(layout.building));
    assert.equal(layout.nativeCoverageException.scope, "raised-cross-landing");
    assert.equal(
      layout.nativeCoverageException.status,
      "documented-photo-native-discrepancy",
    );
    assert.deepEqual(
      layout.nativeCoverageException.sourcePhotoIds,
      layout.sourcePhotoIds,
    );
    assert.ok(layout.nativeCoverageException.reason.length > 40);
  }
});

test("the main hall combines BOTH photographed branches, four versus three flights per side", () => {
  const straight = registry.layouts.filter(
    (layout) => layout.shape === "straight-multiflight",
  );
  assert.equal(straight.length, 2);
  for (const layout of straight) {
    const expected = layout.floorId === "v-78-floor2" ? 4 : 3;
    assert.equal(layout.layoutMode, "opposed-branches");
    assert.equal(layout.sourcePhotoIds.length, 2);
    assert.equal(layout.flights.length, expected * 2);
    assert.equal(
      layout.landings.filter((l) => l.role === "intermediate").length,
      (expected - 1) * 2,
    );
    assert.equal(
      layout.landings.filter((l) => l.role === "central-arrival").length,
      1,
    );
    assert.ok(
      layout.flights.every(
        (flight) => flight.from[1] === 0.5 && flight.to[1] === 0.5,
      ),
    );
    assert.ok(layout.frame.size[0] / layout.frame.size[1] > 4);
    for (const flight of layout.flights) {
      assert.equal(
        flight.sourceTransitionId,
        layout.branchSourceIds[flight.branch],
      );
      assert.ok(
        flight.branch === "left"
          ? flight.to[0] > flight.from[0]
          : flight.to[0] < flight.from[0],
      );
      assert.ok(flight.topFraction > flight.baseFraction);
    }
  }
});

test("main stair on A3 descends to A2 through a display cutout, while the separate A4 stair rises", () => {
  const floor = byId.get("v-78-floor3");
  const markers = getPhotoStairMarkers(floor);
  const main = markers.find((marker) => marker.layoutId.endsWith("wide-hall"));
  const small = markers.find((marker) =>
    marker.layoutId.endsWith("small-straight"),
  );
  const mainGroup = createStaircase(main, floor);
  const smallGroup = createStaircase(small, floor);
  try {
    const mainBounds = new THREE.Box3().setFromObject(mainGroup);
    const smallBounds = new THREE.Box3().setFromObject(smallGroup);
    assert.ok(mainBounds.min.y < -3, "the main stair must descend below A3");
    assert.ok(
      mainBounds.max.y < 1.1,
      "only railing may rise above the upper floor",
    );
    assert.ok(
      smallBounds.max.y > 3,
      "the distinct source connection to A4 rises",
    );
    const cutouts = getStairDisplayCutouts(floor).filter(
      (cutout) => cutout.layoutId === main.layoutId,
    );
    assert.equal(cutouts.length, 1);
    const polygon = floor.polygons.find(
      (p) => p.id === cutouts[0].sourcePolygonIds[0],
    );
    const before = JSON.stringify(polygon);
    const display = withStairDisplayCutouts(polygon, cutouts);
    assert.equal(display.holes.length, (polygon.holes || []).length + 1);
    assert.equal(
      JSON.stringify(polygon),
      before,
      "render cutaways never modify source geometry",
    );
    assert.deepEqual(
      getStairDisplayCutouts(byId.get("v-78-floor2"))
        .filter((cutout) => !cutout.layoutId.endsWith(":incoming"))
        .map((cutout) => cutout.layoutId),
      [
        "v-78-floor2-photo-stair-A154-arrival",
        "v-78-floor2-photo-stair-A154-arrival",
        "v-78-floor2-user-stair-library",
      ],
    );
  } finally {
    for (const group of [mainGroup, smallGroup])
      group.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
  }
});

test("confirmed lower hall scheme has two separate mirrored half-level returns without changing the source evidence", () => {
  const before = JSON.stringify(registry);
  const lower = byId.get("v-78-floor1"),
    upper = byId.get("v-78-floor2");
  const lowerMarker = getMapStairMarkers(lower).find(
    (m) => m.layoutId === "v-78-floor1-photo-stair-A154",
  );
  const upperMarker = getMapStairMarkers(upper).find(
    (m) => m.layoutId === "v-78-floor2-photo-stair-A154-arrival",
  );
  const lowerLayout = stairLayoutFor(lowerMarker, lower),
    upperLayout = stairLayoutFor(upperMarker, upper);
  assert.deepEqual(upperLayout.frame, lowerLayout.frame);
  assert.equal(upperLayout.pairedLayoutId, lowerLayout.id);
  assert.ok(upperMarker.sourceIds.includes("v-78:edge:20725"));
  assert.ok(
    upperMarker.targets.some(
      (target) =>
        target.floorId === lower.id &&
        JSON.stringify(target.center) === JSON.stringify([49.985, -18.5816]),
    ),
  );
  const route = {
    segments: [
      { floorId: lower.id, nodes: [{ sourceLevel: lower.level }] },
      { floorId: upper.id, nodes: [{ sourceLevel: upper.level }] },
    ],
    transitions: [
      {
        fromFloorId: lower.id,
        toFloorId: upper.id,
        point: [49.985, -18.5816],
        targetPoint: [49.73, -17.6446],
        sourceEdgeId: "v-78:edge:20725",
      },
    ],
  };
  for (const [floor, marker, layout, top] of [
    [lower, lowerMarker, lowerLayout, 1],
    [upper, upperMarker, upperLayout, 0],
  ]) {
    const source = structuredClone(floor);
    const native = registry.layouts.find((entry) => entry.id === layout.id);
    assert.equal(
      native.shape,
      "side-right-U",
      "historical rejected raw reconstruction is retained for audit",
    );
    assert.equal(layout.shape, "mirrored-side-return-branches");
    assert.equal(layout.shapeReviewStatus, "user-confirmed-schematic");
    assert.equal(layout.geometryEvidence, "user-description-and-sketch");
    assert.deepEqual(
      layout.shapeSourcePhotoIds,
      [],
      "new flight shape is not attributed to a fire plan",
    );
    assert.deepEqual(layout.containerSourcePhotoIds, native.sourcePhotoIds);
    assert.equal(layout.flights.length, 4);
    const intermediate = layout.landings.filter(
      (landing) => landing.role === "intermediate",
    );
    assert.equal(intermediate.length, 2);
    assert.ok(
      intermediate.every((landing) => landing.elevationFraction === top - 0.5),
    );
    assert.ok(
      intermediate
        .find((landing) => landing.branch === "left")
        .points.every(([u]) => u <= 0.12),
    );
    assert.ok(
      intermediate
        .find((landing) => landing.branch === "right")
        .points.every(([u]) => u >= 0.88),
    );
    for (const branch of ["left", "right"]) {
      const [outward, inward] = layout.flights.filter(
        (flight) => flight.branch === branch,
      );
      assert.equal(outward.baseFraction, top);
      assert.equal(outward.topFraction, top - 0.5);
      assert.equal(inward.baseFraction, top - 0.5);
      assert.equal(inward.topFraction, top - 1);
      assert.ok(
        branch === "left"
          ? outward.to[0] < outward.from[0] && inward.to[0] > inward.from[0]
          : outward.to[0] > outward.from[0] && inward.to[0] < inward.from[0],
      );
    }
    assert.deepEqual(
      getStairRoutePaths(route, floor),
      [],
      "one graph edge cannot choose or concatenate the two physical branches",
    );
    const group = createStaircase(marker, floor);
    try {
      const bounds = new THREE.Box3().setFromObject(group);
      assert.equal(group.userData.geometryStatus, "user-confirmed-schematic");
      assert.equal(group.userData.room, marker);
      assert.equal(group.userData.visualStepCounts.length, 4);
      assert.ok(
        bounds.max.x - bounds.min.x > 18,
        "two separated side branches replace the narrow central U",
      );
      assert.ok(
        top === 0
          ? bounds.min.y < -3 && bounds.max.y < 1.1
          : bounds.min.y < 0.3 && bounds.max.y > 4,
      );
      const container = floor.polygons.find(
        (polygon) => polygon.id === layout.containerAreaId,
      );
      group.traverse((object) => {
        const positions = object.geometry?.attributes.position;
        if (positions)
          for (let i = 0; i < positions.count; i++)
            assert.ok(
              inRing(
                [
                  positions.getX(i) + group.position.x,
                  positions.getZ(i) + group.position.z,
                ],
                container.points,
              ),
              "all schematic mesh vertices stay within the known hall",
            );
      });
      const openings = getStairDisplayCutouts(floor).filter(
        (cutout) => cutout.layoutId === layout.id,
      );
      assert.equal(openings.length, top === 0 ? 2 : 0);
      if (openings.length) {
        assert.ok(
          Math.max(...openings[0].points.map(([x]) => x)) <
            Math.min(...openings[1].points.map(([x]) => x)),
          "the two shafts keep the central floor intact",
        );
        assert.equal(
          withStairDisplayCutouts(container, openings).holes.length,
          (container.holes || []).length + 2,
        );
      }
      assert.deepEqual(floor, source);
    } finally {
      group.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
    }
  }
  for (let i = 0; i < lowerLayout.flights.length; i++) {
    assert.deepEqual(lowerLayout.flights[i].from, upperLayout.flights[i].from);
    assert.deepEqual(lowerLayout.flights[i].to, upperLayout.flights[i].to);
    assert.equal(
      lowerLayout.flights[i].baseFraction - 1,
      upperLayout.flights[i].baseFraction,
    );
    assert.equal(
      lowerLayout.flights[i].topFraction - 1,
      upperLayout.flights[i].topFraction,
    );
  }
  assert.equal(JSON.stringify(registry), before);
});

test("lower hall descents start on the corridor side while the paired arrival and IVC repeat share the same depth reflection", () => {
  for (const [floorId, layoutId, top, markerZ] of [
    ["v-78-floor2", "v-78-floor2-photo-stair-A154-arrival", 0, -16.25],
    ["v-78-floor1", "v-78-floor1-photo-stair-A154", 1, -18.75],
    ["v-78-floor1", "v-78-floor1-user-stair-basement", 0, -16.25],
  ]) {
    const floor = byId.get(floorId);
    const marker = getMapStairMarkers(floor).find(
      (item) => item.layoutId === layoutId,
    );
    const layout = stairLayoutFor(marker, floor);
    assert.equal(
      layout.orientationStatus,
      "user-confirmed-corridor-side-departure",
    );
    assert.deepEqual(marker.center, [49.5, markerZ]);
    assert.deepEqual(layout.geometryCenter, [49.5, -17.5]);
    for (const branch of ["left", "right"]) {
      const [outward, returning] = layout.flights.filter(
        (flight) => flight.branch === branch,
      );
      assert.equal(
        outward.from[1],
        0.75,
        "entry is on the corridor-facing row",
      );
      assert.equal(outward.to[1], 0.75);
      assert.equal(returning.from[1], 0.25);
      assert.equal(returning.to[1], 0.25);
      assert.equal(outward.baseFraction, top);
      assert.equal(outward.topFraction, returning.baseFraction);
      assert.equal(returning.topFraction, top - 1);
      assert.equal(
        returning.from[0],
        outward.to[0],
        "return stays on the same side branch",
      );
    }
    const departure = layout.landings.find(
      (landing) => landing.role === "central-departure",
    );
    const arrival = layout.landings.find(
      (landing) => landing.role === "central-arrival",
    );
    assert.ok(departure.points.every(([, v]) => v >= 0.59));
    assert.ok(arrival.points.every(([, v]) => v <= 0.41));
    assert.equal(departure.elevationFraction, top);
    assert.equal(arrival.elevationFraction, top - 1);
    assert.deepEqual(
      layout.landings.find((landing) => landing.branch === "left").railEdges,
      [0, 2, 3],
    );
    assert.deepEqual(
      layout.landings.find((landing) => landing.branch === "right").railEdges,
      [0, 1, 2],
    );
  }
  const floor = byId.get("v-78-floor2");
  const accepted = getMapStairMarkers(floor).find(
    (marker) => marker.layoutId === "v-78-floor2-photo-stair-wide-hall",
  );
  const layout = stairLayoutFor(accepted, floor);
  const original = registry.layouts.find((item) => item.id === layout.id);
  assert.deepEqual(layout.frame, original.frame);
  assert.deepEqual(layout.flights, original.flights);
  assert.deepEqual(layout.landings, original.landings);
});

test("last available A/B/V/G plans show incoming stairs below their floor instead of another ascent", () => {
  const cases = [
    ["v-78-floor4", "А", 4],
    ["v-78-floor3", "Б", 3],
    ["v-78-floor3", "В", 3],
    ["v-78-floor3", "Г", 3],
  ];
  for (const [floorId, building, count] of cases) {
    const floor = byId.get(floorId);
    const before = structuredClone(floor);
    const markers = getMapStairMarkers(floor).filter(
      (marker) => marker.building === building && marker.layoutId,
    );
    assert.equal(markers.length, count);
    const cutouts = getStairDisplayCutouts(floor);
    for (const marker of markers) {
      const layout = stairLayoutFor(marker, floor);
      const native = registry.layouts.find((item) => item.id === layout.id);
      assert.equal(layout.levelRole, "upper-arrival", layout.id);
      assert.equal(layout.levelRoleSource, "last-available-building-plan");
      assert.equal(layout.displayOnlyArrival, true);
      assert.deepEqual(layout.frame, native.frame);
      assert.deepEqual(layout.sourcePhotoIds, native.sourcePhotoIds);
      assert.ok(layout.flights.every((flight) => flight.topFraction <= 0));
      assert.ok(
        layout.landings.every((landing) => landing.elevationFraction <= 0),
      );
      assert.deepEqual(
        stairLayoutFor(marker, floor).flights,
        layout.flights,
        "repeated display resolution must not lower the source geometry again",
      );
      const cutout = cutouts.find((item) => item.layoutId === layout.id);
      assert.ok(cutout, layout.id);
      const cell = floor.polygons.find((item) => item.id === layout.fitAreaId);
      assert.equal(
        withStairDisplayCutouts(cell, [cutout]).holes.length,
        (cell.holes || []).length + 1,
        "the floor fill cannot hide the arriving flight",
      );
      assert.ok(
        floor.footprints.some(
          (footprint) =>
            withStairDisplayCutouts(footprint, [cutout]) !== footprint,
        ),
        "the slab has the same local opening",
      );
      const group = createStaircase(marker, floor);
      try {
        const box = new THREE.Box3().setFromObject(group);
        assert.ok(box.min.y < -3, layout.id);
        assert.ok(
          box.max.y < 1.1,
          "only upper-floor railing may rise above zero",
        );
        assert.equal(group.userData.displayOnlyArrival, true);
      } finally {
        group.traverse((object) => {
          object.geometry?.dispose();
          object.material?.dispose();
        });
      }
    }
    assert.deepEqual(
      floor,
      before,
      "display roles never rewrite the source floor",
    );
  }
});

test("an explicit connection above the photographed set prevents automatic terminal arrival", () => {
  const original = byId.get("v-78-floor3");
  for (const targetFloorId of ["v-78-floor4", "v-78-floor999"]) {
    const floor = structuredClone(original);
    const source = floor.markers.find(
      (marker) => marker.id === "v-78:edge:20740",
    );
    assert.ok(source);
    floor.markers.push({
      ...source,
      id: "explicit-upward-connection",
      targetFloorId,
      targetPosition: [...source.position],
    });
    const marker = getMapStairMarkers(floor).find(
      (item) => item.layoutId === "v78-Г-3-ЛК2",
    );
    assert.ok(
      marker.targets.some((target) => target.floorId === targetFloorId),
    );
    const layout = stairLayoutFor(marker, floor);
    assert.equal(layout.displayOnlyArrival, undefined);
    assert.ok(layout.flights.some((flight) => flight.topFraction > 0));
    assert.ok(
      !getStairDisplayCutouts(floor).some(
        (item) => item.layoutId === layout.id,
      ),
    );
  }
});

test("the accepted A2 to A3 branches and the distinct A3 to A4 ascent retain their native roles", () => {
  for (const id of [
    "v-78-floor2-photo-stair-wide-hall",
    "v-78-floor3-photo-stair-wide-hall",
    "v-78-floor3-photo-stair-small-straight",
  ]) {
    const native = registry.layouts.find((layout) => layout.id === id);
    const floor = byId.get(native.floorId);
    const marker = getMapStairMarkers(floor).find(
      (item) => item.layoutId === id,
    );
    const displayed = stairLayoutFor(marker, floor);
    assert.deepEqual(displayed, native, id);
  }
});

test("a route arriving at or leaving the last available floor uses its descending display module", () => {
  const lower = byId.get("v-78-floor2");
  const upper = byId.get("v-78-floor3");
  const transition = upper.transitions.find(
    (item) => item.id === "v-78:edge:20740",
  );
  assert.ok(transition);
  const route = {
    segments: [
      { floorId: lower.id, nodes: [{ sourceLevel: lower.level }] },
      { floorId: upper.id, nodes: [{ sourceLevel: upper.level }] },
    ],
    transitions: [
      {
        fromFloorId: lower.id,
        toFloorId: upper.id,
        point: transition.targetPosition,
        targetPoint: transition.position,
        sourceEdgeId: transition.id,
      },
    ],
  };
  const [arrival] = getStairRoutePaths(route, upper);
  assert.equal(arrival.layoutId, "v78-Г-3-ЛК2");
  assert.ok(arrival.points[0][1] < -3);
  assert.ok(arrival.points.at(-1)[1] < 0.3);
  assert.equal(arrival.anchorAtEnd, true);
  const [departure] = getStairRoutePaths(
    {
      ...route,
      transitions: [
        {
          ...route.transitions[0],
          fromFloorId: upper.id,
          toFloorId: lower.id,
          point: transition.position,
          targetPoint: transition.targetPosition,
        },
      ],
    },
    upper,
  );
  assert.equal(departure.descending, true);
  assert.deepEqual(departure.points, [...arrival.points].reverse());
});

test("the confirmed second descent repeats the mirrored scheme toward IVC without inventing a lower floor or route edge", () => {
  const floor = byId.get("v-78-floor1");
  const markers = getMapStairMarkers(floor);
  const basement = markers.find(
    (marker) => marker.layoutId === "v-78-floor1-user-stair-basement",
  );
  const ascending = markers.find(
    (marker) => marker.layoutId === "v-78-floor1-photo-stair-A154",
  );
  assert.notEqual(basement.id, ascending.id);
  assert.equal(basement.source, "user-confirmed-location");
  assert.equal(basement.existenceStatus, "user-confirmed-existence");
  assert.equal(basement.destinationStatus, "plan-unavailable");
  assert.equal(basement.routingStatus, "display-only-no-source-transition");
  assert.match(
    basement.note,
    /План нижнего уровня и маршрут по нему уточняются/,
  );
  assert.match(basement.destinationLabel, /ИВЦ.*номер этажа уточняется/);
  assert.doesNotMatch(basement.label, /цоколь/i);
  assert.deepEqual(basement.targets, []);
  assert.deepEqual(basement.sourceIds, []);
  assert.deepEqual(basement.graphAnchors, []);
  const layout = stairLayoutFor(basement, floor);
  assert.equal(layout.evidence.type, "user-confirmed-topology");
  assert.equal(
    layout.shapeStatus,
    "user-confirmed-topology-schematic-dimensions",
  );
  assert.deepEqual(
    getStairDisplayCutouts(floor)
      .filter((cutout) => cutout.layoutId === basement.layoutId)
      .map((cutout) => cutout.layoutId),
    [basement.layoutId, basement.layoutId],
  );
  assert.ok(
    !byId
      .get("v-78-floor0")
      .polygons.some((polygon) => polygon.building === "А"),
    "a basement floor plan is not fabricated",
  );
  const group = createStaircase(basement, floor);
  try {
    const box = new THREE.Box3().setFromObject(group);
    assert.ok(box.min.y < -3 && box.max.y < 1.1);
    assert.equal(group.userData.geometryStatus, "user-confirmed-schematic");
    assert.equal(group.userData.visualStepCounts.length, 4);
    assert.deepEqual(
      layout.flights,
      stairLayoutFor(ascending, floor).flights.map((flight) => ({
        ...flight,
        baseFraction: flight.baseFraction - 1,
        topFraction: flight.topFraction - 1,
      })),
    );
    assert.deepEqual(
      getStairRoutePaths(
        {
          transitions: [
            {
              fromFloorId: floor.id,
              toFloorId: "v-78-floor0",
              sourceEdgeId: "unconfirmed-basement",
              point: basement.center,
              targetPoint: basement.center,
            },
          ],
          segments: [
            { floorId: floor.id, nodes: [{ sourceLevel: 1 }] },
            { floorId: "v-78-floor0", nodes: [{ sourceLevel: 0 }] },
          ],
        },
        floor,
      ),
      [],
      "a visual descent cannot manufacture a navigational transition",
    );
  } finally {
    group.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  }
});

test("route traces the matching main stair branch, real treads and descending upper arrival", () => {
  const lower = byId.get("v-78-floor2"),
    upper = byId.get("v-78-floor3");
  const route = {
    segments: [
      { floorId: lower.id, nodes: [{ sourceLevel: 2 }] },
      { floorId: upper.id, nodes: [{ sourceLevel: 3 }] },
    ],
    transitions: [
      {
        fromFloorId: lower.id,
        toFloorId: upper.id,
        point: [39.761, -19.0506],
        targetPoint: [46.322, -20.3286],
        sourceEdgeId: "v-78:edge:20745",
      },
    ],
  };
  const [path] = getStairRoutePaths(route, lower);
  assert.equal(path.status, "photo-shape-approximate-height");
  assert.ok(path.points.length > 30);
  assert.ok(
    path.points[0][0] < path.points.at(-1)[0],
    "left branch goes toward the central landing",
  );
  assert.ok(
    path.points.at(-1)[0] < 50,
    "route cannot leak into the right branch",
  );
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1],
      b = path.points[i];
    assert.ok(
      b[1] >= a[1],
      "the exact rendered tread profile rises monotonically",
    );
    assert.ok(
      a[1] === b[1] || (a[0] === b[0] && a[2] === b[2]),
      "vertical riser or horizontal tread/landing, never a diagonal ramp",
    );
  }
  const [arrival] = getStairRoutePaths(route, upper);
  assert.ok(arrival.points[0][1] < -3);
  assert.ok(arrival.points.at(-1)[1] < 0.3);
  assert.equal(arrival.anchorAtEnd, true);
  assert.deepEqual(
    getStairRoutePaths(
      {
        ...route,
        transitions: [
          {
            ...route.transitions[0],
            sourceEdgeId: "unknown",
            point: [999, 999],
            targetPoint: [999, 999],
          },
        ],
      },
      lower,
    ),
    [],
  );
});

test("merging photo markers preserves all 86 graph transitions and their target coordinates", () => {
  const ids = new Set();
  for (const floor of floors) {
    const merged = getMapStairMarkers(floor);
    for (const source of getFloorMarkers(floor)) {
      const layout = stairLayoutFor(source, floor);
      const target = layout
        ? merged.find((marker) => marker.layoutId === layout.id)
        : merged.find((marker) => marker.id === source.id);
      assert.ok(target, source.id);
      for (const id of source.sourceIds)
        assert.ok(target.sourceIds.includes(id), id);
      for (const transition of source.targets)
        assert.ok(
          target.targets.some(
            (item) =>
              item.floorId === transition.floorId &&
              JSON.stringify(item.center) === JSON.stringify(transition.center),
          ),
          source.id,
        );
    }
    for (const transition of floor.transitions) ids.add(transition.id);
    const layouts = merged.map((marker) => marker.layoutId).filter(Boolean);
    assert.equal(layouts.length, new Set(layouts).size);
  }
  assert.equal(ids.size, 86);
});

test("all photographed stairs produce finite batched geometry and unknown points remain symbols", () => {
  for (const floor of floors) {
    for (const marker of getPhotoStairMarkers(floor)) {
      const group = createStaircase(marker, floor);
      const layout = stairLayoutFor(marker, floor);
      assert.equal(
        group.userData.geometryStatus,
        marker.shapeReviewStatus === "user-confirmed-schematic"
          ? "user-confirmed-schematic"
          : "photo-plan-layout-approximate-vertical",
      );
      assert.ok(
        group.children.length <= (layout.enclosureWalls?.length ? 5 : 4),
        "one merged batch per material, including the explicit rear-wall material",
      );
      assert.ok(
        group.userData.visualStepCounts.every(
          (count) => count >= 4 && count <= 28,
        ),
      );
      group.traverse((object) => {
        if (object.geometry) {
          const positions = object.geometry.attributes.position.array;
          assert.ok([...positions].every(Number.isFinite), marker.id);
          // A plan-derived form may disagree with a source floor cutout, but
          // generated meshes must still stay in their declared drawing frame.
          for (let i = 0; i < positions.length; i += 3) {
            const dx = positions[i] + group.position.x - layout.frame.origin[0];
            const dz =
              positions[i + 2] + group.position.z - layout.frame.origin[1];
            for (const [axis, size] of [
              [layout.frame.axisU, layout.frame.size[0]],
              [layout.frame.axisV, layout.frame.size[1]],
            ]) {
              const value = dx * axis[0] + dz * axis[1];
              assert.ok(value >= -0.06 && value <= size + 0.06, marker.id);
            }
          }
          object.geometry.dispose();
        }
        if (object.material) object.material.dispose();
      });
    }
  }
  const point = { id: "unknown", kind: "stairs", center: [9999, 9999] };
  const group = createStaircase(point, floors[0]);
  assert.equal(group.userData.geometryStatus, "source-marker-only");
  assert.equal(group.userData.visualStepCounts, undefined);
});

test("confirmed rear walls enclose only the back of each lower opening, leaving corridor and central passages open", () => {
  for (const [level, layoutId, top] of [
    [2, "v-78-floor2-photo-stair-A154-arrival", 0],
    [1, "v-78-floor1-photo-stair-A154", 1],
    [1, "v-78-floor1-user-stair-basement", 0],
  ]) {
    const floor = JSON.parse(
      readFileSync(
        new URL(
          `../public/data/campuses/v-78/v-78-floor${level}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const original = structuredClone(floor);
    const marker = getMapStairMarkers(floor).find(
      (m) => m.layoutId === layoutId,
    );
    const layout = stairLayoutFor(marker, floor);
    assert.equal(layout.enclosureWalls.length, 2);
    assert.ok(
      layout.enclosureWalls.every(
        (wall) => wall.from[1] === 0.09 && wall.to[1] === 0.09,
      ),
    );
    const group = createStaircase(marker, floor);
    try {
      assert.equal(
        group.userData.enclosureStatus,
        "user-confirmed-rear-only-approximate-dimensions",
      );
      const wall = group.children.find((mesh) =>
        mesh.name.endsWith(" · enclosure"),
      );
      assert.ok(wall);
      wall.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(wall);
      assert.ok(Math.abs(bounds.min.y - (0.14 + 3.6 * (top - 1))) < 1e-5);
      assert.ok(Math.abs(bounds.max.y - (0.14 + 3.6 * top)) < 1e-5);
      const p = wall.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + group.position.x;
        const z = p.getZ(i) + group.position.z;
        assert.ok(
          x <= 47.50001 || x >= 51.49999,
          "central connection stays open",
        );
        assert.ok(
          Math.abs(z - (-20 + 5 * 0.09)) <= 0.071,
          "no side/front wall is invented",
        );
      }
    } finally {
      group.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
    assert.deepEqual(floor, original);
  }
});
