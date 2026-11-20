import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { findIRouteOptions } from "../src/data/i-route-options.js";
import { withLibraryPassageGraph } from "../src/data/library-passage.js";
import { getSurveyBlockedEdges } from "../src/data/survey-routing.js";
import { getStairBlockedEdges } from "../src/data/stair-partition-routing.js";
import { createRouteTrackingSurfaceGuard } from "../src/data/route-tracking-surface.js";
import { LIBRARY_PASSAGE_EDGE_ID } from "../src/data/library-passage.js";
import { AI_OUTDOOR_PASSAGE } from "../src/data/outdoor-passage.js";
import { auditRouteEndpoints } from "./lib/audit-route-endpoints.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const graph = withLibraryPassageGraph(read("public/data/routing/v-78.json"));
const floors = Object.keys(graph.floors).map((id) =>
  read(`public/data/campuses/v-78/${id}.json`),
);
const places = auditRouteEndpoints(
  graph,
  read("public/data/search-index.json"),
  floors,
);
const options = { floors, walkingFloors: floors };
const forbidden = new Set([
  ...getSurveyBlockedEdges(graph),
  ...getStairBlockedEdges(graph),
]);
const same = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
const codes = [
  "same-place",
  "exact",
  "partial",
  "no-path",
  "endpoint-unavailable",
  "error",
];
const publicKinds = new Set(["entrance", "circulation", "corridor", "hall"]);
const checkedChords = new Set();
const surfaces = new Map(
  floors.map((f) => [
    f.id,
    createRouteTrackingSurfaceGuard(f, { requireSourceArea: true }),
  ]),
);

function verifyRoute(route) {
  if (
    !route.segments?.length ||
    route.graphNodes.length !== route.edges.length + 1
  )
    throw Error("Incomplete source chain");
  const allowed = new Set([
    route.start.roomId,
    route.end.roomId,
    route.graphNodes[0].areaId,
    route.graphNodes.at(-1).areaId,
  ]);
  const graphIndices = new Map();
  for (const [i, node] of route.graphNodes.entries()) {
    graphIndices.set(node.id, i);
    if (
      graph.rooms[node.areaId] &&
      !publicKinds.has(graph.rooms[node.areaId].kind) &&
      !allowed.has(node.areaId)
    )
      throw Error("Path crosses unrelated room " + node.areaId);
  }
  if (route.routeOptionId) {
    const library = route.edges.some((e) => e.id === LIBRARY_PASSAGE_EDGE_ID);
    const street = route.graphNodes.some(
      (n) => n.areaId === AI_OUTDOOR_PASSAGE.id,
    );
    if (library === street || (route.routeOptionId === "library") !== library)
      throw Error("Wrong passage for selected alternative");
  }
  for (const [i, edge] of route.edges.entries()) {
    const a = route.graphNodes[i].id,
      b = route.graphNodes[i + 1].id;
    if (
      !edge.eligible ||
      forbidden.has(edge.id) ||
      !(
        (a === edge.from && b === edge.to) ||
        (edge.bidirectional && b === edge.from && a === edge.to)
      )
    )
      throw Error("Invalid source edge " + edge.id);
  }
  if (
    !same(route.start.point, route.segments[0].points[0]) ||
    !same(route.end.point, route.segments.at(-1).points.at(-1))
  )
    throw Error("Wrong endpoint");
  if (route.transitions.length + 1 !== route.segments.length)
    throw Error("Wrong number of floor sections");
  let distance = 0,
    visible = 0;
  for (const [index, segment] of route.segments.entries()) {
    if (
      !segment.points.length ||
      segment.points.length !== segment.nodes.length
    )
      throw Error("Invalid segment size");
    for (const [i, point] of segment.points.entries()) {
      const node = segment.nodes[i];
      if (
        !same(point, node.position) ||
        !point.every(Number.isFinite) ||
        node.floorId !== segment.floorId ||
        route.nodes[visible++]?.id !== node.id
      )
        throw Error("Invalid walking point");
      if (i)
        distance += Math.hypot(
          point[0] - segment.points[i - 1][0],
          point[1] - segment.points[i - 1][1],
        );
      if (i && segment.straightened) {
        const a = segment.nodes[i - 1],
          from = graphIndices.get(a.id),
          to = graphIndices.get(node.id);
        if (from == null || to == null || to === from + 1) continue;
        const key = a.id + "|" + node.id;
        if (!checkedChords.has(key)) {
          if (
            to <= from ||
            a.areaId !== node.areaId ||
            !surfaces.get(segment.floorId)(
              a.position,
              node.position,
              node.areaId,
            )
          )
            throw Error("Invalid corridor shortcut " + key);
          checkedChords.add(key);
        }
      }
    }
    if (index) {
      const t = route.transitions[index - 1],
        prev = route.segments[index - 1];
      if (
        t.fromFloorId !== prev.floorId ||
        t.toFloorId !== segment.floorId ||
        !same(t.point, prev.points.at(-1)) ||
        !same(t.targetPoint, segment.points[0])
      )
        throw Error("Disconnected transition");
    }
  }
  if (
    visible !== route.nodes.length ||
    (route.horizontalDistanceMeters != null &&
      Math.abs(distance - route.horizontalDistanceMeters) > 1e-6)
  )
    throw Error("Inconsistent distance or visible point count");
  for (const step of route.steps)
    if (
      !step.text ||
      !step.position.every(Number.isFinite) ||
      !route.segments.some(
        (s) =>
          s.floorId === step.floorId &&
          s.points.some((p) => same(p, step.position)),
      )
    )
      throw Error("Instruction outside walking route");
}

