import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import adjacency from "../src/data/hall-adjacency.json" with { type: "json" };
import {
  getSurveyBlockedEdges,
  segmentCrossesSurveyInterior,
} from "../src/data/survey-routing.js";
import { findRoute } from "../src/data/routing.js";

const graph = JSON.parse(
  readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
);
// Independent conflict inventory from the pre-change geometry audit. The
// runtime policy computes intersections; it does not carry this ID allowlist.
const auditedConflicts = [
  10172, 10173, 10175, 10176, 10177, 10178, 10179, 10180, 10181, 10182, 10183,
  10184, 10185, 10186, 10187, 10188, 29365, 29366,
].map((id) => `v-78:edge:${id}`);

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function fixture() {
  const points = {
    a: [20, 0],
    b: [45, 0],
    upperA: [20, 10],
    upperB: [45, 10],
  };
  const edge = (id, from, to, cost) => ({
    id,
    from,
    to,
    cost,
    distanceMeters: cost,
    kind: "corridor",
    eligible: true,
    bidirectional: true,
  });
  return {
    campusId: adjacency.campusId,
    units: "meters",
    status: "source-graph",
    source: {
      geometrySha256: {
        [adjacency.floorId]: adjacency.sourceGeometrySha256,
      },
    },
    nodes: Object.entries(points).map(([id, position]) => ({
      id,
      position,
      floorId: adjacency.floorId,
      areaId: "hall",
      sourceLevel: 2,
    })),
    edges: [
      edge("new-crossing-edge", "a", "b", 25),
      edge("a-upper", "a", "upperA", 10),
      edge("upper-cross", "upperA", "upperB", 25),
      edge("upper-b", "upperB", "b", 10),
    ],
    rooms: {
      from: { nodeId: "a", label: "From", kind: "room" },
      to: { nodeId: "b", label: "To", kind: "room" },
    },
  };
}

test("survey intersections inspect open intervals, including crossings away from the global midpoint", () => {
  const square = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  for (const [a, b] of [
    [
      [-10, 1],
      [3, 1],
    ],
    [
      [3, 1],
      [-10, 1],
    ],
    [
      [0, 1],
      [1, 1],
    ],
    [
      [0.5, 0.5],
      [1.5, 1.5],
    ],
  ])
    assert.equal(segmentCrossesSurveyInterior(a, b, square), true);
  for (const [a, b] of [
    [
      [-1, 0],
      [3, 0],
    ],
    [
      [-1, 1],
      [1, -1],
    ],
    [
      [-1, -1],
      [0, 0],
    ],
    [
      [3, 1],
      [4, 1],
    ],
    [
      [0, 0],
      [0, 0],
    ],
  ])
    assert.equal(segmentCrossesSurveyInterior(a, b, square), false);
});

test("concave and repeated-vertex regions do not hide short crossings or turn boundary touches into closures", () => {
  const concave = [
    [0, 0],
    [4, 0],
    [4, 4],
    [3, 4],
    [3, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ];
  assert.equal(segmentCrossesSurveyInterior([-1, 2], [5, 2], concave), true);
  assert.equal(
    segmentCrossesSurveyInterior([1.5, 2], [2.5, 2], concave),
    false,
  );
  const repeated = [
    [0, 0],
    [2, 0],
    [2, 2],
    [2, 2],
    [0, 2],
    [0, 0],
  ];
  assert.equal(segmentCrossesSurveyInterior([-1, 1], [3, 1], repeated), true);
  assert.equal(segmentCrossesSurveyInterior([-1, 0], [3, 0], repeated), false);
});

test("the current source graph has exactly the 18 independently audited conflicting edges", () => {
  const expectedHash = createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../public/data/campuses/v-78/v-78-floor2.json",
          import.meta.url,
        ),
      ),
    )
    .digest("hex");
  assert.equal(adjacency.sourceGeometrySha256, expectedHash);
  assert.equal(graph.source.geometrySha256[adjacency.floorId], expectedHash);
  const before = JSON.stringify(graph);
  const blocked = getSurveyBlockedEdges(freeze(graph));
  assert.equal(blocked.size, 18);
  assert.deepEqual([...blocked].sort(), [...auditedConflicts].sort());
  assert.equal(JSON.stringify(graph), before);
  assert.ok(
    graph.edges
      .filter((edge) => blocked.has(edge.id))
      .every((edge) => edge.eligible),
  );
});

