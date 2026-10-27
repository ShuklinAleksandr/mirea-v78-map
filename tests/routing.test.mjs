import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { findRoute } from "../src/data/routing.js";

const read = (file) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url)));
const graph = read("public/data/routing/v-78.json");
const from = "v-78--floor-0--200";
const sameFloor = "v-78--floor-0--205";
const upstairs = "v-78--floor-1--6dn";

test("routing packages match current original sources, floor geometry and stair data", () => {
  const hash = (file) =>
    createHash("sha256")
      .update(readFileSync(new URL(`../${file}`, import.meta.url)))
      .digest("hex");
  for (const campus of ["v-78", "v-86", "s-20", "mp-1"]) {
    const exported = read(`public/data/routing/${campus}.json`);
    assert.equal(exported.source.sha256, hash(exported.source.file));
    assert.equal(
      exported.source.stairLayoutsSha256,
      hash("public/data/stair-layouts.json"),
      `${campus}: regenerate routing after stair updates`,
    );
    for (const [floorId, expected] of Object.entries(
      exported.source.geometrySha256,
    ))
      assert.equal(
        expected,
        hash(`public/data/campuses/${campus}/${floorId}.json`),
        `${floorId}: regenerate routing after geometry updates`,
      );
  }
});

test("source graph export retains every original node and edge, and coordinate transform", () => {
  for (const campus of ["v-78", "v-86", "s-20"]) {
    const exported = read(`public/data/routing/${campus}.json`);
    const source = read(`source/maps/original/pulse/campus_${campus}.json`);
    assert.equal(exported.nodes.length, source.graph.nodes.length);
    assert.equal(exported.edges.length, source.graph.edges.length);
    const byId = new Map(exported.nodes.map((node) => [node.id, node]));
    for (const sourceNode of source.graph.nodes) {
      const floor = source.floors.find((f) => f.id === sourceNode.floor_id);
      const node = byId.get(sourceNode.id);
      assert.ok(node);
      assert.ok(
        Math.abs(
          node.position[0] -
            (sourceNode.x - floor.width / 2) * floor.meters_per_unit,
        ) < 0.00001,
      );
      assert.ok(
        Math.abs(
          node.position[1] -
            (sourceNode.y - floor.height / 2) * floor.meters_per_unit,
        ) < 0.00001,
      );
    }
    const exportedEdges = new Map(
      exported.edges.map((edge) => [edge.id, edge]),
    );
    assert.equal(exportedEdges.size, source.graph.edges.length);
    for (const edge of source.graph.edges) {
      const actual = exportedEdges.get(edge.id);
      assert.ok(actual);
      assert.equal(actual.from, edge.from_node_id);
      assert.equal(actual.to, edge.to_node_id);
      assert.equal(actual.kind, edge.kind);
      assert.equal(actual.bidirectional, edge.bidirectional ?? false);
      assert.equal(actual.distanceMeters, edge.distance_meters ?? null);
      assert.equal(
        actual.cost,
        edge.distance_meters ?? edge.traversal_cost ?? null,
      );
      assert.ok(byId.has(actual.from) && byId.has(actual.to));
      assert.ok(Number.isFinite(actual.cost) && actual.cost >= 0);
    }
  }
});

test("same-floor route uses the original connected chain and actual door endpoints", () => {
  const route = findRoute(graph, from, sameFloor);
  assert.equal(route.ok, true);
  assert.equal(route.segments.length, 1);
  assert.equal(route.transitions.length, 0);
  assert.ok(route.distanceMeters > 50 && route.distanceMeters < 80);
  assert.equal(route.start.floorId, "v-78-floor0");
  assert.equal(route.end.floorId, "v-78-floor0");
  assert.equal(route.nodes[0].kind, "door");
  assert.equal(route.nodes.at(-1).kind, "door");
  assert.ok(route.edges.every((edge) => edge.eligible));
  for (let i = 0; i < route.edges.length; i++) {
    const edge = route.edges[i];
    const a = route.graphNodes[i].id,
      b = route.graphNodes[i + 1].id;
    assert.ok(
      (edge.from === a && edge.to === b) ||
        (edge.bidirectional && edge.from === b && edge.to === a),
    );
  }
});

test("G source level 1 is physical floor 2; stairs have no invented measured length", () => {
  const route = findRoute(graph, from, upstairs);
  assert.equal(route.ok, true);
  assert.equal(route.transitions.length, 1);
  assert.equal(route.transitions[0].toFloorId, "v-78-floor1");
  assert.match(route.transitions[0].label, /2 этаж.*Г/);
  assert.equal(route.distanceMeters, null);
  assert.ok(route.horizontalDistanceMeters > 0);
  assert.ok(route.durationMinutes > 0);
  assert.equal(route.estimated, true);
  assert.equal(route.navigationMode, "manual");
});

