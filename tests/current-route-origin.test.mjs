import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  makeCurrentRouteEndpoint,
  attachCurrentRouteEndpoint,
} from "../src/data/current-route-origin.js";
import { findRoute } from "../src/data/routing.js";
const now = 1_000_000;
const manual = (point = [2, 5]) => ({
  source: "manual",
  campusId: "fixture",
  floorId: "f1",
  building: "Г",
  physicalLevel: 2,
  floorEvidence: "manual",
  point,
  timestamp: now,
});
const rectangle = (x1, y1, x2, y2) => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];
function fixture() {
  const floor = {
    campusId: "fixture",
    id: "f1",
    level: 1,
    buildingLevels: { Г: 2 },
    walls: [],
    doors: [],
    polygons: [
      {
        id: "hall",
        kind: "corridor",
        building: "Г",
        points: rectangle(0, 0, 20, 10),
        holes: [],
      },
      {
        id: "dest",
        kind: "room",
        building: "Г",
        points: rectangle(20, 0, 30, 10),
        holes: [],
      },
    ],
  };
  const graph = {
    campusId: "fixture",
    status: "source-graph",
    units: "meters",
    floors: { f1: { level: 1, buildingLevels: { Г: 2 } } },
    nodes: [
      {
        id: "h0",
        areaId: "hall",
        position: [5, 5],
        floorId: "f1",
        building: "Г",
        physicalLevel: 2,
        sourceLevel: 1,
      },
      {
        id: "h",
        areaId: "hall",
        position: [10, 5],
        floorId: "f1",
        building: "Г",
        physicalLevel: 2,
        sourceLevel: 1,
      },
      {
        id: "d",
        areaId: "dest",
        roomId: "dest",
        position: [24, 5],
        floorId: "f1",
        building: "Г",
        physicalLevel: 2,
        sourceLevel: 1,
      },
    ],
    edges: [
      {
        id: "h0h",
        from: "h0",
        to: "h",
        kind: "corridor",
        eligible: true,
        bidirectional: false,
        cost: 5,
      },
      {
        id: "hd",
        from: "h",
        to: "d",
        kind: "door",
        eligible: true,
        bidirectional: false,
        cost: 14,
      },
    ],
    rooms: {
      dest: { nodeId: "d", label: "Назначение", floorId: "f1", kind: "room" },
    },
  };
  return { floor, graph };
}
const endpoint = (location = manual()) =>
  makeCurrentRouteEndpoint(location, { now }).endpoint;

test("current origin is a fresh explicit-floor snapshot, not a fake catalogue room", () => {
  const location = manual();
  const made = makeCurrentRouteEndpoint(location, { now });
  assert.equal(made.ok, true);
  assert.equal(made.endpoint.kind, "user-location");
  assert.equal(made.endpoint.id, undefined);
  assert.notEqual(made.endpoint.location.point, location.point);
  const gps = {
    ...location,
    source: "gps",
    trackingStatus: "live",
    expiresAt: now + 60_000,
  };
  assert.equal(makeCurrentRouteEndpoint(gps, { now }).ok, true);
  assert.equal(
    makeCurrentRouteEndpoint({ ...gps, floorEvidence: "unknown" }, { now })
      .code,
    "location-floor-unknown",
  );
  assert.equal(
    makeCurrentRouteEndpoint(
      { ...gps, floorEvidence: "manual-view-selection" },
      { now },
    ).ok,
    true,
  );
  assert.equal(
    makeCurrentRouteEndpoint(
      { ...gps, timestamp: now - 61_000, expiresAt: now - 1000 },
      { now },
    ).code,
    "location-unavailable",
  );
  assert.equal(
    makeCurrentRouteEndpoint({ ...gps, trackingStatus: "signal-lost" }, { now })
      .ok,
    false,
  );
});

test("a corridor point joins only its containing source area and keeps graph immutable", () => {
  const { floor, graph } = fixture();
  const before = JSON.stringify(graph);
  const start = endpoint();
  const route = findRoute(
    graph,
    start,
    { id: "dest", campusId: "fixture" },
    { floors: [floor] },
  );
  assert.equal(route.ok, true);
  assert.deepEqual(route.start.point, [2, 5]);
  assert.equal(route.start.roomId, null);
  assert.equal(route.start.endpointKind, "user-location");
  assert.equal(route.graphNodes[1].endpointKind, "source-edge-projection");
  assert.equal(route.distanceMeters, 15); // 3 m local connector + 5 m source corridor + 7 m to actual doorway
  assert.equal(route.diagnostics.localConnectorIds.length, 1);
  assert.equal(JSON.stringify(graph), before);
  assert.equal(graph.rooms["user-location:from"], undefined);
});

test("walls and closed door lines block local attachment even when the nearest graph node is in the same area", () => {
  for (const key of ["walls", "doors"]) {
    const { floor, graph } = fixture();
    floor[key] = [{ a: [5, 0], b: [5, 10] }];
    assert.equal(
      attachCurrentRouteEndpoint(graph, endpoint(), floor).code,
      "location-connector-unavailable",
      key,
    );
  }
});

