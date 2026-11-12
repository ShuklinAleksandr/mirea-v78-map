import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { stairEndpointCandidates } from "../src/data/stair-routing.js";
import { entranceStairPortals } from "../src/data/entrance-stair-portals.js";
import { manualPlaceLocation } from "../src/data/user-location.js";
import { getFloorMarkers } from "../src/data/utils.js";
import {
  getMapStairMarkers,
  withConfirmedStairSearch,
} from "../src/map/stairs.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const graph = read("../public/data/routing/v-78.json");
const floor = read("../public/data/campuses/v-78/v-78-floor2.json");
const search = withConfirmedStairSearch(
  read("../public/data/search-index.json"),
  [floor],
);
const main = search.find((place) => place.label === "Главная лестница");
const parent = "v-78--floor-3--cvi";
const children = Object.entries(graph.rooms).filter(([, room]) =>
  /^Г-424[-.]/.test(room.label),
);
const roomId = (label) =>
  Object.keys(graph.rooms).find((id) => graph.rooms[id].label === label);
const gLk2 = ["v-78:edge:20714", "v-78:edge:20721", "v-78:edge:20740"];

function assertOriginalEdges(route, source = graph) {
  const edges = new Map(source.edges.map((edge) => [edge.id, edge]));
  assert.equal(route.ok, true);
  for (const edge of route.edges) assert.deepEqual(edge, edges.get(edge.id));
  assert.deepEqual(route.diagnostics.localConnectorIds, []);
}

test("the actual main-stair search and card endpoints route to all five G424 children through the existing parent entrance", () => {
  const before = JSON.stringify(graph);
  assert.ok(main.searchAliases.includes("штаны"));
  assert.equal(manualPlaceLocation(main, floor, "v-78").placeId, main.id);
  assert.equal(children.length, 5);
  const portals = stairEndpointCandidates(graph, main).map(
    (candidate) => candidate.nodeId,
  );
  assert.equal(portals.length, 2);
  const exactParent = findRoute(graph, main, parent);
  assertOriginalEdges(exactParent);
  assert.equal(exactParent.start.label, "Главная лестница");
  assert.equal(exactParent.start.endpointKind, "stairs");
  assert.ok(portals.includes(exactParent.graphNodes[0].id));
  assert.notDeepEqual(
    exactParent.start.point,
    main.center,
    "no line is invented from the decorative centre",
  );
  assert.deepEqual(
    exactParent.transitions.map((transition) => transition.sourceEdgeId),
    [gLk2[2]],
  );
  for (const [id, room] of children) {
    const exact = findRoute(graph, main, id);
    assert.equal(exact.reason, "target-isolated-source-component");
    const route = findNavigationRoute(graph, main, id);
    assertOriginalEdges(route);
    assert.equal(route.partial, true);
    assert.equal(route.lastLeg.kind, "inside-parent");
    assert.equal(route.requestedDestination.roomId, id);
    assert.equal(route.end.roomId, parent);
    assert.equal(route.lastLeg.geometryAvailable, false);
    assert.ok(route.steps.at(-1).text.includes(room.label));
    assert.deepEqual(route.edges, exactParent.edges);
  }
  const card = getMapStairMarkers(floor).find(
    (marker) => marker.id === main.id,
  );
  for (const origin of [card, main.id]) {
    const route = findNavigationRoute(graph, origin, children[0][0]);
    assert.equal(route.ok, true);
    assert.deepEqual(route.start.point, exactParent.start.point);
  }
  assert.equal(JSON.stringify(graph), before);
});

test("native stair markers and reversed routes end on source portals; unbound display symbols do not guess a connection", () => {
  const native = getFloorMarkers(floor).find((marker) =>
    marker.sourceIds.includes("v-78:edge:20745"),
  );
  assert.ok(native);
  const forward = findRoute(graph, native, parent);
  assertOriginalEdges(forward);
  assert.ok(
    Math.hypot(...forward.start.point.map((n, i) => n - native.center[i])) <
      0.001,
  );
  const reverse = findRoute(graph, parent, main);
  assertOriginalEdges(reverse);
  assert.equal(reverse.end.roomId, main.id);
  assert.equal(reverse.end.endpointKind, "stairs");
  assert.ok(
    stairEndpointCandidates(graph, main).some(
      (candidate) => candidate.nodeId === reverse.graphNodes.at(-1).id,
    ),
  );
  for (const invalid of [
    { ...main, floorId: "v-78-floor1" },
    { ...main, routingStatus: "display-only-no-source-transition" },
    { ...main, id: "photo-stair:invented" },
    { ...native, position: [0, 0], center: [0, 0] },
    { ...native, sourceIds: ["invented-edge"] },
  ])
    assert.equal(
      findRoute(graph, invalid, parent).code,
      "endpoint-unavailable",
    );
  for (const option of ["accessible", "withoutStairs"])
    assert.equal(
      findNavigationRoute(graph, main, children[0][0], { [option]: true }).code,
      "accessibility-unverified",
    );
  assert.equal(
    findRoute(graph, { ...main, campusId: "v-86" }, parent).code,
    "different-campus",
  );
  assert.equal(findRoute(graph, main, main).code, "same-place");
  assert.equal(
    findRoute(graph, "missing", "missing").code,
    "endpoint-unavailable",
  );
});

