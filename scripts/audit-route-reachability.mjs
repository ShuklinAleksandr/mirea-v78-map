import fs from "node:fs";
import { createHash } from "node:crypto";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { indexedRoomNeighbors } from "../src/data/indexed-room-neighbors.js";
import { withLibraryPassageGraph } from "../src/data/library-passage.js";
import { atNeighborDoor } from "../src/data/neighbor-door-route.js";
import { entranceHint } from "../src/data/entrance-hints.js";
import { getSurveyBlockedEdges } from "../src/data/survey-routing.js";
import { getStairPartitionBlockedEdges } from "../src/data/stair-partition-routing.js";
const out = process.argv[2] || ".native-build/route-coverage/latest";
fs.mkdirSync(out, { recursive: true });
const read = (p) => JSON.parse(fs.readFileSync(p));
const rawGraph = read("public/data/routing/v-78.json");
const graph = withLibraryPassageGraph(rawGraph);
const sourceFingerprints = Object.fromEntries(
  [
    "public/data/routing/v-78.json",
    ...[0, 1, 2, 3, 4].map(
      (n) => `public/data/campuses/v-78/v-78-floor${n}.json`,
    ),
    ...[
      "routing.js",
      "entrance-route.js",
      "indexed-room-neighbors.js",
      "neighbor-door-route.js",
      "library-passage.js",
      "library-passage-reference.json",
      "survey-routing.js",
      "stair-partition-routing.js",
    ].map((name) => `src/data/${name}`),
  ].map((path) => [
    path,
    createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
  ]),
);
const floors = [0, 1, 2, 3, 4].map((n) =>
  read(`public/data/campuses/v-78/v-78-floor${n}.json`),
);
const rooms = Object.entries(graph.rooms).map(([id, r], index) => ({
  id,
  index,
  ...r,
}));
const byRoom = new Map(rooms.map((r) => [r.id, r]));
const nodeIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
const publicKinds = new Set(["entrance", "circulation", "corridor", "hall"]);
const owner = graph.nodes.map((n) => {
  const r = byRoom.get(n.areaId);
  return r && !publicKinds.has(r.kind) ? r.id : null;
});
const blocked = new Set([
  ...getSurveyBlockedEdges(graph),
  ...getStairPartitionBlockedEdges(graph),
]);
const eligible = graph.edges.filter(
  (e) =>
    e.eligible &&
    !blocked.has(e.id) &&
    nodeIndex.has(e.from) &&
    nodeIndex.has(e.to) &&
    Number.isFinite(e.cost) &&
    e.cost >= 0,
);
if (eligible.some((e) => !e.bidirectional))
  throw Error(
    "Directed edges require a directed SCC audit; refusing undirected shortcut",
  );
if (rooms.some((r) => !nodeIndex.has(r.nodeId)))
  throw Error("Missing room endpoint");
if (new Set(rooms.map((r) => r.nodeId)).size !== rooms.length)
  throw Error("Shared anchors need separate same-node treatment");
const parent = graph.nodes.map((_, i) => i),
  rank = new Uint8Array(parent.length);
const root = (i) => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
};
const union = (a, b) => {
  a = root(a);
  b = root(b);
  if (a === b) return;
  if (rank[a] < rank[b]) [a, b] = [b, a];
  parent[b] = a;
  if (rank[a] === rank[b]) rank[a]++;
};
for (const e of eligible) {
  const a = nodeIndex.get(e.from),
    b = nodeIndex.get(e.to);
  if (owner[a] === owner[b]) union(a, b);
}
const componentRoots = new Map(),
  components = [];
