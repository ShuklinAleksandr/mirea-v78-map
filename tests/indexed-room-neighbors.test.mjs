import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  indexedRoomGroup,
  indexedRoomNeighbors,
} from "../src/data/indexed-room-neighbors.js";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { partialRouteInfo, nextRouteReadout } from "../src/ui/next-route.js";

const rectangle = (x1, y1, x2, y2) => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];
function fixture(separator = "-") {
  const floorId = "v-78-test-floor";
  const graph = {
    campusId: "v-78",
    status: "available",
    units: "meters",
    floors: { [floorId]: {} },
    nodes: [],
    edges: [],
    rooms: {},
  };
  const node = (id, areaId, position, kind = "room") => {
    graph.nodes.push({
      id,
      areaId,
      floorId,
      position,
      kind,
      building: "А",
      physicalLevel: 2,
      sourceLevel: 2,
    });
  };
  const edge = (from, to, kind = "corridor") =>
    graph.edges.push({
      id: `${from}:${to}`,
      from,
      to,
      kind,
      cost: 1,
      eligible: true,
      bidirectional: true,
    });
  const room = (id, label, point, kind = "room") => {
    node(id, id, point, kind);
    graph.rooms[id] = {
      nodeId: id,
      label,
      floorId,
      kind,
      building: "А",
      physicalLevel: 2,
    };
  };
  room("from", "Вход", [0, -2], "entrance");
  room("base", "А-101", [6, 2]);
  room("target", `А-101${separator}1`, [10, 2]);
  room("sibling", `А-101${separator}2`, [14, 2]);
  for (const [id, x] of [
    ["base", 6],
    ["sibling", 14],
  ]) {
    node(`${id}-outside`, "hall", [x, -0.1], "corridor");
    node(`${id}-inside`, id, [x, 0.1], "room");
    edge("from", `${id}-outside`);
    edge(`${id}-outside`, `${id}-inside`, "door");
    edge(`${id}-inside`, id);
  }
  const floor = {
    id: floorId,
    campusId: "v-78",
    units: "meters",
    buildingLevels: { А: 2 },
    polygons: [
      {
        id: "base",
        kind: "room",
        building: "А",
        points: rectangle(4, 0, 8, 4),
      },
      {
        id: "target",
        kind: "room",
        building: "А",
        points: rectangle(8, 0, 12, 4),
      },
      {
        id: "sibling",
        kind: "room",
        building: "А",
        points: rectangle(12, 0, 16, 4),
      },
    ],
  };
  return { graph, floor, options: { floors: [floor] } };
}

test("an unavailable indexed destination routes only to the real door of an adjacent base room", () => {
  const { graph, floor, options } = fixture();
  const before = JSON.stringify({ graph, floor });
  assert.equal(findRoute(graph, "from", "target").ok, false);
  const route = findNavigationRoute(graph, "from", "target", options);
  assert.equal(route.ok, true);
  assert.equal(route.partial, true);
  assert.equal(route.end.roomId, "base");
  assert.equal(route.requestedDestination.roomId, "target");
  assert.equal(route.lastLeg.kind, "nearby-room");
  assert.equal(route.lastLeg.geometryAvailable, false);
  assert.equal(route.lastLeg.sharedBoundaryMeters, 4);
  assert.deepEqual(route.end.point, [6, 0]);
  assert.deepEqual(route.nodes.at(-1).sourceNodeIds, [
    "base-inside",
    "base-outside",
  ]);
  assert.equal(
    route.nodes.some((n) => n.id === "base"),
    false,
    "the drawn line ends at the door, before the neighbour's room anchor",
  );
  assert.equal(route.steps.at(-1).text, "Рядом с А-101-1");
  assert.equal(
    route.steps.some((step) => step.kind === "arrive"),
    false,
  );
  assert.equal(JSON.stringify({ graph, floor }), before);
});

test("an accessible different index is used when the adjacent base has no reachable door, including dot indices", () => {
  const { graph, options } = fixture(".");
  graph.edges = graph.edges.filter((edge) => !edge.id.includes("base"));
  const result = findNavigationRoute(graph, "from", "target", options);
  assert.equal(result.ok, true);
  assert.equal(result.end.roomId, "sibling");
  assert.equal(result.requestedDestination.label, "А-101.1");
  assert.deepEqual(result.end.point, [14, 0]);
  assert.equal(result.steps.at(-1).text, "Рядом с А-101.1");
});

test("numbers alone, corner contact, overlapping outlines, another wing or floor cannot establish adjacency", () => {
  const mutations = [
    ({ floor }) => {
      floor.polygons.find((p) => p.id === "base").points = rectangle(
        4,
        -4,
        8,
        0,
      );
      floor.polygons.find((p) => p.id === "sibling").points = rectangle(
        40,
        0,
        44,
        4,
      );
    },
    ({ floor }) => {
      floor.polygons.find((p) => p.id === "base").points = rectangle(
        4,
        0,
        10,
        4,
      );
      floor.polygons.find((p) => p.id === "sibling").points = rectangle(
        40,
        0,
        44,
        4,
      );
    },
    ({ floor }) => {
      for (const p of floor.polygons)
        if (p.id !== "target")
          p.points = p.points.map(([x, y]) => [x + 100, y]);
    },
    ({ graph }) => {
      graph.rooms.base.physicalLevel = graph.rooms.sibling.physicalLevel = 3;
    },
    ({ graph }) => {
      graph.rooms.base.floorId = graph.rooms.sibling.floorId =
        "other-source-plan";
    },
    ({ graph }) => {
      graph.rooms.base.building = graph.rooms.sibling.building = "Б";
    },
    ({ graph }) => {
      graph.rooms.base.label = "А-1101";
      graph.rooms.sibling.label = "А-1101-2";
    },
    ({ graph }) => {
      graph.rooms.target.label = "А-101";
    },
    ({ floor }) => {
      floor.polygons.find((p) => p.id === "target").points[0] = [NaN, 0];
    },
    ({ floor }) => {
      floor.units = "conditional";
    },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    assert.deepEqual(
      indexedRoomNeighbors(data.graph, "target", data.floor),
      [],
    );
    assert.equal(
      findNavigationRoute(data.graph, "from", "target", data.options).ok,
      false,
    );
  }
  const data = fixture();
  assert.equal(
    findNavigationRoute(data.graph, "from", "target").ok,
    false,
    "missing floor geometry is not replaced by a nearest number",
  );
});

