import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIBRARY_I_PASSAGE,
  LIBRARY_PASSAGE_EDGE_ID,
  libraryPassageSegmentCovered,
  withLibraryPassageFloor,
  withLibraryPassageGraph,
} from "../src/data/library-passage.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const floor = read("../public/data/campuses/v-78/v-78-floor1.json");
const graph = read("../public/data/routing/v-78.json");
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const withoutStreet = {
  ...graph,
  edges: graph.edges.filter(
    (edge) =>
      ![edge.from, edge.to].some(
        (id) => nodes.get(id).areaId === "v-78-floor1-area-604",
      ),
  ),
};
const reachable = (g, start, end) => {
  const adjacent = new Map(g.nodes.map((n) => [n.id, []]));
  for (const edge of g.edges) {
    if (!edge.eligible) continue;
    adjacent.get(edge.from).push(edge.to);
    if (edge.bidirectional) adjacent.get(edge.to).push(edge.from);
  }
  const seen = new Set([start]),
    queue = [start];
  for (const id of queue) {
    if (id === end) return true;
    for (const next of adjacent.get(id) || [])
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  }
  return false;
};

test("the raw library corridor ends at the closed source wall; the confirmed overlay opens only that shared end", () => {
  const before = JSON.stringify(floor),
    view = withLibraryPassageFloor(floor);
  assert.notEqual(view, floor);
  assert.equal(view.walls.length, floor.walls.length - 2);
  const removed = floor.walls.filter((wall) => !view.walls.includes(wall));
  assert.deepEqual(
    removed.map(({ a, b }) => ({ a, b })),
    [LIBRARY_I_PASSAGE.boundary, LIBRARY_I_PASSAGE.closedMark],
  );
  for (const key of [
    "polygons",
    "doors",
    "footprints",
    "markers",
    "transitions",
  ])
    assert.equal(view[key], floor[key], `${key} retain the source objects`);
  assert.equal(
    view.userConfirmedLibraryPassage.evidence.type,
    "user-confirmed-open-corridor-end",
  );
  assert.equal(withLibraryPassageFloor(floor), view);
  assert.equal(withLibraryPassageFloor(view), view);
  assert.equal(JSON.stringify(floor), before);
});

test("only two contained approach links and a local passage join existing library and И corridor nodes", () => {
  const before = JSON.stringify(graph),
    view = withLibraryPassageGraph(graph);
  assert.equal(view.nodes.length, graph.nodes.length + 2);
  assert.equal(view.edges.length, graph.edges.length + 3);
  assert.equal(view.rooms, graph.rooms);
  assert.ok(graph.nodes.every((node, i) => view.nodes[i] === node));
  assert.ok(graph.edges.every((edge, i) => view.edges[i] === edge));
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const edges = view.edges.slice(-3),
    center = view.userConfirmedLibraryPassage.center;
  for (const edge of edges) {
    assert.equal(edge.ephemeral, true);
    assert.equal(edge.source, "user-confirmed-library-passage");
    assert.equal(edge.confidence, "user-confirmed");
    assert.equal(
      edge.sourceId,
      undefined,
      "new evidence is not mislabeled as a source graph edge",
    );
    assert.ok(
      edge.distanceMeters < 3.1,
      "no long replacement corridor is invented",
    );
    const a = byId.get(edge.from),
      b = byId.get(edge.to);
    assert.equal(a.floorId, floor.id);
    assert.equal(b.floorId, floor.id);
    if (edge.kind === "corridor") {
      const area = floor.polygons.find((p) => p.id === edge.areaId);
      assert.equal(a.areaId, area.id);
      assert.equal(b.areaId, area.id);
      assert.ok(libraryPassageSegmentCovered(a.position, b.position, area));
    } else {
      assert.equal(edge.id, LIBRARY_PASSAGE_EDGE_ID);
      assert.equal(edge.kind, "passage");
      assert.ok(Math.abs(edge.distanceMeters - 0.24) < 1e-8);
      for (const node of [a, b])
        assert.ok(
          libraryPassageSegmentCovered(
            node.position,
            center,
            floor.polygons.find((p) => p.id === node.areaId),
          ),
        );
    }
  }
  assert.equal(withLibraryPassageGraph(graph), view);
  assert.equal(withLibraryPassageGraph(view), view);
  const clone = {
    ...view,
    rooms: {
      ...view.rooms,
      testAlias: graph.rooms[Object.keys(graph.rooms)[0]],
    },
  };
  assert.equal(
    withLibraryPassageGraph(clone),
    clone,
    "endpoint aliases survive recursive routing",
  );
  assert.equal(JSON.stringify(graph), before);
});

