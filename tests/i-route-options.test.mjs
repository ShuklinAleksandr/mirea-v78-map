import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findRoute } from "../src/data/routing.js";
import { findIRouteOptions } from "../src/data/i-route-options.js";
import { AI_OUTDOOR_PASSAGE } from "../src/data/outdoor-passage.js";
import { LIBRARY_PASSAGE_EDGE_ID } from "../src/data/library-passage.js";

const graph = JSON.parse(
  readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
);
const floors = [0, 1, 2, 3, 4].map((n) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${n}.json`,
        import.meta.url,
      ),
    ),
  ),
);
const id = (label) =>
  Object.entries(graph.rooms).find(([, room]) => room.label === label)?.[0];
const onStreet = (route) =>
  route.graphNodes.some((node) => node.areaId === AI_OUTDOOR_PASSAGE.id);

test("I routes offer two actual disjoint access choices, preserving the requested indexed origin", () => {
  for (const label of [
    "Главный вход",
    "А-177.1",
    "Г-209",
    "В-301",
    "Б-301",
    "Д-204",
  ]) {
    const from = id(label);
    assert.ok(from, label);
    const result = findIRouteOptions(graph, from, id("И-205-а"), { floors });
    assert.equal(result.ok, true, label);
    assert.deepEqual(
      result.routeOptions?.map((option) => option.id),
      ["library", "street"],
      label,
    );
    const [inside, outside] = result.routeOptions.map((option) => option.route);
    assert.ok(inside.edges.some((edge) => edge.id === LIBRARY_PASSAGE_EDGE_ID));
    assert.equal(onStreet(inside), false, `${label}: indoor route uses street`);
    assert.equal(onStreet(outside), true);
    assert.ok(
      !outside.edges.some((edge) => edge.id === LIBRARY_PASSAGE_EDGE_ID),
    );
    assert.notDeepEqual(
      inside.graphNodes.map((node) => node.id),
      outside.graphNodes.map((node) => node.id),
    );
    for (const route of [inside, outside]) {
      assert.equal(route.end.roomId, id("И-205-а"));
      if (label === "А-177.1") {
        assert.equal(route.requestedOrigin.roomId, from);
        assert.equal(route.firstLeg.geometryAvailable, false);
        assert.equal(route.steps[0].text, "Начните у входа в А-177");
      }
    }
  }
});

test("unreachable origins, other destinations and routes within I never get pretend choices", () => {
  for (const [a, b] of [
    ["И-200", "И-205-а"],
    ["Главный вход", "Г-209"],
  ]) {
    const result = findIRouteOptions(graph, id(a), id(b), { floors });
    assert.equal(result.ok, true);
    assert.equal(result.routeOptions, undefined);
  }
  const e = Object.entries(graph.rooms).find(
    ([, room]) => room.building === "Е" && room.kind === "room",
  );
  assert.ok(e);
  const missing = findIRouteOptions(graph, e[0], id("И-205-а"), { floors });
  assert.equal(missing.ok, false);
  assert.equal(missing.routeOptions, undefined);
});

test("blocking both existing entrances cannot return an invented I path or mutate the graph", () => {
  const original = JSON.stringify(graph);
  const street = new Set(
    graph.nodes
      .filter((node) => node.areaId === AI_OUTDOOR_PASSAGE.id)
      .map((node) => node.id),
  );
  const blockedEdgeIds = [
    LIBRARY_PASSAGE_EDGE_ID,
    ...graph.edges
      .filter((edge) => street.has(edge.from) || street.has(edge.to))
      .map((edge) => edge.id),
  ];
  const result = findRoute(graph, id("Главный вход"), id("И-205-а"), {
    blockedEdgeIds,
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(graph), original);
});
