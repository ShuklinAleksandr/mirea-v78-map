import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveFloorContext,
  resolveGpsFloorContext,
  resolveRouteFloorContext,
} from "../src/data/floor-context.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import { findRoute } from "../src/data/routing.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
} from "../src/map/route-guidance.js";

const rect = (x, z, width, height) => ({
  points: [
    [x, z],
    [x + width, z],
    [x + width, z + height],
    [x, z + height],
  ],
  holes: [],
});
const floors = Array.from({ length: 5 }, (_, i) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${i}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const floor2 = floors[2];

test("one source plan resolves A2 and G3 without guessing from its internal level", () => {
  const before = JSON.stringify(floor2);
  for (const [label, building, physicalLevel] of [
    ["А-203", "А", 2],
    ["Г-310", "Г", 3],
  ]) {
    const polygon = floor2.polygons.find((p) => p.label === label);
    assert.deepEqual(resolveFloorContext(floor2, polygon.center), {
      building,
      physicalLevel,
    });
  }
  assert.equal(JSON.stringify(floor2), before);
});

test("all 26 building/physical-floor views resolve actual interior rooms with unchanged metadata", () => {
  let views = 0;
  for (const floor of floors)
    for (const [building, physicalLevel] of Object.entries(
      floor.buildingLevels,
    )) {
      const expected = { building, physicalLevel };
      const view = getBuildingFloorView(floor, building);
      let resolved = 0;
      for (const room of floor.polygons.filter(
        (p) => p.building === building,
      )) {
        const context = resolveFloorContext(floor, room.center);
        if (!context) continue; // concave source centres are not always interior points
        assert.deepEqual(context, expected, room.id);
        assert.deepEqual(
          resolveFloorContext(view, room.center),
          expected,
          `${room.id} rendered view`,
        );
        resolved++;
      }
      assert.ok(
        resolved > 0,
        `${floor.id}/${building} has a verified interior representative`,
      );
      views++;
    }
  assert.equal(views, 26);
});

test("shared corridors, unknown entrance-hall ownership, courtyards and exterior remain uncertain", () => {
  for (const id of [
    "v-78-floor2-area-29",
    "v-78-floor2-area-56",
    "v-78--floor-2--9yb",
  ]) {
    const polygon = floor2.polygons.find((p) => p.id === id);
    assert.equal(resolveFloorContext(floor2, polygon.center), null, id);
  }
  assert.equal(resolveFloorContext(floor2, [10000, 10000]), null);
  // A source courtyard stays empty even if a malformed assigned polygon covers it.
  const footprint = { ...rect(0, 0, 20, 20), holes: [rect(6, 6, 8, 8).points] };
  const floor = {
    buildingLevels: { А: 2 },
    exteriorFootprints: [footprint],
    polygons: [{ building: "А", ...rect(1, 1, 18, 18) }],
  };
  assert.equal(resolveFloorContext(floor, [10, 10]), null);
  assert.equal(resolveFloorContext(floor, [6, 10], { margin: 0 }), null);
  assert.deepEqual(resolveFloorContext(floor, [3, 3]), {
    building: "А",
    physicalLevel: 2,
  });
});

test("an exclusively owned indoor component resolves unnamed corridors; shared components do not", () => {
  const exclusive = floor2.polygons.find(
    (p) => p.id === "v-78-floor2-area-331",
  );
  assert.equal(exclusive.building, null);
  assert.deepEqual(resolveFloorContext(floor2, exclusive.center), {
    building: "И",
    physicalLevel: 2,
  });
  const floor = {
    buildingLevels: { А: 2, Г: 3 },
    exteriorFootprints: [rect(0, 0, 20, 10)],
    polygons: [
      { building: "А", ...rect(0, 0, 5, 10) },
      { building: "Г", ...rect(15, 0, 5, 10) },
    ],
  };
  assert.equal(resolveFloorContext(floor, [10, 5]), null);
});

test("the six real floor2 source openings never acquire a nearest building context", () => {
  const insideRing = (point, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j],
        b = ring[i];
      if (
        a[1] > point[1] !== b[1] > point[1] &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
    return inside;
  };
  const holes = floor2.exteriorFootprints.flatMap((polygon) => polygon.holes);
  assert.equal(holes.length, 6);
  for (const hole of holes) {
    const middle = [
      (Math.min(...hole.map((p) => p[0])) +
        Math.max(...hole.map((p) => p[0]))) /
        2,
      (Math.min(...hole.map((p) => p[1])) +
        Math.max(...hole.map((p) => p[1]))) /
        2,
    ];
    assert.ok(
      insideRing(middle, hole),
      "fixture point actually lies in the source opening",
    );
    assert.equal(resolveFloorContext(floor2, middle), null);
  }
});

test("uncertainty discs and boundary margins must fit one context, never overlap another", () => {
  const floor = {
    buildingLevels: { А: 2, Г: 3 },
    polygons: [
      { building: "А", ...rect(0, 0, 10, 10) },
      { building: "Г", ...rect(8, 3, 8, 4) },
    ],
  };
  assert.deepEqual(resolveFloorContext(floor, [4, 5], { accuracy: 2 }), {
    building: "А",
    physicalLevel: 2,
  });
  assert.equal(resolveFloorContext(floor, [4, 5], { accuracy: 4 }), null);
  assert.equal(
    resolveFloorContext(floor, [7, 5], { margin: 0, accuracy: 1.1 }),
    null,
  );
  assert.equal(resolveFloorContext(floor, [9, 5]), null);
  assert.equal(resolveFloorContext(floor, [0.2, 5]), null);
  assert.equal(resolveFloorContext(floor, [0, 5], { margin: 0 }), null);
  for (const accuracy of [-1, NaN, Infinity])
    assert.equal(resolveFloorContext(floor, [4, 5], { accuracy }), null);
  assert.equal(resolveFloorContext(floor, [NaN, 0]), null);
  assert.equal(
    resolveFloorContext({ level: 2, polygons: floor.polygons }, [4, 5]),
    null,
  );
});

test("GPS uncertainty can span rooms in the same building but cannot overlap another wing", () => {
  const floor = {
    id: "same-plan",
    campusId: "v-78",
    units: "meters",
    buildingLevels: { А: 2, Г: 3 },
    footprints: [rect(0, 0, 50, 20)],
    polygons: [
      { building: "А", ...rect(2, 2, 20, 16) },
      { building: "Г", ...rect(22, 2, 2, 16) },
      { building: "Г", ...rect(24, 2, 2, 16) },
      { building: "Г", ...rect(26, 2, 20, 16) },
    ],
  };
  const now = 1_000_000;
  const fix = {
    source: "gps",
    campusId: "v-78",
    point: [25, 10],
    accuracyMeters: 2,
    timestamp: now,
  };
  assert.equal(resolveFloorContext(floor, fix.point, { accuracy: 2 }), null);
  assert.deepEqual(resolveGpsFloorContext(floor, fix, now), {
    building: "Г",
    physicalLevel: 3,
  });
  for (const unsupported of [
    { accuracyMeters: 3 },
    { point: [23, 10] },
    { point: [25, 1] },
    { floorId: "other-plan" },
    { timestamp: now - 11_000 },
  ])
    assert.equal(
      resolveGpsFloorContext(floor, { ...fix, ...unsupported }, now),
      null,
    );
});

test("floor indexes reuse immutable source contours and evict old views after eight entries", () => {
  let reads = 0;
  const shape = rect(0, 0, 10, 10);
  const polygon = {
    building: "А",
    get points() {
      reads++;
      return shape.points;
    },
  };
  const floor = { buildingLevels: { А: 2 }, polygons: [polygon] };
  resolveFloorContext(floor, [5, 5]);
  const preparedReads = reads;
  for (let i = 0; i < 20; i++) resolveFloorContext(floor, [5, 5]);
  assert.equal(reads, preparedReads, "hot queries reuse the prepared rings");
  for (let i = 0; i < 8; i++)
    resolveFloorContext(
      { buildingLevels: { А: 2 }, polygons: [polygon] },
      [5, 5],
    );
  const afterOtherViews = reads;
  resolveFloorContext(floor, [5, 5]);
  assert.ok(reads > afterOtherViews, "oldest source view was evicted");
  floor.buildingLevels = { А: 4 };
  assert.deepEqual(resolveFloorContext(floor, [5, 5]), {
    building: "А",
    physicalLevel: 4,
  });
  floor.polygons = [];
  assert.equal(resolveFloorContext(floor, [5, 5]), null);
});

const routeFloor = {
  id: "shared",
  units: "meters",
  buildingLevels: { А: 2, Г: 3 },
};
const node = (
  x,
  building,
  physicalLevel = routeFloor.buildingLevels[building],
) => ({
  position: [x, 0],
  floorId: "shared",
  building,
  physicalLevel,
});
const nodes = [node(0, "А"), node(10, "А"), node(20, "Г"), node(30, "Г")];

test("route context waits through A-to-G transition until the actual G-to-G edge", () => {
  assert.deepEqual(resolveRouteFloorContext(routeFloor, [5, 0], nodes), {
    building: "А",
    physicalLevel: 2,
  });
  for (const point of [
    [10, 0],
    [15, 0],
    [20, 0],
    [20.2, 0],
  ])
    assert.equal(resolveRouteFloorContext(routeFloor, point, nodes), null);
  assert.deepEqual(resolveRouteFloorContext(routeFloor, [21, 0], nodes), {
    building: "Г",
    physicalLevel: 3,
  });
  assert.deepEqual(resolveRouteFloorContext(routeFloor, [25, 0.25], nodes), {
    building: "Г",
    physicalLevel: 3,
  });
  assert.equal(resolveRouteFloorContext(routeFloor, [25, 0.251], nodes), null);
});

test("route context rejects unknown or conflicting floors and overlapping differently labelled edges", () => {
  for (const changed of [
    { physicalLevel: 2 },
    { building: null },
    { floorId: "other" },
  ]) {
    const altered = [node(20, "Г"), { ...node(30, "Г"), ...changed }];
    assert.equal(resolveRouteFloorContext(routeFloor, [25, 0], altered), null);
  }
  assert.equal(
    resolveRouteFloorContext(
      routeFloor,
      [5, 0],
      [node(0, "А"), node(10, "А"), node(10, "Г"), node(0, "Г")],
    ),
    null,
  );
  assert.equal(
    resolveRouteFloorContext(routeFloor, [5, 0], [node(5, "А"), node(5, "А")]),
    null,
  );
  assert.equal(
    resolveRouteFloorContext(
      { ...routeFloor, units: "map-units" },
      [5, 0],
      nodes,
    ),
    null,
  );
});

test("real G103-1 to G209 route samples use each segment's physical floor without changing the route", () => {
  const graph = JSON.parse(
    readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
  );
  const route = findRoute(graph, "v-78--floor-0--200", "v-78--floor-1--6dn");
  assert.equal(route.ok, true);
  const before = JSON.stringify(route);
  const guide = createRouteGuidance(route);
  for (const [sectionIndex, section] of guide.sections.entries()) {
    const floor = floors.find((item) => item.id === section.floorId);
    let resolved = 0;
    for (let i = 0; i <= 20; i++) {
      const sample = sampleRouteGuidance(
        guide,
        sectionIndex,
        (section.length * i) / 20,
      );
      const context = resolveRouteFloorContext(
        floor,
        sample.position,
        route.segments[sample.sourceSegmentIndex].nodes,
      );
      if (context) {
        assert.deepEqual(context, {
          building: "Г",
          physicalLevel: floor.buildingLevels.Г,
        });
        resolved++;
      }
    }
    assert.ok(resolved > 0, section.floorId);
  }
  assert.equal(JSON.stringify(route), before);
});
