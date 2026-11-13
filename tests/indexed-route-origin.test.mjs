import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { findIRouteOptions } from "../src/data/i-route-options.js";
import { indexedRoomNeighbors } from "../src/data/indexed-room-neighbors.js";

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const graph = read("../public/data/routing/v-78.json");
const floors = [0, 1, 2, 3, 4].map((n) =>
  read(`../public/data/campuses/v-78/v-78-floor${n}.json`),
);
const options = { floors };
const id = (label) =>
  Object.keys(graph.rooms).find((key) => graph.rooms[key].label === label);
const origin = id("А-177.1");
const neighbor = id("А-177");
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const graphBefore = fingerprint(graph);
const floorsBefore = fingerprint(floors);
const doorway = (node) => {
  assert.equal(node.kind, "door");
  assert.equal(node.sourceNodeIds.length, 2);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "door" &&
        node.sourceNodeIds.includes(edge.from) &&
        node.sourceNodeIds.includes(edge.to),
    ),
    "display endpoint belongs to an actual source doorway",
  );
};

test("А177.1 and А177 share only a real-door waypoint when there is no measured route between them", () => {
  for (const [from, to] of [
    [origin, neighbor],
    [neighbor, origin],
  ]) {
    const result = findNavigationRoute(graph, from, to, options);
    assert.equal(result.ok, true);
    assert.equal(result.sharedNeighborDoor, true);
    assert.equal(result.nodes.length, 1);
    doorway(result.nodes[0]);
    assert.equal(result.start.roomId, neighbor);
    assert.equal(result.end.roomId, neighbor);
    assert.equal(result.distanceMeters, null);
    assert.equal(result.durationMinutes, null);
  }
});

test("all confirmed Г424 indexed siblings share a real parent doorway without fabricating internal geometry", () => {
  const children = ["Г-424-1", "Г-424-2", "Г-424-3", "Г-424-4", "Г-424.5"].map(
    id,
  );
  for (const from of children)
    for (const to of children) {
      if (from === to) continue;
      const route = findNavigationRoute(graph, from, to, options);
      assert.equal(
        route.ok,
        true,
        `${graph.rooms[from].label} → ${graph.rooms[to].label}`,
      );
      assert.equal(route.nodes.length, 1);
      doorway(route.nodes[0]);
      assert.equal(route.requestedOrigin.roomId, from);
      assert.equal(route.requestedDestination.roomId, to);
      assert.equal(route.firstLeg.geometryAvailable, false);
      assert.equal(route.lastLeg.kind, "inside-parent");
      assert.equal(route.lastLeg.geometryAvailable, false);
      assert.equal(route.distanceMeters, null);
      assert.equal(route.durationMinutes, null);
      assert.match(route.steps.at(-1).text, /^Войдите в Г-424\./);
    }
});

test("real unavailable letter indices use only existing shared-wall neighbouring doors", () => {
  const main = "v-78--floor-2--9yb";
  for (const label of [
    "А-101-В",
    "Б-216-а",
    "Г-322-б",
    "Г-322-г",
    "И-204-в",
    "И-203-б",
    "А-415-а",
    "А-415-б",
  ]) {
    const target = id(label);
    assert.ok(target, label);
    assert.equal(findRoute(graph, main, target).ok, false);
    for (const [from, to] of [
      [main, target],
      [target, main],
    ]) {
      const route = findNavigationRoute(graph, from, to, options);
      assert.equal(route.ok, true, `${from} → ${to}`);
      assert.equal((route.firstLeg || route.lastLeg).geometryAvailable, false);
      doorway(from === main ? route.nodes.at(-1) : route.nodes[0]);
    }
  }
  assert.equal(fingerprint(graph), graphBefore);
  assert.equal(fingerprint(floors), floorsBefore);
});

test("А177.1 starts at the shared-wall neighbour's existing doorway for И200/205а/205б; the street and exact target remain intact", () => {
  const candidates = indexedRoomNeighbors(graph, origin, floors[1]);
  assert.deepEqual(
    candidates.map((item) => item.roomId),
    [neighbor],
  );
  assert.ok(candidates[0].sharedBoundaryMeters > 7.99);
  for (const label of ["И-200", "И-205-а", "И-205-б"]) {
    const target = id(label);
    assert.equal(findRoute(graph, origin, target).ok, false);
    const result = findNavigationRoute(graph, origin, target, options);
    const reference = findRoute(graph, neighbor, target);
    assert.equal(result.ok, true, label);
    assert.equal(result.partial, true);
    assert.equal(result.requestedOrigin.roomId, origin);
    assert.equal(result.firstLeg.geometryAvailable, false);
    assert.equal(result.firstLeg.viaRoomId, neighbor);
    assert.equal(result.originStatus, "nearby-door-only");
    assert.equal(result.start.roomId, neighbor);
    assert.equal(result.end.roomId, target);
    assert.equal(result.lastLeg, undefined);
    assert.equal(result.steps[0].text, "Начните у входа в А-177");
    assert.equal(result.steps.at(-1).kind, "arrive");
    assert.deepEqual(result.nodes, reference.nodes);
    assert.deepEqual(result.edges, reference.edges);
    assert.deepEqual(result.segments, reference.segments);
    assert.ok(!result.nodes.some((node) => node.areaId === origin));
    doorway(result.nodes[0]);
    doorway(result.nodes.at(-1));
    assert.ok(result.steps.some((step) => step.environment === "outdoor"));
    assert.ok(
      result.steps.some((step) => step.text === "Войдите с улицы в корпус И"),
    );
    assert.equal(result.transitions[0].sourceEdgeId, "v-78:edge:20736");
    const reverse = findNavigationRoute(graph, target, origin, options);
    assert.equal(reverse.ok, true);
    assert.equal(reverse.start.roomId, target);
    assert.equal(reverse.end.roomId, neighbor);
    assert.equal(reverse.requestedDestination.roomId, origin);
    assert.equal(reverse.firstLeg, undefined);
    doorway(reverse.nodes.at(-1));
  }
});

