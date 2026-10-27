import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { roundWalkingRoute } from "../src/map/route-rounding.js";
import {
  createRouteLayer,
  disposeRouteLayer,
  visibleRouteSegments,
} from "../src/map/route.js";
import { findRoute } from "../src/data/routing.js";
import { getMapStairMarkers, stairLayoutFor } from "../src/map/stairs.js";

function fixture(
  points = [
    [0, 0],
    [10, 0],
    [10, 10],
  ],
) {
  const segment = {
    floorId: "floor",
    points,
    nodes: points.map((position, i) => ({
      id: `n${i}`,
      areaId: "hall",
      kind: "waypoint",
      position,
    })),
  };
  const route = {
    segments: [segment],
    edges: points.slice(1).map((_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      kind: "corridor",
      eligible: true,
      bidirectional: true,
    })),
  };
  const floor = {
    id: "floor",
    units: "meters",
    polygons: [
      {
        id: "hall",
        kind: "unclassified",
        points: [
          [-2, -2],
          [13, -2],
          [13, 13],
          [-2, 13],
        ],
        holes: [],
      },
    ],
    walls: [],
    doors: [],
  };
  return { segment, route, floor };
}

test("walking turns become short tangent fillets within their proven source area", () => {
  const f = fixture();
  const source = structuredClone(f);
  const result = roundWalkingRoute(f.segment, f.route, f.floor);
  assert.equal(result.roundedCorners, 1);
  assert.ok(result.points.length > f.segment.points.length);
  assert.deepEqual(result.points[0], [0, 0]);
  assert.deepEqual(result.points.at(-1), [10, 10]);
  assert.deepEqual(result.points[1], [9.25, 0]);
  assert.deepEqual(result.points.at(-2), [10, 0.75]);
  assert.ok(
    result.points
      .slice(2, -2)
      .every(([x, z]) => x > 9.25 && x <= 10 && z > 0 && z < 0.75),
  );
  assert.deepEqual(
    f,
    source,
    "rendering does not mutate graph nodes, metrics, or source polygons",
  );
});

test("a wall, doorway, tiny enclosed hole, or concave notch prevents a corner cut", () => {
  const barriers = [
    (f) => f.floor.walls.push({ a: [10, 0], b: [9.99, 0.01] }),
    (f) => f.floor.doors.push({ a: [10, 0], b: [9.99, 0.01] }),
    (f) =>
      f.floor.polygons[0].holes.push([
        [9.99, 0.002],
        [9.991, 0.002],
        [9.991, 0.003],
        [9.99, 0.003],
      ]),
    (f) => {
      f.floor.polygons[0].points = [
        [-2, -2],
        [13, -2],
        [13, 13],
        [9.991, 13],
        [9.991, 0.002],
        [9.99, 0.002],
        [9.99, 13],
        [-2, 13],
      ];
    },
  ];
  for (const addBarrier of barriers) {
    const f = fixture();
    addBarrier(f);
    const result = roundWalkingRoute(f.segment, f.route, f.floor);
    assert.equal(result.roundedCorners, 0);
    assert.deepEqual(
      result.points,
      f.segment.points,
      "retain the complete original turn",
    );
  }
});

test("a nearby obstacle reduces the fillet radius until its whole control triangle is clear", () => {
  const f = fixture();
  f.floor.walls.push({ a: [9.8, 0.08], b: [9.82, 0.12] });
  const result = roundWalkingRoute(f.segment, f.route, f.floor);
  assert.equal(result.roundedCorners, 1);
  assert.deepEqual(result.points[1], [9.8125, 0]);
  assert.deepEqual(result.points.at(-2), [10, 0.1875]);
  assert.ok(result.points.slice(1, -1).every(([x]) => x >= 9.8125));
});

test("a small stair footprint protects the stair without freezing its entire hallway container", () => {
  const f = fixture();
  f.floor.transitions = [{ kind: "stairs", position: [1, 1] }];
  const remoteStair = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const openCorner = roundWalkingRoute(
    f.segment,
    f.route,
    f.floor,
    [],
    [remoteStair],
  );
  assert.equal(openCorner.roundedCorners, 1);
  const stairAtTurn = [
    [9.9, -0.1],
    [10.1, -0.1],
    [10.1, 0.2],
    [9.9, 0.2],
  ];
  const protectedCorner = roundWalkingRoute(
    f.segment,
    f.route,
    f.floor,
    [],
    [stairAtTurn],
  );
  assert.equal(protectedCorner.roundedCorners, 0);
  assert.deepEqual(protectedCorner.points, f.segment.points);
});

test("hairpins, door edges, door nodes, stairs and area changes preserve source vertices", () => {
  const cases = [
    (f) => {
      f.segment.points[2] = [0.1, 0.1];
    },
    (f) => {
      f.route.edges[1].kind = "door";
    },
    (f) => {
      f.segment.nodes[1].kind = "door";
    },
    (f) => {
      f.segment.nodes[1].kind = "stairs";
    },
    (f) => {
      f.segment.nodes[2].areaId = "another-area";
    },
    (f) => {
      f.floor.transitions = [{ kind: "stairs", position: [9.8, 0.1] }];
    },
    (f) => {
      f.floor.polygons[0].kind = "room";
    },
    (f) => {
      f.floor.units = "map-units";
    },
    (f) => {
      f.route.edges[0].eligible = false;
    },
  ];
  for (const configure of cases) {
    const f = fixture();
    configure(f);
    const result = roundWalkingRoute(f.segment, f.route, f.floor);
    assert.equal(result.roundedCorners, 0);
    assert.deepEqual(result.points, f.segment.points);
  }
  const f = fixture();
  assert.equal(
    roundWalkingRoute(f.segment, f.route, f.floor, ["hall"]).roundedCorners,
    0,
  );
  assert.deepEqual(
    roundWalkingRoute(f.segment, f.route, null).points,
    f.segment.points,
  );
});

