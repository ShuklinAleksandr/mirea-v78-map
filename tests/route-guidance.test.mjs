import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRouteGuidance,
  sampleRouteGuidance,
  guidanceAnchorForStep,
} from "../src/map/route-guidance.js";
import { findRoute } from "../src/data/routing.js";

test("preview sampling retains every original turn and never cuts across its camera window", () => {
  const route = {
    segments: [
      {
        floorId: "f1",
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
          [20, 10],
        ],
      },
    ],
    steps: [
      { kind: "start", floorId: "f1", position: [0, 0] },
      { kind: "turn", floorId: "f1", position: [10, 0] },
    ],
  };
  const original = JSON.stringify(route);
  const guide = createRouteGuidance(route);
  const sample = sampleRouteGuidance(guide, 0, 8);
  assert.deepEqual(sample.position, [8, 0]);
  assert.deepEqual(sample.heading, [1, 0]);
  assert.deepEqual(sample.cameraPoints, [
    [5, 0],
    [10, 0],
    [10, 10],
    [16, 10],
  ]);
  assert.equal(sample.length, 30);
  assert.equal(JSON.stringify(route), original);
  assert.equal(guidanceAnchorForStep(guide, 1).distance, 10);
});

test("a stair boundary and separate visits to the same floor remain separate preview sections", () => {
  const route = {
    segments: [
      {
        floorId: "f1",
        points: [
          [0, 0],
          [2, 0],
        ],
      },
      {
        floorId: "f2",
        points: [
          [50, 40],
          [51, 40],
        ],
      },
      {
        floorId: "f1",
        points: [
          [70, 80],
          [71, 80],
        ],
      },
    ],
    transitions: [
      {
        fromFloorId: "f1",
        toFloorId: "f2",
        point: [2, 0],
        targetPoint: [50, 40],
        label: "Лестница",
      },
    ],
    steps: [
      { kind: "start", floorId: "f1", position: [0, 0] },
      { kind: "stairs", floorId: "f1", targetFloorId: "f2", position: [2, 0] },
      { kind: "walk", floorId: "f2", position: [50, 40] },
      {
        kind: "stairs",
        floorId: "f2",
        targetFloorId: "f1",
        position: [51, 40],
      },
      { kind: "arrive", floorId: "f1", position: [71, 80] },
    ],
  };
  const guide = createRouteGuidance(route);
  assert.equal(guide.sections.length, 3);
  const sample = sampleRouteGuidance(guide, 0, 500);
  assert.equal(sample.floorId, "f1");
  assert.deepEqual(sample.position, [2, 0]);
  assert.equal(sample.atEnd, true);
  assert.deepEqual(sample.cameraPoints, [
    [0, 0],
    [2, 0],
  ]);
  assert.equal(guidanceAnchorForStep(guide, 4).sectionIndex, 2);
  assert.deepEqual(sampleRouteGuidance(guide, 1, 0).position, [50, 40]);
});

test("stationary, duplicate, malformed and missing route geometry never produces non-finite samples", () => {
  const guide = createRouteGuidance({
    segments: [
      {
        floorId: "f",
        points: [
          [1, 2],
          [1, 2],
        ],
      },
    ],
  });
  const sample = sampleRouteGuidance(guide, 0, -500);
  assert.deepEqual(sample.position, [1, 2]);
  assert.equal(sample.progress, 1);
  assert.equal(sample.atEnd, true);
  assert.ok(sample.heading.every(Number.isFinite));
  assert.equal(sampleRouteGuidance(guide, 5, 0), null);
  assert.equal(
    createRouteGuidance({
      segments: [
        {
          floorId: "bad",
          points: [
            [0, 0],
            [NaN, 1],
            [1, 1],
          ],
        },
      ],
    }).sections.length,
    0,
  );
  assert.equal(createRouteGuidance({}).sections.length, 0);
});

test("real G103-1 to G209 preview remains entirely on the route's original horizontal segments", () => {
  const graph = JSON.parse(
    readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
  );
  const route = findRoute(graph, "v-78--floor-0--200", "v-78--floor-1--6dn");
  assert.equal(route.ok, true);
  const guide = createRouteGuidance(route);
  assert.equal(guide.sections.length, route.segments.length);
  for (
    let sectionIndex = 0;
    sectionIndex < guide.sections.length;
    sectionIndex++
  ) {
    const section = guide.sections[sectionIndex];
    for (let i = 0; i <= 20; i++) {
      const sample = sampleRouteGuidance(
        guide,
        sectionIndex,
        (section.length * i) / 20,
      );
      const onLeg = section.points.some((point, j) => {
        if (!j) return false;
        const a = section.points[j - 1],
          b = point;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const sum =
          Math.hypot(sample.position[0] - a[0], sample.position[1] - a[1]) +
          Math.hypot(sample.position[0] - b[0], sample.position[1] - b[1]);
        return Math.abs(sum - length) < 1e-6;
      });
      assert.ok(onLeg || section.points.length === 1);
      assert.equal(sample.floorId, section.floorId);
    }
  }
});