test("adjacent rooms sharing one doorway do not collapse to a zero-length route", () => {
  const route = findRoute(graph, from, "v-78--floor-0--20j");
  assert.equal(route.ok, true);
  assert.ok(route.distanceMeters > 0);
  assert.notDeepEqual(route.start.point, route.end.point);
});

test("no straight-line fallback for disconnected source rooms or missing endpoints", () => {
  assert.equal(findRoute(graph, from, "v-78--floor-0--203").code, "no-path");
  assert.equal(
    findRoute(graph, from, "invented-room").code,
    "endpoint-unavailable",
  );
  assert.equal(findRoute(graph, from, from).code, "same-place");
  assert.equal(
    findRoute(graph, from, { id: sameFloor, campusId: "s-20" }).code,
    "different-campus",
  );
});

test("schematic campus has no generated routing and accessibility is never inferred", () => {
  const mp = read("public/data/routing/mp-1.json");
  assert.equal(findRoute(mp, "a", "b").code, "graph-unavailable");
  assert.equal(
    findRoute(graph, from, sameFloor, { accessible: true }).code,
    "accessibility-unverified",
  );
});

function fixture() {
  return {
    campusId: "fixture",
    units: "meters",
    rooms: {
      a: { nodeId: "a", label: "A", kind: "room" },
      b: { nodeId: "b", label: "B", kind: "room" },
      private: { nodeId: "private", label: "Private", kind: "toilet" },
    },
    nodes: ["a", "hall", "b", "private"].map((id, i) => ({
      id,
      areaId: id,
      floorId: "f1",
      position: [i * 4, 0],
      sourceLevel: 1,
    })),
    edges: [
      {
        id: "ah",
        from: "a",
        to: "hall",
        kind: "corridor",
        cost: 4,
        eligible: true,
        bidirectional: false,
      },
      {
        id: "hb",
        from: "hall",
        to: "b",
        kind: "corridor",
        cost: 4,
        eligible: true,
        bidirectional: false,
      },
      {
        id: "wall",
        from: "a",
        to: "b",
        kind: "corridor",
        cost: 0.1,
        eligible: false,
      },
      {
        id: "ap",
        from: "a",
        to: "private",
        kind: "corridor",
        cost: 0.1,
        eligible: true,
      },
      {
        id: "pb",
        from: "private",
        to: "b",
        kind: "corridor",
        cost: 0.1,
        eligible: true,
      },
    ],
  };
}

test("directed edges, rejected wall shortcuts, and private intermediate rooms are respected", () => {
  const data = fixture();
  const route = findRoute(data, "a", "b");
  assert.equal(route.ok, true);
  assert.deepEqual(
    route.edges.map((edge) => edge.id),
    ["ah", "hb"],
  );
  assert.equal(findRoute(data, "b", "a").code, "no-path");
});

test("unknown physical floor is labelled as a source-plan level", () => {
  const data = fixture();
  const route = findRoute(data, "a", "b");
  assert.ok(route.steps.some((step) => step.text.includes("уровень 1 плана")));
});

function chainFixture(points, edges = null) {
  return {
    campusId: "fixture",
    units: "meters",
    rooms: {
      a: { nodeId: "n0", label: "A", kind: "room" },
      b: { nodeId: `n${points.length - 1}`, label: "B", kind: "room" },
    },
    nodes: points.map((position, i) => ({
      id: `n${i}`,
      areaId: "hall",
      floorId: "f1",
      position,
      sourceLevel: 1,
    })),
    edges:
      edges ||
      points.slice(1).map((_, i) => ({
        id: `e${i}`,
        from: `n${i}`,
        to: `n${i + 1}`,
        kind: "corridor",
        cost: 1,
        eligible: true,
        bidirectional: true,
      })),
  };
}

test("left/right instructions preserve orientation in every quadrant and reverse traversal", () => {
  for (const [points, direction] of [
    [
      [
        [0, 0],
        [0, -5],
        [5, -5],
      ],
      "right",
    ], // north -> east
    [
      [
        [0, 0],
        [5, 0],
        [5, 5],
      ],
      "right",
    ], // east -> south
    [
      [
        [0, 0],
        [0, 5],
        [-5, 5],
      ],
      "right",
    ], // south -> west
    [
      [
        [0, 0],
        [-5, 0],
        [-5, -5],
      ],
      "right",
    ], // west -> north
    [
      [
        [0, 0],
        [0, -5],
        [-5, -5],
      ],
      "left",
    ],
    [
      [
        [0, 0],
        [5, 0],
        [5, -5],
      ],
      "left",
    ],
    [
      [
        [0, 0],
        [0, 5],
        [5, 5],
      ],
      "left",
    ],
    [
      [
        [0, 0],
        [-5, 0],
        [-5, 5],
      ],
      "left",
    ],
  ]) {
    const data = chainFixture(points);
    assert.deepEqual(
      findRoute(data, "a", "b")
        .steps.filter((s) => s.kind === "turn")
        .map((s) => s.direction),
      [direction],
    );
    assert.deepEqual(
      findRoute(data, "b", "a")
        .steps.filter((s) => s.kind === "turn")
        .map((s) => s.direction),
      [direction === "right" ? "left" : "right"],
    );
  }
});