test("a neighbour with no actual source doorway cannot substitute its interior anchor", () => {
  const { graph, options } = fixture();
  for (const edge of graph.edges)
    if (edge.kind === "door") edge.kind = "corridor";
  assert.equal(findRoute(graph, "from", "base").ok, true);
  assert.equal(findNavigationRoute(graph, "from", "target", options).ok, false);
});

test("existing exact routes and access/endpoint restrictions are not replaced by a neighbour", () => {
  const { graph, options } = fixture();
  for (const [from, extra] of [
    ["missing", {}],
    ["from", { accessible: true }],
    ["from", { withoutStairs: true }],
    [{ id: "from", campusId: "v-86" }, {}],
  ])
    assert.deepEqual(
      findNavigationRoute(graph, from, "target", { ...options, ...extra }),
      findRoute(graph, from, "target", { ...options, ...extra }),
    );
  assert.deepEqual(
    findNavigationRoute(graph, "from", "base", options),
    findRoute(graph, "from", "base", options),
  );
  const connected = structuredClone(graph);
  connected.edges.push({
    id: "actual-target-door",
    from: "base-outside",
    to: "target",
    kind: "door",
    cost: 1,
    eligible: true,
    bidirectional: true,
  });
  const exact = findRoute(connected, "from", "target", options);
  assert.equal(exact.ok, true);
  assert.deepEqual(
    findNavigationRoute(connected, "from", "target", options),
    exact,
  );
});

test("nearby presentation keeps normal guidance and a short truthful final phrase", () => {
  const { graph, options } = fixture();
  const route = findNavigationRoute(graph, "from", "target", options);
  const info = partialRouteInfo(route);
  assert.equal(info.instruction, "Рядом с А-101-1");
  assert.equal(info.completion, "Рядом с А-101-1");
  assert.equal(info.note, "");
  assert.equal(info.summary, "Вход → А-101-1");
  const readout = nextRouteReadout({
    route,
    to: { label: "А-101-1" },
    guiding: true,
    automatic: true,
    stepIndex: route.steps.length - 1,
    liveProgress: { status: "arrived", arrived: true },
  });
  assert.equal(readout.note, "");
  assert.match(readout.meta, /^А-101-1 · шаг/);
  assert.equal(readout.direction, "manual-entry");
  assert.equal(
    route.end.label,
    "А-101",
    "actual endpoint remains available in metadata",
  );
});

test("the real worker loads destination geometry after no-path and returns the same checked nearby route", async () => {
  const { graph, floor } = fixture();
  const previousFetch = globalThis.fetch,
    previousSelf = globalThis.self;
  const requests = [],
    messages = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () =>
        structuredClone(String(url).includes("/routing/") ? graph : floor),
    };
  };
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import("../src/data/route-worker.js?indexed-room-neighbor-test");
    await self.onmessage({
      data: {
        id: 17,
        from: { id: "from", campusId: "v-78" },
        to: { id: "target", campusId: "v-78" },
      },
    });
    assert.equal(messages[0].id, 17);
    assert.equal(messages[0].result.lastLeg.kind, "nearby-room");
    assert.equal(messages[0].result.end.roomId, "base");
    assert.deepEqual(requests, [
      "/data/routing/v-78.json",
      `/data/campuses/v-78/${floor.id}.json`,
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test("index grouping does not merge neighbouring but different base numbers", () => {
  assert.deepEqual(indexedRoomGroup("Б-209.1"), { key: "Б-209", index: "1" });
  assert.deepEqual(indexedRoomGroup("Г‑424‑3"), { key: "Г-424", index: "3" });
  assert.notEqual(
    indexedRoomGroup("Б-209.1").key,
    indexedRoomGroup("Б-2091").key,
  );
  assert.equal(indexedRoomGroup("Буфет"), null);
});

test("real А-228.1 uses the existing adjacent А-228 door without changing its missing entrance", () => {
  const read = (name) =>
    JSON.parse(readFileSync(new URL(name, import.meta.url)));
  const graph = read("../public/data/routing/v-78.json");
  const floor = read("../public/data/campuses/v-78/v-78-floor2.json");
  const from = "v-78--floor-2--9yb";
  const target = "v-78--floor-2--a0b";
  assert.equal(findRoute(graph, from, target).ok, false);
  const result = findNavigationRoute(graph, from, target, { floors: [floor] });
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.lastLeg.kind, "nearby-room");
  assert.equal(result.end.roomId, "v-78--floor-2--9yk");
  assert.equal(result.requestedDestination.roomId, target);
  assert.ok(result.lastLeg.sharedBoundaryMeters > 4);
  assert.equal(result.steps.at(-1).text, "Рядом с А-228.1");
  assert.deepEqual(result.nodes.at(-1).sourceNodeIds, [
    "v-78:floor-2:9zv:door:9q2",
    "v-78:floor-2:a0v:door:9q2",
  ]);
  const exactAfter = findRoute(graph, from, target);
  assert.equal(exactAfter.ok, false);
  assert.equal(exactAfter.reason, "target-isolated-source-component");
});