test("adjacent short legs never overlap their fillets or turn back on themselves", () => {
  const f = fixture([
    [0, 0],
    [2, 0],
    [2, 2],
    [4, 2],
  ]);
  const result = roundWalkingRoute(f.segment, f.route, f.floor);
  assert.equal(result.roundedCorners, 2);
  assert.ok(
    result.points.every(
      ([x, z], i, points) =>
        !i || (x >= points[i - 1][0] && z >= points[i - 1][1]),
    ),
  );
  const narrow = fixture([
    [0, 0],
    [0.1, 0],
    [0.1, 0.1],
  ]);
  assert.deepEqual(
    roundWalkingRoute(narrow.segment, narrow.route, narrow.floor).points,
    narrow.segment.points,
  );
});

test("route layers use the fillet for both strokes while preserving observed stair geometry", () => {
  const f = fixture();
  const stair = {
    sourcePoint: [10, 10],
    points: [
      [10, 0.35, 10],
      [10, 1.8, 12],
      [10, 3.95, 10],
    ],
    status: "photo-backed",
    sourceEdgeId: "stairs",
  };
  const originalStair = structuredClone(stair);
  const layer = createRouteLayer(f.route, "floor", {
    floor: f.floor,
    stairPaths: [stair],
  });
  try {
    assert.equal(layer.group.userData.roundedRouteCorners, 1);
    assert.equal(layer.paths[0].roundedCorners, 1);
    const walkingLines = layer.group.children.filter(
      (object) => object.isLine2 && !object.userData.stairPath,
    );
    assert.equal(walkingLines.length, 2);
    assert.equal(
      walkingLines[0].geometry.instanceCount,
      layer.paths[0].points.length - 1,
    );
    assert.deepEqual(stair, originalStair);
    for (const line of layer.group.children.filter(
      (object) => object.userData.stairPath,
    ))
      assert.equal(line.geometry.instanceCount, stair.points.length - 1);
  } finally {
    disposeRouteLayer(layer);
  }
});

test("duplicate route points keep their graph nodes aligned for protected doorway checks", () => {
  const f = fixture([
    [0, 0],
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  f.segment.nodes[2].kind = "door";
  const segment = visibleRouteSegments(f.route, "floor")[0];
  assert.deepEqual(
    segment.nodes.map(({ id }) => id),
    ["n0", "n2", "n3"],
  );
  assert.equal(segment.nodes[1].kind, "door");
  assert.deepEqual(
    roundWalkingRoute(segment, f.route, f.floor).points,
    segment.points,
  );
});

test("a real V78 route gains a bounded curve without changing source steps or reachability", () => {
  const read = (filename) =>
    JSON.parse(
      readFileSync(
        new URL(`../public/data/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  const graph = read("routing/v-78.json");
  const route = findRoute(graph, "v-78--floor-2--9yb", "v-78--floor-1--6h2");
  assert.equal(route.ok, true);
  const before = structuredClone(route);
  const floor = read("campuses/v-78/v-78-floor1.json");
  const segment = visibleRouteSegments(route, floor.id)[0];
  const result = roundWalkingRoute(segment, route, floor);
  assert.ok(result.roundedCorners > 0);
  assert.deepEqual(result.points[0], segment.points[0]);
  assert.deepEqual(result.points.at(-1), segment.points.at(-1));
  assert.deepEqual(route, before);
});

test("ordinary V78 destinations retain useful smoothing with actual stair footprints excluded", () => {
  const read = (filename) =>
    JSON.parse(
      readFileSync(
        new URL(`../public/data/${filename}`, import.meta.url),
        "utf8",
      ),
    );
  const graph = read("routing/v-78.json");
  const rooms = Object.entries(graph.rooms);
  const id = (label) =>
    rooms.find(([, room]) => room.label === label && room.connected)?.[0];
  const floors = new Map(
    [0, 1, 2, 3, 4].map((level) => {
      const floor = read(`campuses/v-78/v-78-floor${level}.json`);
      const exclusions = getMapStairMarkers(floor).flatMap((marker) => {
        const layout = stairLayoutFor(marker, floor);
        return layout
          ? [
              layout.footprint.map(([u, v]) => [
                layout.frame.origin[0] +
                  layout.frame.axisU[0] * u * layout.frame.size[0] +
                  layout.frame.axisV[0] * v * layout.frame.size[1],
                layout.frame.origin[1] +
                  layout.frame.axisU[1] * u * layout.frame.size[0] +
                  layout.frame.axisV[1] * v * layout.frame.size[1],
              ]),
            ]
          : [];
      });
      return [floor.id, { floor, exclusions }];
    }),
  );
  for (const target of [
    "А-125",
    "А-203",
    "А-422",
    "Г-416",
    "Б-108",
    "Киберзона",
  ]) {
    const route = findRoute(graph, id("Главный вход"), id(target));
    assert.equal(route.ok, true, target);
    const source = structuredClone(route);
    let roundedCorners = 0;
    for (const raw of route.segments) {
      const segment = visibleRouteSegments({ segments: [raw] }, raw.floorId)[0];
      const { floor, exclusions } = floors.get(raw.floorId);
      roundedCorners += roundWalkingRoute(
        segment,
        route,
        floor,
        [],
        exclusions,
      ).roundedCorners;
    }
    assert.ok(
      roundedCorners > 0,
      `No visible improvement on the route to ${target}`,
    );
    assert.deepEqual(route, source, target);
  }
});