test("straight and nearly straight source waypoints do not produce turns or change geometry", () => {
  const points = [
    [0, 0],
    [5, 0],
    [10, 0.1],
    [15, 0],
    [20, 0],
  ];
  const route = findRoute(chainFixture(points), "a", "b");
  assert.equal(route.steps.filter((s) => s.kind === "turn").length, 0);
  assert.deepEqual(route.segments[0].points, points);
});

test("same-plan stair portals split visible geometry without claiming a different floor", () => {
  const data = chainFixture([
    [0, 0],
    [4, 0],
    [4, 9],
    [8, 9],
  ]);
  data.edges[1].kind = "stairs";
  const route = findRoute(data, "a", "b");
  assert.equal(route.segments.length, 2);
  assert.equal(route.transitions.length, 1);
  assert.deepEqual(route.segments[0].points, [
    [0, 0],
    [4, 0],
  ]);
  assert.deepEqual(route.segments[1].points, [
    [4, 9],
    [8, 9],
  ]);
  assert.equal(route.transitions[0].label, "Пройдите по лестничному переходу");
  assert.equal(route.distanceMeters, null);
  assert.equal(route.horizontalDistanceMeters, 8);
});

test("up/down does not compare physical numbering with source-plan numbering", () => {
  const data = chainFixture([
    [0, 0],
    [4, 0],
  ]);
  data.nodes[0].physicalLevel = 3;
  data.nodes[0].building = "Г";
  data.nodes[0].sourceLevel = 1;
  data.nodes[1].sourceLevel = 2;
  data.nodes[1].floorId = "f2";
  data.edges[0].kind = "stairs";
  assert.match(findRoute(data, "a", "b").transitions[0].label, /^Поднимитесь/);
  assert.match(findRoute(data, "b", "a").transitions[0].label, /^Спуститесь/);
});

test("conditional map units never become metres or estimated minutes", () => {
  const data = chainFixture([
    [0, 0],
    [4, 0],
  ]);
  data.units = "map-units";
  const route = findRoute(data, "a", "b");
  assert.equal(route.distanceMeters, null);
  assert.equal(route.horizontalDistanceMeters, null);
  assert.equal(route.durationMinutes, null);
});

test("shortest-path costs match independent Floyd–Warshall on weighted directed graphs", () => {
  let seed = 9072026;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 25; sample++) {
    const size = 12;
    const data = chainFixture(
      Array.from({ length: size }, (_, i) => [i, i % 3]),
      [],
    );
    data.rooms = Object.fromEntries(
      data.nodes.map((node) => [
        node.id,
        { nodeId: node.id, label: node.id, kind: "room" },
      ]),
    );
    const distances = Array.from({ length: size }, (_, i) =>
      Array.from({ length: size }, (_, j) => (i === j ? 0 : Infinity)),
    );
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++) {
        if (i === j || random() > 0.2) continue;
        const cost = Math.floor(random() * 10); // Includes zero-cost cycles.
        const eligible = random() > 0.15;
        const bidirectional = random() > 0.6;
        data.edges.push({
          id: `e${i}-${j}`,
          from: `n${i}`,
          to: `n${j}`,
          kind: "corridor",
          cost,
          eligible,
          bidirectional,
        });
        if (eligible) {
          distances[i][j] = Math.min(distances[i][j], cost);
          if (bidirectional) distances[j][i] = Math.min(distances[j][i], cost);
        }
      }
    for (let k = 0; k < size; k++)
      for (let i = 0; i < size; i++)
        for (let j = 0; j < size; j++)
          distances[i][j] = Math.min(
            distances[i][j],
            distances[i][k] + distances[k][j],
          );
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++) {
        if (i === j) continue;
        const route = findRoute(data, `n${i}`, `n${j}`);
        assert.equal(route.ok, Number.isFinite(distances[i][j]));
        if (route.ok)
          assert.equal(
            route.edges.reduce((sum, edge) => sum + edge.cost, 0),
            distances[i][j],
          );
      }
  }
});
