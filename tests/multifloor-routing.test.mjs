import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findRoute } from "../src/data/routing.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";
import { createRouteTracker } from "../src/data/route-tracking.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
} from "../src/map/route-guidance.js";

const graph = JSON.parse(
  readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
);
const start = "v-78--floor-0--200"; // Г-103-1, physical floor 1
const parent = "v-78--floor-3--cvi"; // Г-424, physical floor 4
const child = "v-78--floor-3--cv1"; // Г-424-3, inside Г-424
const floors = [0, 1, 2, 3].map((index) => `v-78-floor${index}`);

test("the real G103-1 to G424 path retains all four physical floors in both directions", () => {
  const sourceEdges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const reverse of [false, true]) {
    const route = findRoute(
      graph,
      reverse ? parent : start,
      reverse ? start : parent,
    );
    assert.equal(route.ok, true);
    assert.deepEqual(
      route.segments.map((segment) => segment.floorId),
      reverse ? floors.toReversed() : floors,
    );
    assert.deepEqual(
      route.segments.map((segment) => segment.nodes[0].physicalLevel),
      reverse ? [4, 3, 2, 1] : [1, 2, 3, 4],
    );
    assert.equal(route.transitions.length, 3);
    assert.equal(
      route.steps.filter((step) => step.kind === "stairs").length,
      3,
    );
    for (const transition of route.transitions) {
      const source = sourceEdges.get(transition.sourceEdgeId);
      assert.ok(
        source?.eligible,
        "each transition must retain its original eligible source edge",
      );
      assert.equal(source.kind, "stairs");
      assert.notEqual(transition.fromFloorId, transition.toFloorId);
    }
  }
});

test("four-floor guidance waits at every stair until the user confirms the next section", () => {
  const route = findRoute(graph, start, parent);
  const guide = createRouteGuidance(route);
  const tracker = createRouteTracker(route);
  assert.equal(guide.sections.length, 4);
  let tick = 0;
  const observe = (point, floorId) => {
    const timestamp = 1_800_000_000_000 + ++tick * 1_000;
    return tracker.update(
      {
        source: "gps",
        status: "inside",
        campusId: "v-78",
        point,
        timestamp,
        accuracyMeters: 3,
        accuracyRadiusMap: 3,
        trackingStatus: "live",
      },
      { now: timestamp, floorId },
    );
  };
  for (let index = 0; index < guide.sections.length; index++) {
    const section = guide.sections[index];
    if (index) {
      const nextStep = guide.anchors.find(
        (anchor) => anchor.sectionIndex === index,
      );
      assert.ok(nextStep);
      const confirmed = tracker.seekStep(nextStep.stepIndex);
      assert.equal(confirmed.sectionIndex, index);
      assert.equal(confirmed.matchedPoint, null);
    }
    for (let distance = 0; distance < section.length; distance += 0.75) {
      const result = observe(
        sampleRouteGuidance(guide, index, distance).position,
        section.floorId,
      );
      assert.equal(result.sectionIndex, index);
      if (index < guide.sections.length - 1)
        assert.equal(result.arrived, false);
    }
    let result;
    for (let repeat = 0; repeat < 3; repeat++)
      result = observe(section.points.at(-1), section.floorId);
    if (index === guide.sections.length - 1) {
      assert.equal(result.status, "arrived");
      assert.equal(result.floorId, floors.at(-1));
    } else {
      assert.equal(result.status, "floor-change");
      assert.equal(result.arrived, false);
      assert.equal(
        observe(section.points.at(-1), section.floorId).sectionIndex,
        index,
      );
      const next = guide.sections[index + 1];
      const unconfirmed = observe(next.points[0], next.floorId);
      assert.equal(unconfirmed.status, "floor-mismatch");
      assert.equal(
        unconfirmed.sectionIndex,
        index,
        "browsing another floor is not a confirmed stair handoff",
      );
    }
  }
});

test("G424-3 lacks an inner doorway even on the same floor, while navigation retains the four-floor parent route", () => {
  const sourceBefore = JSON.stringify(graph);
  for (const from of [start, parent]) {
    const exact = findRoute(graph, from, child);
    assert.equal(exact.ok, false);
    assert.equal(exact.reason, "target-isolated-source-component");
  }
  const route = findNavigationRoute(graph, start, child);
  assert.equal(route.ok, true);
  assert.equal(route.partial, true);
  assert.equal(route.end.roomId, parent);
  assert.equal(route.requestedDestination.roomId, child);
  assert.deepEqual(
    route.segments.map((segment) => segment.floorId),
    floors,
  );
  assert.equal(route.transitions.length, 3);
  assert.equal(route.lastLeg.geometryAvailable, false);
  assert.equal(route.steps.at(-1).kind, "manual-entry");
  assert.equal(
    route.steps.some((step) => step.kind === "arrive"),
    false,
  );
  assert.equal(
    JSON.stringify(graph),
    sourceBefore,
    "no doorway or graph connection is invented",
  );
});
