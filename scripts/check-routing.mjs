#!/usr/bin/env node
/** Deterministic, stratified real-data route QA. Timings are desktop Node only. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { findRoute } from "../src/data/routing.js";

const root = new URL("../", import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, root)));
const hash = (file) =>
  createHash("sha256")
    .update(readFileSync(new URL(file, root)))
    .digest("hex");
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cost = (route) => route.edges.reduce((sum, edge) => sum + edge.cost, 0);
const vertical = (edge) => ["stairs", "lift", "elevator"].includes(edge.kind);
let seed = 20261020;
const random = () =>
  (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const sampleCount = 300;
const report = {
  schemaVersion: 1,
  seed,
  scope:
    "Deterministic stratified room-pair sample; success fraction is not a coverage guarantee.",
  runtime: {
    version: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
  },
  timingLimitations:
    "Desktop Node route computation only; excludes JSON transfer, UI, GPU, phone and simulator performance.",
  generatedAt: new Date().toISOString(),
  campuses: {},
};
let passedRoutes = 0;
const pointOnSegment = (p, a, b) => {
  const length = distance(a, b);
  if (length < 1e-10) return distance(p, a) < 0.0001;
  return Math.abs(distance(a, p) + distance(p, b) - length) < 0.0001;
};

function checkRoute(route, graph, fromId, toId) {
  assert.equal(route.graphNodes[0].id, graph.rooms[fromId].nodeId);
  assert.equal(route.graphNodes.at(-1).id, graph.rooms[toId].nodeId);
  assert.equal(route.graphNodes.length, route.edges.length + 1);
  for (let i = 0; i < route.edges.length; i++) {
    const edge = route.edges[i],
      a = route.graphNodes[i],
      b = route.graphNodes[i + 1];
    assert.equal(edge.eligible, true);
    assert.ok(
      (edge.from === a.id && edge.to === b.id) ||
        (edge.bidirectional && edge.to === a.id && edge.from === b.id),
    );
    if (a.floorId !== b.floorId) assert.ok(vertical(edge));
  }
  for (const segment of route.segments) {
    assert.ok(segment.nodes.every((node) => node.floorId === segment.floorId));
    assert.equal(segment.nodes.length, segment.points.length);
    for (let i = 1; i < segment.points.length; i++) {
      const a = segment.points[i - 1],
        b = segment.points[i];
      // Every visible line must be a subset of an actual horizontal source
      // edge, including clipped first/last doorways. No smoothed corner cuts.
      assert.ok(
        route.edges.some(
          (edge, j) =>
            !vertical(edge) &&
            route.graphNodes[j].floorId === segment.floorId &&
            pointOnSegment(
              a,
              route.graphNodes[j].position,
              route.graphNodes[j + 1].position,
            ) &&
            pointOnSegment(
              b,
              route.graphNodes[j].position,
              route.graphNodes[j + 1].position,
            ),
        ),
      );
    }
  }
  const concatenated = route.segments.flatMap((segment) => segment.nodes);
  assert.deepEqual(concatenated, route.nodes);
  assert.equal(route.transitions.length, route.segments.length - 1);
  assert.equal(route.steps[0].kind, "start");
  assert.equal(route.steps.at(-1).kind, "arrive");
  for (const transition of route.transitions)
    assert.ok(
      route.edges.some(
        (edge) => edge.id === transition.sourceEdgeId && vertical(edge),
      ),
    );
  if (route.transitions.length) assert.equal(route.distanceMeters, null);
  assert.ok(Number.isFinite(route.horizontalDistanceMeters));
  assert.ok(Number.isFinite(route.durationMinutes));
  assert.equal(route.navigationMode, "manual");
  const allowedRooms = new Set([fromId, toId]);
  for (const node of route.graphNodes) {
    const room = graph.rooms[node.areaId];
    assert.ok(
      !room ||
        allowedRooms.has(node.areaId) ||
        ["entrance", "circulation", "corridor", "hall"].includes(room.kind),
    );
  }
  passedRoutes++;
}

for (const campus of ["v-78", "v-86", "s-20", "mp-1"]) {
  const readStarted = performance.now();
  const graph = read(`public/data/routing/${campus}.json`);
  const jsonReadAndParseMilliseconds = performance.now() - readStarted;
  assert.equal(graph.source.sha256, hash(graph.source.file));
  assert.equal(
    graph.source.stairLayoutsSha256,
    hash("public/data/stair-layouts.json"),
  );
  for (const [floorId, expected] of Object.entries(graph.source.geometrySha256))
    assert.equal(
      expected,
      hash(`public/data/campuses/${campus}/${floorId}.json`),
    );
  if (campus === "mp-1") {
    assert.equal(findRoute(graph, "a", "b").code, "graph-unavailable");
    report.campuses[campus] = {
      status: "unavailable",
      sourceNodes: graph.nodes.length,
      truthfulFailure: true,
    };
    continue;
  }
  const roomIds = Object.keys(graph.rooms).sort();
  const allBidirectional = graph.edges
    .filter((e) => e.eligible)
    .every((e) => e.bidirectional);
  const neighbours = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (!edge.eligible) continue;
    neighbours.get(edge.from).push(edge.to);
    if (edge.bidirectional) neighbours.get(edge.to).push(edge.from);
  }
  const component = new Map();
  if (allBidirectional)
    for (const node of graph.nodes) {
      if (component.has(node.id)) continue;
      const queue = [node.id];
      component.set(node.id, node.id);
      for (let i = 0; i < queue.length; i++)
        for (const next of neighbours.get(queue[i])) {
          if (component.has(next)) continue;
          component.set(next, node.id);
          queue.push(next);
        }
    }
  const pairs = [];
  const keys = new Set();
  const groups = [
    ["same-floor", (a, b) => a.floorId === b.floorId],
    ["different-floor", (a, b) => a.floorId !== b.floorId],
    [
      "different-building",
      (a, b) => a.building && b.building && a.building !== b.building,
    ],
  ];
  for (const [category, predicate] of groups) {
    let accepted = 0;
    for (
      let attempt = 0;
      attempt < 100000 && accepted < sampleCount;
      attempt++
    ) {
      const a = roomIds[Math.floor(random() * roomIds.length)];
      const b = roomIds[Math.floor(random() * roomIds.length)];
      if (a === b || !predicate(graph.rooms[a], graph.rooms[b])) continue;
      const key = [a, b].sort().join("|");
      if (keys.has(key)) continue;
      keys.add(key);
      pairs.push({ a, b, category });
      accepted++;
    }
  }
  const times = [];
  const summary = {
    sourceNodes: graph.nodes.length,
    sourceEdges: graph.edges.length,
    roomAnchors: roomIds.length,
    allEligibleEdgesBidirectional: allBidirectional,
    checkedDirections: pairs.length * 2,
    success: 0,
    failure: 0,
    errors: {},
    categories: {},
    sampledEndpointFloors: [],
    sourceFloorCount: Object.keys(graph.floors).length,
    successfulTransitions: 0,
    successfulSameLevelStairs: 0,
    successfulExamples: [],
    jsonReadAndParseMilliseconds,
    noPathCause: {
      differentSourceComponents: 0,
      restrictedIntermediateRooms: 0,
    },
  };
  const sampledFloors = new Set();
  for (const { a, b, category } of pairs) {
    let forward;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      sampledFloors.add(graph.rooms[from].floorId);
      sampledFloors.add(graph.rooms[to].floorId);
      const before = performance.now();
      const route = findRoute(graph, from, to);
      times.push(performance.now() - before);
      summary.categories[category] ||= { success: 0, failure: 0 };
      if (route.ok) {
        checkRoute(route, graph, from, to);
        summary.success++;
        summary.categories[category].success++;
        summary.successfulTransitions += route.transitions.length;
        summary.successfulSameLevelStairs += route.transitions.filter(
          (t) => t.fromFloorId === t.toFloorId,
        ).length;
        if (summary.successfulExamples.length < 9)
          summary.successfulExamples.push({
            fromId: from,
            toId: to,
            from: graph.rooms[from].label,
            to: graph.rooms[to].label,
            sourceEdges: route.edges.length,
            transitions: route.transitions.length,
            distanceMeters: route.distanceMeters,
            durationMinutes: route.durationMinutes,
          });
      } else {
        summary.failure++;
        summary.categories[category].failure++;
        summary.errors[route.code] = (summary.errors[route.code] || 0) + 1;
        assert.equal(route.code, "no-path");
        if (allBidirectional) {
          const separated =
            component.get(graph.rooms[from].nodeId) !==
            component.get(graph.rooms[to].nodeId);
          summary.noPathCause[
            separated
              ? "differentSourceComponents"
              : "restrictedIntermediateRooms"
          ]++;
        }
      }
      if (from === a) forward = route;
      else if (allBidirectional) {
        assert.equal(route.ok, forward.ok);
        if (route.ok)
          assert.ok(Math.abs(cost(route) - cost(forward)) < 0.00001);
      }
    }
  }
  summary.firstRouteMilliseconds = times[0];
  times.sort((a, b) => a - b);
  summary.sampledEndpointFloors = [...sampledFloors].sort();
  assert.equal(sampledFloors.size, Object.keys(graph.floors).length);
  summary.computeMilliseconds = {
    minimum: times[0],
    median: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    p99: times[Math.floor(times.length * 0.99)],
    maximum: times.at(-1),
  };
  report.campuses[campus] = summary;
  process.stdout.write(
    `${campus}: ${summary.checkedDirections} directions, ${summary.success} successful, ${summary.failure} honest no-path; median ${summary.computeMilliseconds.median.toFixed(2)} ms, p95 ${summary.computeMilliseconds.p95.toFixed(2)} ms\n`,
  );
}
report.validatedSuccessfulRoutes = passedRoutes;
writeFileSync(
  new URL("analysis/routing-runtime-qa.json", root),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(
  `PASS: ${passedRoutes} successful source paths checked; report analysis/routing-runtime-qa.json\n`,
);