test("fallback at both ends keeps the confirmed Г424 destination relationship and reverses through real entrances", () => {
  const parent = id("Г-424");
  for (const label of ["Г-424-1", "Г-424-2", "Г-424-3", "Г-424-4"]) {
    const target = id(label);
    const result = findNavigationRoute(graph, origin, target, options);
    assert.equal(result.ok, true, label);
    assert.equal(result.requestedOrigin.roomId, origin);
    assert.equal(result.requestedDestination.roomId, target);
    assert.equal(result.firstLeg.geometryAvailable, false);
    assert.equal(result.lastLeg.kind, "inside-parent");
    assert.equal(result.lastLeg.geometryAvailable, false);
    assert.equal(result.start.roomId, neighbor);
    assert.equal(result.end.roomId, parent);
    assert.deepEqual(result.edges, findRoute(graph, neighbor, parent).edges);
    assert.ok(
      !result.nodes.some((node) => [origin, target].includes(node.areaId)),
    );
    doorway(result.nodes[0]);
    doorway(result.nodes.at(-1));
    const reverse = findNavigationRoute(graph, target, origin, options);
    assert.equal(reverse.ok, true, `${label} reverse`);
    assert.equal(reverse.requestedOrigin.roomId, target);
    assert.equal(reverse.requestedDestination.roomId, origin);
    assert.equal(reverse.firstLeg.geometryAvailable, false);
    assert.equal(reverse.lastLeg.geometryAvailable, false);
    assert.equal(reverse.start.roomId, parent);
    assert.equal(reverse.end.roomId, neighbor);
    doorway(reverse.nodes[0]);
    doorway(reverse.nodes.at(-1));
  }
  assert.equal(fingerprint(graph), graphBefore);
  assert.equal(fingerprint(floors), floorsBefore);
});

test("missing geometry, a separated outline, wrong floor, no source door and existing restrictions never produce a guessed starting connector", () => {
  const target = id("И-205-а");
  assert.equal(findNavigationRoute(graph, origin, target).ok, false);
  for (const mutate of [
    (floor) => {
      const p = floor.polygons.find((item) => item.id === neighbor);
      p.points = p.points.map(([x, y]) => [x + 20, y]);
    },
    (floor) => {
      floor.buildingLevels.А = 2;
    },
    (floor) => {
      floor.units = "pixels";
    },
  ]) {
    const floor = structuredClone(floors[1]);
    mutate(floor);
    assert.equal(
      findNavigationRoute(graph, origin, target, { floors: [floor] }).ok,
      false,
    );
  }
  const noDoor = {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.kind === "door" ? { ...edge, kind: "corridor" } : edge,
    ),
  };
  assert.equal(findRoute(noDoor, neighbor, target).ok, true);
  assert.equal(findNavigationRoute(noDoor, origin, target, options).ok, false);
  for (const [from, extra] of [
    [origin, { accessible: true }],
    [origin, { withoutStairs: true }],
    [{ id: origin, campusId: "v-86" }, {}],
    ["missing-source-room", {}],
  ])
    assert.deepEqual(
      findNavigationRoute(graph, from, target, { ...options, ...extra }),
      findRoute(graph, from, target, { ...options, ...extra }),
    );
  for (const from of [neighbor, id("А-178")])
    for (const label of ["И-200", "И-205-а", "И-205-б"])
      assert.deepEqual(
        findNavigationRoute(graph, from, id(label), options),
        findRoute(graph, from, id(label)),
        "available exact routes stay untouched",
      );
});

test("the actual route worker loads both indexed endpoint plans after no-path and supports the same UI requests", async () => {
  const previousFetch = globalThis.fetch;
  const previousSelf = globalThis.self;
  const requests = [];
  const messages = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    const floor = floors.find((item) =>
      String(url).endsWith(`/${item.id}.json`),
    );
    return {
      ok: Boolean(floor || String(url).includes("/routing/")),
      json: async () => structuredClone(floor || graph),
    };
  };
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import("../src/data/route-worker.js?indexed-origin-real-data");
    for (const [from, to] of [
      [origin, id("Г-424-4")],
      [origin, id("И-205-а")],
      [id("И-205-а"), origin],
      [id("Г-424-4"), origin],
    ]) {
      await self.onmessage({
        data: {
          id: messages.length + 1,
          from: { id: from, campusId: "v-78" },
          to: { id: to, campusId: "v-78" },
        },
      });
      const result = messages.at(-1).result;
      assert.equal(result.ok, true);
      assert.deepEqual(result, findIRouteOptions(graph, from, to, options));
    }
    assert.deepEqual(requests, [
      "/data/routing/v-78.json",
      "/data/campuses/v-78/v-78-floor3.json",
      "/data/campuses/v-78/v-78-floor1.json",
      "/data/campuses/v-78/v-78-floor2.json",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});