const nodeComponent = graph.nodes.map((n, i) => {
  const r = root(i);
  if (!componentRoots.has(r)) {
    componentRoots.set(r, components.length);
    components.push({
      id: components.length,
      owner: owner[i],
      nodes: [],
      neighbors: new Set(),
      publicToOwner: new Map(),
    });
  }
  const c = componentRoots.get(r);
  components[c].nodes.push(i);
  return c;
});
for (const e of eligible) {
  const a = nodeComponent[nodeIndex.get(e.from)],
    b = nodeComponent[nodeIndex.get(e.to)];
  if (a !== b) {
    components[a].neighbors.add(b);
    components[b].neighbors.add(a);
  }
}
for (const c of components)
  if (c.owner === null)
    for (const b of c.neighbors) {
      const other = components[b];
      if (!c.publicToOwner.has(other.owner))
        c.publicToOwner.set(other.owner, []);
      c.publicToOwner.get(other.owner).push(b);
    }
for (const r of rooms) r.component = nodeComponent[nodeIndex.get(r.nodeId)];
const exactCache = new Int8Array(rooms.length * rooms.length);
const exactReach = (aId, bId) => {
  if (aId === bId) return false;
  const a = byRoom.get(aId),
    b = byRoom.get(bId);
  if (!a || !b) return false;
  const key = a.index * rooms.length + b.index;
  if (exactCache[key]) return exactCache[key] === 1;
  let ok = a.component === b.component;
  const seen = new Set([a.component]),
    queue = [a.component];
  for (let i = 0; !ok && i < queue.length; i++) {
    const c = components[queue[i]];
    const next =
      c.owner === null
        ? [
            ...(c.publicToOwner.get(a.id) || []),
            ...(c.publicToOwner.get(b.id) || []),
          ]
        : [...c.neighbors].filter(
            (n) =>
              components[n].owner === null ||
              components[n].owner === a.id ||
              components[n].owner === b.id,
          );
    for (const n of next) {
      if (n === b.component) {
        ok = true;
        break;
      }
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  exactCache[key] = exactCache[b.index * rooms.length + a.index] = ok ? 1 : -1;
  return ok;
};
// Source-component isolation exactly follows routing.js's diagnostic: all raw
// internal edges, including rejected ones, count; any raw exit prevents this label.
const rawAdj = graph.nodes.map(() => []),
  rawOutside = graph.nodes.map(() => false);
for (const e of graph.edges) {
  const a = nodeIndex.get(e.from),
    b = nodeIndex.get(e.to);
  if (a === undefined || b === undefined) continue;
  if (graph.nodes[a].areaId === graph.nodes[b].areaId) {
    rawAdj[a].push(b);
    rawAdj[b].push(a);
  } else {
    rawOutside[a] = true;
    rawOutside[b] = true;
  }
}
const isolated = new Map(),
  ownRawComponents = new Map();
for (const r of rooms) {
  const anchor = nodeIndex.get(r.nodeId),
    seen = new Set([anchor]),
    q = [anchor];
  for (let i = 0; i < q.length; i++)
    for (const n of rawAdj[q[i]])
      if (!seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
  isolated.set(r.id, !q.some((n) => rawOutside[n]));
  ownRawComponents.set(r.id, seen);
}
const neighborMap = new Map(
  rooms.map((r) => [
    r.id,
    indexedRoomNeighbors(
      graph,
      r.id,
      floors.find((f) => f.id === r.floorId),
    ),
  ]),
);
const fallbackRooms = new Set(
  [...neighborMap.values()].flat().map((c) => c.roomId),
);
for (const e of eligible) {
  const a = graph.nodes[nodeIndex.get(e.from)],
    b = graph.nodes[nodeIndex.get(e.to)];
  if (
    a.areaId !== b.areaId &&
    e.kind !== "door" &&
    (fallbackRooms.has(a.areaId) || fallbackRooms.has(b.areaId))
  )
    throw Error(
      "Fallback may use a non-door exit; requires exact path validation " +
        e.id,
    );
}
const zeroDoors = new Map(
  [...fallbackRooms].map((id) => [id, Boolean(atNeighborDoor(graph, id))]),
);
const destinationResolve = (from, to) => {
  if (from === to) return null;
  if (exactReach(from, to)) return { from, to, kind: "exact" };
  const r = byRoom.get(to),
    hint = entranceHint({ id: to }),
    via = hint && byRoom.get(hint.viaRoomId);
  if (
    isolated.get(to) &&
    via &&
    via.floorId === r.floorId &&
    (from === via.id || exactReach(from, via.id))
  )
    return { from, to: via.id, kind: "parent", zero: from === via.id };
  for (const c of neighborMap.get(to) || [])
    if (
      exactReach(from, c.roomId) ||
      (from === c.roomId && zeroDoors.get(c.roomId))
    )
      return {
        from,
        to: c.roomId,
        kind: "nearby-destination",
        zeroDoor: from === c.roomId,
      };
  return null;
};
const navigationResolve = (from, to) => {
  if (from === to) return null;
  const direct = destinationResolve(from, to);
  if (direct) return direct;
  for (const c of neighborMap.get(from) || []) {
    let route = destinationResolve(c.roomId, to);
    if (c.roomId === to && zeroDoors.get(c.roomId))
      route = { from: c.roomId, to, kind: "exact", zeroDoor: true };
    if (route?.zero && route.kind === "parent" && zeroDoors.get(c.roomId))
      route = { ...route, zero: false, zeroDoor: true };
    if (route && !route.zero)
      return {
        ...route,
        kind: route.kind === "exact" ? "nearby-origin" : "both-" + route.kind,
      };
  }
  return null;
};
const main = rooms.find((r) => r.id === "v-78--floor-2--9yb");
const mainRows = [],
  examples = [];
let formed = 0,
  comparisons = 0;
const describeFailure = (r) => {
  const own = ownRawComponents.get(r.id),
    external = [];
  for (const e of graph.edges) {
    const ai = nodeIndex.get(e.from),
      bi = nodeIndex.get(e.to);
    if (ai === undefined || bi === undefined) continue;
    const a = own.has(ai),
      b = own.has(bi);
    if (a === b) continue;
    const other = graph.nodes[a ? bi : ai];
    external.push({
      id: e.id,
      kind: e.kind,
      eligible: e.eligible,
      blocked: blocked.has(e.id),
      otherArea: other.areaId,
      otherLabel: graph.rooms[other.areaId]?.label || null,
    });
  }
  const allowed = external.filter((e) => e.eligible && !e.blocked);
  const publicExits = allowed.filter(
    (e) =>
      !graph.rooms[e.otherArea] ||
      publicKinds.has(graph.rooms[e.otherArea].kind),
  );
  return {
    reason: !external.length
      ? "no-source-exit"
      : !allowed.length
        ? "blocked-source-exit"
        : !publicExits.length
          ? "exit-only-through-another-room"
          : "separate-public-component",
    rawExitCount: external.length,
    eligibleExitCount: allowed.length,
    sourceComponentNodes: own.size,
    exits: external,
  };
};
for (const r of rooms) {
  if (r.id === main.id) {
    mainRows.push({
      ...r,
      status: "origin",
      exact: true,
      reachable: true,
      transitions: 0,
    });
    continue;
  }
  const exact = findRoute(graph, main.id, r.id),
    result = findNavigationRoute(graph, main.id, r.id, { floors }),
    predicted = navigationResolve(main.id, r.id);
  comparisons++;
  if (
    exact.ok !== exactReach(main.id, r.id) ||
    result.ok !== Boolean(predicted)
  )
    throw Error(`Main reachability disagrees with Dijkstra: ${r.label}`);
  if (result.ok) formed++;
  const status = exact.ok
    ? "exact"
    : result.ok
      ? result.lastLeg?.kind === "inside-parent"
        ? "parent"
        : "indexed-neighbor"
      : "unreachable";
  const row = {
    ...r,
    status,
    exact: exact.ok,
    reachable: result.ok,
    actualDestination: result.end?.roomId || null,
    viaLabel: result.end?.label || null,
    transitions: result.transitions?.length ?? null,
    sourceFloors: result.segments
      ? [...new Set(result.segments.map((s) => s.floorId))]
      : [],
    sourceFailure: result.ok
      ? null
      : {
          code: exact.code,
          reason: exact.reason || null,
          ...describeFailure(r),
        },
  };
  mainRows.push(row);
  if (result.ok && row.sourceFloors.length >= 3 && examples.length < 12)
    examples.push({
      roomId: r.id,
      label: r.label,
      sourceFloors: row.sourceFloors,
      transitions: result.transitions.map((t) => ({
        edge: t.sourceEdgeId,
        from: t.fromFloorId,
        to: t.toFloorId,
      })),
    });
  if (comparisons % 200 === 0) console.log("main checked", comparisons);
}
const counts = {};
const perRoom = rooms.map((r) => ({
  id: r.id,
  label: r.label,
  exactOutgoing: 0,
  reachableOutgoing: 0,
  exactIncoming: 0,
  reachableIncoming: 0,
}));
let pairs = 0,
  zeroDoorWaypoints = 0,
  parentRoomInstructions = 0;
let sampleChecks = 0;
for (const a of rooms) {
  for (const b of rooms) {
    if (a.id === b.id) continue;
    pairs++;
    const exact = exactReach(a.id, b.id),
      nav = navigationResolve(a.id, b.id);
    const key = nav?.kind || "unreachable";
    if (nav?.zeroDoor) zeroDoorWaypoints++;
    if (nav?.zero) parentRoomInstructions++;
    counts[key] = (counts[key] || 0) + 1;
    if (exact) {
      perRoom[a.index].exactOutgoing++;
      perRoom[b.index].exactIncoming++;
    }
    if (nav) {
      perRoom[a.index].reachableOutgoing++;
      perRoom[b.index].reachableIncoming++;
    }
    if (
      nav?.zeroDoor ||
      (a.index * rooms.length + b.index) % 12647 === 0 ||
      ((a.label === "А-177.1" || a.label === "Г-424-4") &&
        ["И-205-а", "И-200", "А-177.1", "Г-424-4"].includes(b.label))
    ) {
      const real = findNavigationRoute(graph, a.id, b.id, { floors });
      sampleChecks++;
      if (real.ok !== Boolean(nav))
        throw Error(
          `All-pairs reachability disagrees: ${a.label} -> ${b.label}`,
        );
    }
  }
  if (a.index % 250 === 0) console.log("all-pairs origins", a.index);
}
const summarize = (rows) => ({
  total: rows.length,
  ...Object.fromEntries(
    ["origin", "exact", "parent", "indexed-neighbor", "unreachable"].map(
      (s) => [s, rows.filter((r) => r.status === s).length],
    ),
  ),
});
const firstToFourth = [];
for (const building of ["А", "Б", "В", "Г", "Д"]) {
  const endpoints = [1, 4].map((level) =>
    mainRows.find(
      (r) =>
        r.building === building &&
        r.physicalLevel === level &&
        r.status === "exact" &&
        r.kind === "room",
    ),
  );
  if (!endpoints.every(Boolean)) continue;
  for (const [from, to] of [endpoints, [...endpoints].reverse()]) {
    const result = findRoute(graph, from.id, to.id);
    if (!result.ok || result.transitions.length < 3)
      throw Error(`First-to-fourth route failed: ${from.label} → ${to.label}`);
    firstToFourth.push({
      from: from.label,
      to: to.label,
      fromId: from.id,
      toId: to.id,
      sourceFloors: result.segments.map((s) => s.floorId),
      transitionEdges: result.transitions.map((t) => t.sourceEdgeId),
    });
  }
}
const summary = {
  checkedAt: new Date().toISOString(),
  sourceFingerprints,
  graphOverlay: {
    id: graph.userConfirmedLibraryPassage?.id || null,
    originalNodes: rawGraph.nodes.length,
    originalEdges: rawGraph.edges.length,
    addedNodes: graph.nodes.length - rawGraph.nodes.length,
    addedEdges: graph.edges.length - rawGraph.edges.length,
    addedEdgeSource: "user-confirmed-library-passage",
  },
  scope: {
    allNamedPlaces: rooms.length,
    kindRoom: rooms.filter((r) => r.kind === "room").length,
    numberedRoom: rooms.filter(
      (r) => r.kind === "room" && /^[А-ЯЁ]-\d/u.test(r.label),
    ).length,
    orderedDistinctPairs: pairs,
  },
  method: {
    allPairs:
      "Exact undirected component reachability with only origin+target private areas enabled; current eligible directed edge count is 0. Fallback candidates independently validate shared wall and every candidate external eligible edge is a source door. Zero-door waypoints checked separately through atNeighborDoor; these are not physical links between indexed rooms. No path through other rooms is permitted.",
    compressedComponents: components.length,
    publicComponents: components.filter((c) => c.owner === null).length,
    eligibleEdges: eligible.length,
    excludedEdges: graph.edges.length - eligible.length,
    dijkstraMainComparisons: comparisons,
    dijkstraPairSampleChecks: sampleChecks,
    formedRoutesFromMain: formed,
    firstToFourthDijkstraChecks: firstToFourth.length,
  },
  mainEntrance: {
    id: main.id,
    label: main.label,
    allPlaces: summarize(mainRows),
    kindRoom: summarize(mainRows.filter((r) => r.kind === "room")),
    numberedRooms: summarize(
      mainRows.filter((r) => r.kind === "room" && /^[А-ЯЁ]-\d/u.test(r.label)),
    ),
  },
  allPairs: counts,
  zeroLengthResults: { zeroDoorWaypoints, parentRoomInstructions },
  noExternalReachability: {
    outgoingZero: perRoom
      .filter((r) => r.reachableOutgoing === 0)
      .map((r) => r.id),
    incomingZero: perRoom
      .filter((r) => r.reachableIncoming === 0)
      .map((r) => r.id),
  },
  multiFloorExamples: examples,
  firstToFourth,
  perBuilding: Object.fromEntries(
    [...new Set(rooms.map((r) => r.building || "?"))].map((b) => [
      b,
      summarize(mainRows.filter((r) => (r.building || "?") === b)),
    ]),
  ),
};
fs.writeFileSync(out + "/summary.json", JSON.stringify(summary, null, 2));
fs.writeFileSync(
  out + "/rooms.json",
  JSON.stringify(
    mainRows.map((r, i) => ({ ...r, pairReachability: perRoom[i] })),
    null,
    2,
  ),
);
fs.writeFileSync(
  out + "/components.json",
  JSON.stringify(
    components.map((c) => ({
      id: c.id,
      owner: c.owner,
      nodes: c.nodes.length,
      floors: [...new Set(c.nodes.map((n) => graph.nodes[n].floorId))],
      neighborComponents: [...c.neighbors],
      namedRooms: rooms
        .filter((r) => r.component === c.id)
        .map((r) => ({ id: r.id, label: r.label })),
    })),
    null,
    2,
  ),
);
const csv = (rows) => {
  const fields = [
    "id",
    "label",
    "building",
    "physicalLevel",
    "floorId",
    "kind",
    "status",
    "viaLabel",
    "reason",
    "rawExitCount",
    "eligibleExitCount",
    "sourceComponentNodes",
    "exactOutgoing",
    "reachableOutgoing",
    "exactIncoming",
    "reachableIncoming",
  ];
  return (
    "\uFEFF" +
    fields.join(",") +
    "\n" +
    rows
      .map((r) => {
        const rr = { ...r, ...(r.sourceFailure || {}), ...perRoom[r.index] };
        return fields
          .map((k) => '"' + String(rr[k] ?? "").replaceAll('"', '""') + '"')
          .join(",");
      })
      .join("\n") +
    "\n"
  );
};
fs.writeFileSync(out + "/all-places.csv", csv(mainRows));
fs.writeFileSync(
  out + "/unreachable-from-main.csv",
  csv(mainRows.filter((r) => r.status === "unreachable")),
);
console.log(JSON.stringify(summary, null, 2));