test("library stairs reach И in both directions without street edges through the same production routing entry point", () => {
  const destination = Object.keys(graph.rooms).find(
    (id) => graph.rooms[id].label === "И-205-а",
  );
  const sourceNode = "v-78:floor-2:9zh:portal:adq";
  assert.equal(
    reachable(withoutStreet, sourceNode, graph.rooms[destination].nodeId),
    false,
  );
  assert.equal(
    reachable(
      withLibraryPassageGraph(withoutStreet),
      sourceNode,
      graph.rooms[destination].nodeId,
    ),
    true,
  );
  const library = "photo-stair:v-78-floor2-user-stair-library";
  for (const [from, to] of [
    [library, destination],
    [destination, library],
  ]) {
    const route = findNavigationRoute(withoutStreet, from, to);
    assert.equal(route.ok, true, route.message);
    assert.ok(route.edges.some((e) => e.id === LIBRARY_PASSAGE_EDGE_ID));
    assert.ok(route.edges.some((e) => e.id === "v-78:edge:20734"));
    assert.ok(route.nodes.every((n) => n.areaId !== "v-78-floor1-area-604"));
    assert.ok(
      route.edges
        .filter((e) => e.source === "user-confirmed-library-passage")
        .every((e) => e.ephemeral),
    );
  }
});

test("changed source contours, wall identity, portal anchors or graph fingerprints fail closed", () => {
  for (const mutate of [
    (f) => {
      f.source.svgSha256 = "changed";
    },
    (f) => {
      f.polygons.find(
        (p) => p.id === LIBRARY_I_PASSAGE.areas[0].id,
      ).points[0][0] += 0.01;
    },
    (f) => {
      f.polygons.find((p) => p.id === LIBRARY_I_PASSAGE.areas[1].id).kind =
        "room";
    },
    (f) => {
      f.walls = f.walls.filter(
        (w) => w.a[0] !== LIBRARY_I_PASSAGE.closedMark.a[0],
      );
    },
  ]) {
    const copy = structuredClone(floor);
    mutate(copy);
    assert.equal(withLibraryPassageFloor(copy), copy);
  }
  for (const mutate of [
    (g) => {
      g.source.geometrySha256[floor.id] = "changed";
    },
    (g) => {
      g.source.sha256 = "changed";
    },
    (g) => {
      g.nodes.find(
        (n) => n.id === LIBRARY_I_PASSAGE.anchors[0].id,
      ).position[0] += 0.01;
    },
    (g) => {
      g.nodes.find((n) => n.id === LIBRARY_I_PASSAGE.anchors[1].id).areaId =
        "other-room";
    },
    (g) => {
      g.edges.find((e) => e.id === "v-78:edge:9144").eligible = false;
    },
  ]) {
    const copy = structuredClone(withoutStreet);
    mutate(copy);
    assert.equal(withLibraryPassageGraph(copy), copy);
    const route = findNavigationRoute(
      copy,
      "photo-stair:v-78-floor2-user-stair-library",
      "v-78--floor-2--a7o",
    );
    assert.equal(route.ok, false);
  }
});

test("approach containment checks every interval, rejecting narrow holes that endpoints and a midpoint miss", () => {
  const box = {
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    holes: [],
  };
  assert.equal(libraryPassageSegmentCovered([0.5, 5], [9.5, 5], box), true);
  assert.equal(
    libraryPassageSegmentCovered([0.5, 5], [9.5, 5], {
      ...box,
      holes: [
        [
          [1, 4],
          [2, 4],
          [2, 6],
          [1, 6],
        ],
      ],
    }),
    false,
  );
  assert.equal(libraryPassageSegmentCovered([0.5, 5], [11, 5], box), false);
});