test("runtime restrictions compute new edge IDs geometrically and use only an existing legal detour", () => {
  const data = freeze(fixture());
  assert.deepEqual([...getSurveyBlockedEdges(data)], ["new-crossing-edge"]);
  const route = findRoute(data, "from", "to");
  assert.equal(route.ok, true);
  assert.deepEqual(
    route.edges.map((edge) => edge.id),
    ["a-upper", "upper-cross", "upper-b"],
  );
  assert.deepEqual(route.diagnostics.surveyBlockedEdgeIds, [
    "new-crossing-edge",
  ]);
  assert.ok(route.edges.every((edge) => data.edges.includes(edge)));
  assert.equal(
    findRoute({ ...data, edges: [data.edges[0]] }, "from", "to").code,
    "no-path",
  );
});

test("other campuses, stale geometry, unrelated floors, rejected edges and vertical links are unchanged", () => {
  const original = fixture();
  const candidates = [
    { ...original, campusId: "s-20" },
    {
      ...original,
      source: { geometrySha256: { [adjacency.floorId]: "stale" } },
    },
    { ...original, source: {} },
    {
      ...original,
      nodes: original.nodes.map((node) => ({
        ...node,
        floorId: "v-78-floor1",
      })),
    },
    {
      ...original,
      nodes: original.nodes.map((node) =>
        node.id === "b" ? { ...node, floorId: "v-78-floor1" } : node,
      ),
    },
    {
      ...original,
      edges: original.edges.map((edge) => ({ ...edge, eligible: false })),
    },
    {
      ...original,
      edges: original.edges.map((edge) => ({ ...edge, kind: "stairs" })),
    },
    { ...original, edges: original.edges.slice(1) },
  ];
  for (const data of candidates)
    assert.deepEqual([...getSurveyBlockedEdges(freeze(data))], []);
  const door = {
    ...fixture(),
    edges: [{ ...fixture().edges[0], kind: "door" }],
  };
  assert.deepEqual([...getSurveyBlockedEdges(door)], ["new-crossing-edge"]);
});

test("every audited conflicting anchor pair loses its crossing route without inventing a replacement", () => {
  const blocked = getSurveyBlockedEdges(graph);
  const original = JSON.stringify(graph);
  for (const edge of graph.edges.filter((item) => blocked.has(item.id))) {
    // QA endpoints reuse real graph nodes; no node or edge is added. The
    // control graph turns off only this source-bound runtime policy.
    const probe = {
      ...graph,
      rooms: {
        ...graph.rooms,
        "probe-from": { nodeId: edge.from, label: "From", kind: "room" },
        "probe-to": { nodeId: edge.to, label: "To", kind: "room" },
      },
    };
    const control = {
      ...probe,
      source: {
        ...graph.source,
        geometrySha256: {
          ...graph.source.geometrySha256,
          [adjacency.floorId]: "stale",
        },
      },
    };
    const before = findRoute(control, "probe-from", "probe-to");
    assert.equal(before.ok, true, edge.id);
    assert.ok(
      before.edges.some((item) => item.id === edge.id),
      edge.id,
    );
    assert.equal(
      findRoute(probe, "probe-from", "probe-to").code,
      "no-path",
      edge.id,
    );
  }
  assert.equal(JSON.stringify(graph), original);
});

test("real hall endpoints and G103-1 to G209 retain source-only routes without any blocked edge", () => {
  const blocked = getSurveyBlockedEdges(graph);
  for (const [from, to] of [
    ["v-78--floor-2--9z2", "v-78--floor-2--9yb"],
    ["v-78--floor-2--9yc", "v-78--floor-2--a05"],
    ["v-78--floor-0--200", "v-78--floor-1--6dn"],
  ]) {
    const result = findRoute(graph, from, to);
    assert.equal(result.ok, true, `${from} -> ${to}`);
    assert.ok(result.edges.every((edge) => !blocked.has(edge.id)));
    assert.ok(result.edges.every((edge) => graph.edges.includes(edge)));
    assert.deepEqual(result.diagnostics.surveyBlockedEdgeIds, [...blocked]);
  }
});
