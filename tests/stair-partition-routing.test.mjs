import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import regions from "../src/data/stair-partitions.json" with { type: "json" };
import { getStairDisplayCutouts } from "../src/map/stairs.js";
import { segmentCrossesSurveyInterior } from "../src/data/survey-routing.js";
import { getStairPartitionView } from "../src/map/stair-partitions.js";
import {
  getStairOpeningBlockedEdges,
  getStairPartitionBlockedEdges,
  getStairPartitionRoutingReport,
} from "../src/data/stair-partition-routing.js";
import { findRoute } from "../src/data/routing.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const graph = read("../public/data/routing/v-78.json");

test("routing restrictions exactly match the nine rendered divider footprints and immutable source hashes", () => {
  const hash = (path) =>
    createHash("sha256")
      .update(readFileSync(new URL(path, import.meta.url)))
      .digest("hex");
  assert.equal(
    regions.sourceStairLayoutsSha256,
    hash("../public/data/stair-layouts.json"),
  );
  let count = 0;
  for (const [floorId, expected] of Object.entries(
    regions.sourceGeometrySha256,
  )) {
    assert.equal(
      expected,
      hash(`../public/data/campuses/v-78/${floorId}.json`),
    );
    const floor = read(`../public/data/campuses/v-78/${floorId}.json`);
    for (const partition of getStairPartitionView(floor).partitions) {
      const region = regions.regions.find(
        (region) => region.layoutId === partition.layoutId,
      );
      assert.ok(region);
      assert.equal(region.areaId, partition.polygonId);
      assert.deepEqual(region.points, partition.innerWall.wallPoints);
      count++;
    }
  }
  assert.equal(count, 9);
});

test("125 crossing horizontal edges are excluded without deleting source doors or vertical transitions", () => {
  const original = structuredClone(graph);
  const report = getStairPartitionRoutingReport(graph);
  const blocked = getStairPartitionBlockedEdges(graph);
  assert.equal(blocked.size, 125);
  assert.deepEqual(
    report.regions.map((region) => [
      region.layoutId,
      region.blockedEdgeIds.length,
    ]),
    [
      ["v78-Г-1-ЛК2", 15],
      ["v78-В-1-ЛК2", 14],
      ["v78-Б-1-ЛК2", 11],
      ["v78-Г-2-ЛК2", 18],
      ["v78-В-2-ЛК2", 20],
      ["v78-Б-2-ЛК2", 13],
      ["v78-Г-3-ЛК2", 15],
      ["v78-В-3-ЛК2", 10],
      ["v78-Б-3-ЛК2", 9],
    ],
  );
  for (const edge of graph.edges) {
    if (blocked.has(edge.id)) {
      assert.equal(edge.eligible, true);
      assert.equal(edge.kind, "corridor");
    }
    if (["stairs", "elevator", "lift", "door"].includes(edge.kind))
      assert.equal(
        blocked.has(edge.id),
        false,
        `${edge.id} keeps the original door/vertical connection`,
      );
  }
  assert.deepEqual(graph, original);
});

test("foreign or changed source packages never receive stale divider restrictions", () => {
  assert.equal(
    getStairPartitionBlockedEdges({ ...graph, campusId: "v-86" }).size,
    0,
  );
  const source = structuredClone(graph.source);
  source.stairLayoutsSha256 = "changed";
  assert.equal(getStairPartitionBlockedEdges({ ...graph, source }).size, 0);
  const oneChanged = structuredClone(graph.source);
  oneChanged.geometrySha256["v-78-floor1"] = "changed";
  const report = getStairPartitionRoutingReport({
    ...graph,
    source: oneChanged,
  });
  assert.ok(report.regions.every((region) => region.floorId !== "v-78-floor1"));
  assert.equal(report.blockedEdgeIds.length, 85);
  assert.deepEqual(getStairPartitionRoutingReport(null), {
    blockedEdgeIds: [],
    regions: [],
  });
});

test("G-103-1 to G-209 retains an original valid route after excluding divider conflicts, without inventing a detour", () => {
  const sourceEdges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const blocked = getStairPartitionBlockedEdges(graph);
  const restricted = structuredClone(graph);
  for (const edge of restricted.edges)
    if (blocked.has(edge.id)) edge.eligible = false;
  const result = findRoute(
    restricted,
    "v-78--floor-0--200",
    "v-78--floor-1--6dn",
  );
  assert.equal(result.ok, true);
  assert.ok(result.edges.length > 0);
  for (const edge of result.edges) {
    assert.ok(
      sourceEdges.has(edge.id),
      "every path edge existed in the original graph",
    );
    assert.ok(!blocked.has(edge.id));
    assert.equal(
      edge.cost,
      sourceEdges.get(edge.id).cost,
      "routing never invents a cheaper shortcut",
    );
  }
  assert.deepEqual(
    result.transitions.map((t) => t.sourceEdgeId),
    ["v-78:edge:20714"],
  );
});

test("A-209 to Г-213 follows the hall floor around the A-154 stair opening in both directions", () => {
  const floor = read("../public/data/campuses/v-78/v-78-floor2.json");
  const [region] = regions.openings;
  const opening = getStairDisplayCutouts(floor).find(
    (cutout) => cutout.layoutId === region.layoutId,
  );
  assert.deepEqual(region.points, opening.points);
  assert.equal(region.sourceSha256, opening.sourceSha256);
  assert.deepEqual(opening.sourcePolygonIds, [region.areaId]);
  const blocked = getStairOpeningBlockedEdges(graph);
  assert.equal(blocked.size, 46);
  for (const edge of ["v-78:edge:29560", "v-78:edge:29589"])
    assert.ok(
      blocked.has(edge),
      "the previous horizontal route crossed the opening",
    );
  assert.equal(
    getStairOpeningBlockedEdges({ ...graph, campusId: "v-86" }).size,
    0,
  );
  const a209 = "v-78--floor-2--a01",
    g213 = "v-78--floor-1--6ds";
  for (const [from, to] of [
    [a209, g213],
    [g213, a209],
  ]) {
    const route = findRoute(graph, from, to);
    assert.equal(route.ok, true);
    for (const section of route.segments.filter((s) => s.floorId === floor.id))
      for (let i = 1; i < section.points.length; i++)
        assert.equal(
          segmentCrossesSurveyInterior(
            section.points[i - 1],
            section.points[i],
            opening.points,
          ),
          false,
        );
  }
  const portal = "v-78:floor-2:9zz:portal:adb";
  const approaches = graph.edges.filter(
    (edge) =>
      edge.eligible &&
      edge.kind === "corridor" &&
      [edge.from, edge.to].includes(portal) &&
      !blocked.has(edge.id),
  );
  assert.equal(approaches.length, 3);
  assert.equal(blocked.has("v-78:edge:20725"), false);
});
