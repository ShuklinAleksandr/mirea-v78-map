import { resolveSavedMapPlace } from "../src/data/saved-map-place.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditRouteEndpoints } from "../scripts/lib/audit-route-endpoints.mjs";
import { hasRouteEndpoint } from "../src/data/route-endpoint-availability.js";
import { stairEndpointCandidates } from "../src/data/stair-routing.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
test("map cards and the routing graph agree about every selectable V-78 anchor", () => {
  const graph = read("../public/data/routing/v-78.json");
  const floors = [0, 1, 2, 3, 4].map((i) =>
    read("../public/data/campuses/v-78/v-78-floor" + i + ".json"),
  );
  const endpoints = auditRouteEndpoints(
    graph,
    read("../public/data/search-index.json"),
    floors,
  );
  const available = new Set();
  for (const p of endpoints) {
    const enabled = hasRouteEndpoint(
      p,
      p.auditSources.includes("search") ? p : null,
      floors.find((f) => f.id === p.floorId),
    );
    assert.equal(
      enabled,
      Boolean(graph.rooms[p.id] || stairEndpointCandidates(graph, p)?.length),
      p.id,
    );
    if (enabled) available.add(p.id);
  }
  assert.ok(endpoints.some((p) => p.id === "v-78-floor2-area-24"));
  assert.equal(available.has("v-78-floor2-area-24"), false);
  assert.ok(available.has("photo-stair:v78-Д-scan-v-78-floor2"));
  assert.ok(
    available.has("v-78--floor-3--cv1"),
    "A catalogued room may still use a confirmed parent entrance",
  );
});

test("favorites and share links can reopen an unnamed map surface, catalogue room, and the scanned Д landing", () => {
  const floors = [1, 2, 3].map((i) =>
    read("../public/data/campuses/v-78/v-78-floor" + i + ".json"),
  );
  const search = read("../public/data/search-index.json");
  const room = search.find((p) => p.id === "v-78--floor-3--cv1");
  assert.equal(resolveSavedMapPlace(room.id, search, floors, floors[0]), room);
  const polygon = resolveSavedMapPlace(
    "v-78-floor2-area-24",
    search,
    floors,
    floors[0],
  );
  assert.equal(polygon.id, "v-78-floor2-area-24");
  assert.equal(polygon.floorId, "v-78-floor2");
  assert.equal(polygon.label, "Точка · уровень 2 плана");
  const marker = resolveSavedMapPlace(
    "photo-stair:v78-Д-scan-v-78-floor2",
    search,
    floors,
    floors[0],
  );
  assert.ok(marker.sourceIds.includes("v-78:edge:20724"));
  for (const preferred of floors.slice(0, 2)) {
    const found = resolveSavedMapPlace(
      "v-78:edge:20724",
      search,
      floors,
      preferred,
    );
    assert.equal(found.floorId, preferred.id);
    assert.ok(found.sourceIds.includes("v-78:edge:20724"));
  }
  assert.equal(
    resolveSavedMapPlace("removed-object", search, floors, floors[0]),
    null,
  );
});