test("a hole or concave notch cannot hide between two inside endpoints", () => {
  const a = fixture();
  a.floor.polygons[0].holes = [rectangle(4, 4, 6, 6)];
  assert.equal(
    attachCurrentRouteEndpoint(a.graph, endpoint(), a.floor).code,
    "location-connector-unavailable",
  );
  const b = fixture();
  b.floor.polygons[0].points = [
    [0, 0],
    [10, 0],
    [10, 10],
    [7, 10],
    [7, 3],
    [3, 3],
    [3, 10],
    [0, 10],
  ];
  b.graph.nodes[0].position = [8, 7];
  b.graph.nodes[1].position = [9, 7];
  assert.equal(
    attachCurrentRouteEndpoint(b.graph, endpoint(manual([2, 7])), b.floor).code,
    "location-connector-unavailable",
  );
});

test("a point outside all areas never attaches to an adjacent room or a nearby node", () => {
  const { floor, graph } = fixture();
  assert.equal(
    attachCurrentRouteEndpoint(graph, endpoint(manual([-0.1, 5])), floor).code,
    "location-area-unavailable",
  );
  for (const node of graph.nodes)
    if (node.areaId === "hall") node.areaId = "different-room";
  assert.equal(
    attachCurrentRouteEndpoint(graph, endpoint(), floor).code,
    "location-connector-unavailable",
  );
});

test("a selected source plan cannot move an A2 origin onto the known G3 portion of that plan", () => {
  const { floor, graph } = fixture();
  floor.buildingLevels = { А: 2, Г: 3 };
  assert.equal(
    attachCurrentRouteEndpoint(
      graph,
      endpoint({ ...manual(), building: "А", physicalLevel: 2 }),
      floor,
    ).code,
    "location-context-mismatch",
  );
  assert.equal(
    attachCurrentRouteEndpoint(
      graph,
      endpoint({ ...manual(), physicalLevel: 2 }),
      floor,
    ).code,
    "location-context-mismatch",
  );
  assert.equal(
    attachCurrentRouteEndpoint(graph, endpoint(), { ...floor, id: "other" })
      .code,
    "location-floor-unavailable",
  );
});

test("an existing one-way source connection remains one-way for a free endpoint", () => {
  const { floor, graph } = fixture();
  assert.equal(
    findRoute(graph, endpoint(), "dest", { floors: [floor] }).ok,
    true,
  );
  assert.equal(
    findRoute(graph, "dest", endpoint(), { floors: [floor] }).code,
    "no-path",
  );
});

test("a real G103-1 manual pin routes to G209 from its actual point without modifying archived graph", () => {
  const read = (path) =>
    JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url)));
  const graph = read("public/data/routing/v-78.json"),
    floor = read("public/data/campuses/v-78/v-78-floor0.json");
  const room = floor.polygons.find((p) => p.label === "Г-103-1");
  assert.ok(room);
  const start = makeCurrentRouteEndpoint(
    {
      source: "manual",
      campusId: "v-78",
      floorId: floor.id,
      building: "Г",
      physicalLevel: 1,
      floorEvidence: "manual",
      point: room.center,
      timestamp: now,
    },
    { now },
  ).endpoint;
  const before = JSON.stringify(graph);
  const route = findRoute(graph, start, "v-78--floor-1--6dn", {
    floors: [floor],
  });
  assert.equal(route.ok, true);
  assert.deepEqual(route.start.point, room.center);
  assert.equal(route.start.roomId, null);
  assert.equal(route.transitions.length, 1);
  assert.equal(route.end.label, "Г-209");
  assert.equal(JSON.stringify(graph), before);
});

test("attachment preserves direction on an internal corridor instead of connecting backward to another visible node", () => {
  const { floor, graph } = fixture();
  const start = endpoint(manual([9, 5]));
  // Add a destination reachable only from the upstream end of h0 -> h.
  graph.nodes.push({
    id: "upstream-destination",
    floorId: "f1",
    areaId: "upstream",
    position: [24, 6],
    building: "Г",
    physicalLevel: 2,
    sourceLevel: 1,
  });
  graph.rooms.upstream = {
    nodeId: "upstream-destination",
    label: "Upstream",
    kind: "room",
    floorId: "f1",
  };
  graph.edges.push({
    id: "upstream-exit",
    from: "h0",
    to: "upstream-destination",
    kind: "door",
    eligible: true,
    bidirectional: false,
    cost: 19,
  });
  assert.equal(
    findRoute(graph, start, "upstream", { floors: [floor] }).code,
    "no-path",
  );
  assert.equal(findRoute(graph, start, "dest", { floors: [floor] }).ok, true);
  graph.edges[0].bidirectional = true;
  assert.equal(
    findRoute(graph, start, "upstream", { floors: [floor] }).ok,
    true,
  );
});
