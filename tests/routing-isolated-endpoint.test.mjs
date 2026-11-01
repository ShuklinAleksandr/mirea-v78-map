import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { findRoute } from "../src/data/routing.js";

const graph = JSON.parse(
  readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
);
const target = "v-78--floor-3--cux";

test("G424-1 accurately explains its missing source entrance from known starting places", () => {
  const before = createHash("sha256")
    .update(JSON.stringify(graph))
    .digest("hex");
  for (const start of [
    "v-78--floor-0--200", // Г-103-1
    "v-78--floor-1--6dn", // Г-209
    "v-78--floor-2--9yb", // Главный вход
    "v-78--floor-3--cvi", // Г-424
  ]) {
    const result = findRoute(graph, start, target);
    assert.equal(result.ok, false);
    assert.equal(result.code, "no-path");
    assert.equal(result.reason, "target-isolated-source-component");
    assert.match(result.message, /Г-424-1.*нет подтверждённого входа/);
    assert.match(result.message, /Помещение есть на плане/);
    assert.equal(result.details.targetRoomId, target);
    assert.equal(result.details.floorId, "v-78-floor3");
    assert.equal(result.details.sourceComponentNodeCount, 10);
  }
  assert.equal(
    createHash("sha256").update(JSON.stringify(graph)).digest("hex"),
    before,
  );
});

test("the available route to G424 stays available and is not substituted for G424-1", () => {
  const route = findRoute(graph, "v-78--floor-0--200", "v-78--floor-3--cvi");
  assert.equal(route.ok, true);
  assert.equal(route.end.roomId, "v-78--floor-3--cvi");
  assert.ok(route.transitions.length >= 1);
});

function fixture(edges = []) {
  return {
    campusId: "fixture",
    units: "meters",
    status: "available",
    rooms: {
      from: { nodeId: "from-node", label: "From", floorId: "f1", kind: "room" },
      to: {
        nodeId: "to-node",
        label: "Destination",
        floorId: "f1",
        kind: "room",
      },
    },
    nodes: [
      { id: "from-node", areaId: "from", floorId: "f1", position: [0, 0] },
      { id: "to-node", areaId: "to", floorId: "f1", position: [10, 0] },
    ],
    edges,
  };
}

test("a real source doorway that is rejected or one-way never becomes a missing-entrance claim", () => {
  for (const edge of [
    {
      id: "blocked-door",
      from: "from-node",
      to: "to-node",
      eligible: false,
      bidirectional: true,
      kind: "door",
      cost: 10,
    },
    {
      id: "outbound-only",
      from: "to-node",
      to: "from-node",
      eligible: true,
      bidirectional: false,
      kind: "door",
      cost: 10,
    },
  ]) {
    const result = findRoute(fixture([edge]), "from", "to");
    assert.equal(result.code, "no-path");
    assert.equal(result.reason, undefined);
    assert.doesNotMatch(result.message, /нет подтверждённого входа/);
  }
});

test("isolation is diagnosed from source topology rather than a local connected flag or room name", () => {
  const data = fixture();
  data.rooms.to.connected = true;
  const result = findRoute(data, "from", "to");
  assert.equal(result.reason, "target-isolated-source-component");
  assert.match(result.message, /Destination/);
  assert.equal(result.details.sourceComponentNodeCount, 1);
});