function auditRow(index) {
  const from = places[index],
    statuses = Buffer.alloc(places.length);
  const errors = [],
    counts = Object.fromEntries(codes.map((c) => [c, 0]));
  let variants = 0,
    straightened = 0;
  for (const [i, to] of places.entries()) {
    let code;
    try {
      const r = findIRouteOptions(graph, from, to, options);
      if (r.ok) {
        if (from.id === to.id)
          throw Error("Identical endpoints produced a route");
        const routes = r.routeOptions?.map((item) => item.route) || [r];
        if (r.routeOptions) {
          if (
            r.routeOptions[0].id !== "library" ||
            r.routeOptions[1]?.id !== "street" ||
            routes.length !== 2
          )
            throw Error("Invalid route options");
          variants++;
        }
        for (const route of routes) {
          verifyRoute(route);
          if (
            (route.requestedOrigin?.roomId || route.start.roomId) !== from.id ||
            (route.requestedDestination?.roomId || route.end.roomId) !== to.id
          )
            throw Error("Wrong requested origin/destination");
        }
        if (routes.some((item) => item.segments.some((s) => s.straightened)))
          straightened++;
        code =
          r.partial || r.requestedOrigin || r.requestedDestination
            ? "partial"
            : "exact";
      } else {
        code = r.code;
        if (from.id === to.id && code === "endpoint-unavailable") {
          // A display-only marker cannot serve as a routable endpoint.
        } else if ((code === "same-place") !== (from.id === to.id))
          throw Error("Incorrect same-place response");
        if (!r.message || !codes.includes(code) || code === "error")
          throw Error("Unexpected failure " + code);
      }
    } catch (error) {
      code = "error";
      if (errors.length < 8)
        errors.push({ from: from.id, to: to.id, message: error.message });
    }
    counts[code]++;
    statuses[i] = codes.indexOf(code);
  }
  return { index, counts, variants, straightened, errors, statuses };
}

