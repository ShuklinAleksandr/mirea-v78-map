import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { entranceHint } from "../src/data/entrance-hints.js";
import { makeCurrentRouteEndpoint } from "../src/data/current-route-origin.js";
import { createRouteGuidance } from "../src/map/route-guidance.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const graph = read("../public/data/routing/v-78.json");
const main = "v-78--floor-2--9yb";
const parent = "v-78--floor-3--cvi";
const children = ["cux", "cv0", "cv1", "cvf", "cv6"].map(
  (suffix) => `v-78--floor-3--${suffix}`,
);

test("all five confirmed G424 rooms get only the existing path to their common entrance", () => {
  const snapshot = JSON.stringify(graph);
  const expected = findRoute(graph, main, parent);
  assert.equal(expected.ok, true);
  for (const id of children) {
    assert.equal(findRoute(graph, main, id).ok, false);
    const route = findNavigationRoute(graph, main, { id, campusId: "v-78" });
    assert.equal(route.ok, true);
    assert.equal(route.partial, true);
    assert.deepEqual(route.end, expected.end);
    assert.equal(route.end.roomId, parent);
    assert.equal(route.requestedDestination.roomId, id);
    assert.equal(route.requestedDestination.floorId, "v-78-floor3");
    assert.equal(route.lastLeg.geometryAvailable, false);
    assert.equal(route.lastLeg.viaRoomId, parent);
    assert.equal(route.steps.at(-1).kind, "manual-entry");
    assert.ok(route.steps.at(-1).text.includes(graph.rooms[id].label));
    assert.equal(
      route.steps.some((step) => step.kind === "arrive"),
      false,
    );
    assert.deepEqual(route.graphNodes, expected.graphNodes);
    assert.deepEqual(route.edges, expected.edges);
    assert.deepEqual(route.segments, expected.segments);
    assert.deepEqual(route.transitions, expected.transitions);
    assert.equal(route.durationMinutes, expected.durationMinutes);
    assert.match(route.durationModel, /только до входа в Г-424/);
    assert.equal(route.distanceStatus, "parent-entrance-only");
    assert.ok(createRouteGuidance(route).sections.length > 0);
    assert.equal(entranceHint({ roomId: id }).viaRoomId, parent);
  }
  assert.equal(
    JSON.stringify(graph),
    snapshot,
    "the graph is never repaired by a guessed door",
  );
});

test("already in G424: only an explicit indoor instruction, no fabricated movement", () => {
  const route = findNavigationRoute(graph, parent, children[2]);
  assert.equal(route.ok, true);
  assert.equal(route.partial, true);
  assert.equal(route.start.roomId, parent);
  assert.equal(route.end.roomId, parent);
  assert.equal(route.edges.length, 0);
  assert.equal(route.steps.length, 1);
  assert.equal(route.steps[0].kind, "manual-entry");
  assert.match(route.steps[0].text, /^Вы в Г-424\. Найдите Г-424-3/);
  assert.equal(route.distanceMeters, 0);
  const guidance = createRouteGuidance(route);
  assert.equal(guidance.sections.length, 1);
  assert.equal(guidance.sections[0].length, 0);
});

test("exact routes, unrelated failures, access restrictions and invalid endpoints remain unchanged", () => {
  const unrelated = Object.entries(graph.rooms).find(
    ([, room]) => room.label === "А-424-3",
  )[0];
  for (const [from, to, options] of [
    [main, parent, {}],
    [main, unrelated, {}],
    [main, children[2], { withoutStairs: true }],
    [main, children[2], { accessible: true }],
    ["missing", children[2], {}],
    [{ id: main, campusId: "v-86" }, children[2], {}],
    [children[2], children[2], {}],
    [children[2], main, {}],
  ])
    assert.deepEqual(
      findNavigationRoute(graph, from, to, options),
      findRoute(graph, from, to, options),
    );
  assert.equal(entranceHint({ id: unrelated }), null);
});

test("an explicitly blocked inner door cannot be replaced by a confirmed-parent fallback", () => {
  const data = structuredClone(graph);
  data.edges.push({
    id: "blocked-inner-door",
    from: data.rooms[parent].nodeId,
    to: data.rooms[children[2]].nodeId,
    kind: "door",
    bidirectional: true,
    eligible: false,
    cost: 1,
  });
  const route = findNavigationRoute(data, main, children[2]);
  assert.equal(route.ok, false);
  assert.equal(route.partial, undefined);
  assert.equal(route.code, "no-path");
});

test("a valid current-position origin keeps its checked local connector when heading to the parent entrance", () => {
  const floor = read("../public/data/campuses/v-78/v-78-floor0.json");
  const room = floor.polygons.find((polygon) => polygon.label === "Г-103-1");
  const now = 1000000;
  const made = makeCurrentRouteEndpoint(
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
  );
  assert.equal(made.ok, true);
  const options = { floors: [floor] };
  const expected = findRoute(graph, made.endpoint, parent, options);
  const route = findNavigationRoute(graph, made.endpoint, children[2], options);
  assert.equal(route.ok, true);
  assert.equal(route.partial, true);
  assert.equal(route.start.endpointKind, "user-location");
  assert.equal(route.start.roomId, null);
  assert.deepEqual(route.edges, expected.edges);
  assert.deepEqual(
    route.diagnostics.localConnectorIds,
    expected.diagnostics.localConnectorIds,
  );
});