test("multi-floor routes prefer the mapped LK2 chain while preserving real alternatives and original edge costs", () => {
  const start = roomId("Г-103-1");
  const shortest = findRoute(graph, start, parent, { preferStaircase: false });
  const preferred = findRoute(graph, start, parent);
  assertOriginalEdges(preferred);
  assert.deepEqual(
    preferred.transitions.map((transition) => transition.sourceEdgeId),
    gLk2,
  );
  assert.notDeepEqual(
    shortest.transitions.map((transition) => transition.sourceEdgeId),
    gLk2,
  );
  assert.ok(
    preferred.horizontalDistanceMeters > shortest.horizontalDistanceMeters,
  );
  assert.equal(preferred.diagnostics.stairPreferencePenalty, 0);
  assert.equal(preferred.distanceMeters, null);
  assert.deepEqual(
    findRoute(graph, parent, start).transitions.map(
      (transition) => transition.sourceEdgeId,
    ),
    gLk2.toReversed(),
  );
  for (const [from, to, expected] of [
    [
      "Б-110",
      "Б-409",
      ["v-78:edge:20716", "v-78:edge:20723", "v-78:edge:20742"],
    ],
    [
      "В-112",
      "В-421-4",
      ["v-78:edge:20715", "v-78:edge:20722", "v-78:edge:20741"],
    ],
  ]) {
    const route = findRoute(graph, roomId(from), roomId(to));
    assertOriginalEdges(route);
    assert.deepEqual(
      route.transitions.map((transition) => transition.sourceEdgeId),
      expected,
    );
  }
  const noLk2 = structuredClone(graph);
  for (const edge of noLk2.edges)
    if (gLk2.includes(edge.id)) edge.eligible = false;
  const alternative = findRoute(noLk2, start, parent);
  assertOriginalEdges(alternative, noLk2);
  assert.ok(
    alternative.transitions.every(
      (transition) => !gLk2.includes(transition.sourceEdgeId),
    ),
  );
  const unavailable = structuredClone(graph);
  for (const edge of unavailable.edges)
    if (main.sourceIds.includes(edge.id)) edge.eligible = false;
  assert.equal(
    findRoute(unavailable, main, parent).code,
    "endpoint-unavailable",
  );
});

test("the production worker accepts the unmodified main-stair search object and keeps the G424-4 parent contract", async () => {
  const previousFetch = globalThis.fetch,
    previousSelf = globalThis.self;
  const requests = [],
    messages = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    assert.equal(url, "/data/routing/v-78.json");
    return { ok: true, json: async () => graph };
  };
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import("../src/data/route-worker.js?main-stair-routing-test");
    await self.onmessage({
      data: {
        id: 41,
        from: main,
        to: search.find((place) => place.label === "Г-424-4"),
      },
    });
    assert.equal(messages[0].id, 41);
    assert.equal(messages[0].result.ok, true);
    assert.equal(messages[0].result.lastLeg.kind, "inside-parent");
    assert.equal(messages[0].result.end.roomId, parent);
    assert.equal(messages[0].result.requestedDestination.label, "Г-424-4");
    assert.deepEqual(requests, ["/data/routing/v-78.json"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test("both entrance stairs and their lower landings bind only to the four retained source portals", () => {
  const before = JSON.stringify(graph);
  for (const portal of entranceStairPortals) {
    const plan = read(`../public/data/campuses/v-78/${portal.floorId}.json`);
    const marker = getMapStairMarkers(plan).find(
      (candidate) => candidate.layoutId === portal.layoutId,
    );
    assert.ok(
      marker,
      "test the actual displayed marker, not a fabricated endpoint fixture",
    );
    const candidates = stairEndpointCandidates(graph, marker);
    assert.equal(candidates.length, 1);
    const sourceNode = graph.nodes.find(
      (node) => node.id === candidates[0].nodeId,
    );
    assert.equal(sourceNode.floorId, portal.floorId);
    assert.ok(
      Math.hypot(...sourceNode.position.map((n, i) => n - portal.position[i])) <
        0.001,
    );
    const route = findNavigationRoute(graph, marker, roomId("Г-424-4"));
    assertOriginalEdges(route);
    assert.equal(route.lastLeg.kind, "inside-parent");
    assert.deepEqual(route.start.point, sourceNode.position);
    assert.equal(route.end.roomId, parent);
    const stale = structuredClone(graph);
    stale.edges.find((edge) => edge.id === portal.sourceEdgeId).sourceId =
      "different-source-transition";
    assert.deepEqual(stairEndpointCandidates(stale, marker), []);
    const forged = {
      ...marker,
      id: "photo-stair:unregistered-runtime-stair",
      sourceIds: [portal.sourceEdgeId],
    };
    assert.equal(findRoute(graph, forged, parent).code, "endpoint-unavailable");
  }
  assert.equal(JSON.stringify(graph), before);
});