if (!isMainThread) {
  parentPort.on("message", (index) => {
    if (index === "close") parentPort.close();
    else parentPort.postMessage(auditRow(index));
  });
} else {
  const dir = path.resolve(process.argv[2] || ".native-build/all-routes");
  fs.mkdirSync(dir, { recursive: true });
  const count = places.length;
  if (new Set(places.map((p) => p.id)).size !== count)
    throw Error("Duplicate endpoint ID");
  fs.writeFileSync(
    path.join(dir, "endpoints.json"),
    JSON.stringify(
      places.map(({ id, label, kind, floorId }) => ({
        id,
        label,
        kind,
        floorId,
      })),
      null,
      2,
    ),
  );
  const summary = {
    endpoints: count,
    distinctPairs: count * (count - 1),
    selfPairs: count,
    codes,
    counts: Object.fromEntries(codes.map((c) => [c, 0])),
    pairsWithBothOptions: 0,
    pairsWithStraightening: 0,
    checkedRows: 0,
    errors: [],
  };
  const matrix = Buffer.alloc(count * count),
    rowSummaries = [];
  let next = 0;
  const start = Date.now();
  const workers = Math.min(
    count,
    Number(process.argv[3]) || Math.min(10, os.availableParallelism()),
  );
  console.log(`Checking ${count} × ${count} routes on ${workers} workers`);
  await Promise.all(
    Array.from(
      { length: workers },
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url));
          worker.on("error", reject);
          worker.once("exit", (code) =>
            code === 0 ? resolve() : reject(Error("Worker exit " + code)),
          );
          worker.on("message", (row) => {
            Buffer.from(row.statuses).copy(matrix, row.index * count);
            delete row.statuses;
            rowSummaries[row.index] = row;
            summary.checkedRows++;
            for (const c of codes) summary.counts[c] += row.counts[c];
            summary.pairsWithBothOptions += row.variants;
            summary.pairsWithStraightening += row.straightened;
            if (summary.errors.length < 100) summary.errors.push(...row.errors);
            if (row.errors.length && summary.errors.length <= 20)
              console.error(row.errors[0]);
            if (summary.checkedRows % 25 === 0 || summary.checkedRows === count)
              console.log(
                `Rows ${summary.checkedRows}/${count}, errors ${summary.counts.error}, elapsed ${Math.round((Date.now() - start) / 1000)}s`,
              );
            if (next < count) worker.postMessage(next++);
            else worker.postMessage("close");
          });
          worker.postMessage(next++);
        }),
    ),
  );
  summary.elapsedSeconds = Math.round((Date.now() - start) / 1000);
  if (process.argv[4]) {
    const catalog = read(path.join(process.argv[4], "rooms.json"));
    const expected = fs.readFileSync(
      path.join(process.argv[4], "expected-pairs.bin"),
    );
    const positions = new Map(places.map((p, i) => [p.id, i]));
    let compared = 0,
      mismatches = 0;
    if (expected.length !== catalog.length ** 2)
      throw Error("Incorrect oracle size");
    for (const from of catalog) {
      for (const to of catalog) {
        if (from.id === to.id) continue;
        const want = expected[from.index * catalog.length + to.index];
        const actual =
          matrix[positions.get(from.id) * count + positions.get(to.id)];
        if (actual !== want) {
          mismatches++;
          if (summary.errors.length < 100)
            summary.errors.push({
              from: from.id,
              to: to.id,
              expected: codes[want],
              actual: codes[actual],
            });
        }
        compared++;
      }
    }
    summary.independentComparisons = compared;
    summary.independentMismatches = mismatches;
  }
  fs.writeFileSync(path.join(dir, "matrix.bin"), matrix);
  const names = places.map(
    (p) => '"' + (p.id + " " + (p.label || p.kind)).replaceAll('"', '""') + '"',
  );
  const csv = ["Откуда / Куда;" + names.join(";")];
  for (const [i, name] of names.entries())
    csv.push(
      name + ";" + matrix.subarray(i * count, (i + 1) * count).join(";"),
    );
  fs.writeFileSync(
    path.join(dir, "matrix.csv.gz"),
    gzipSync("\ufeff" + csv.join("\r\n")),
  );
  fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(rowSummaries));
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  if (
    summary.counts.error ||
    summary.independentMismatches ||
    summary.checkedRows !== count
  )
    process.exitCode = 1;
}
