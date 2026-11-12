import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRouteTracker } from "../src/data/route-tracking.js";
import { createRouteTrackingSurfaceGuard } from "../src/data/route-tracking-surface.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
} from "../src/map/route-guidance.js";
import { findRoute } from "../src/data/routing.js";

const T = 1_800_000_000_000;
function fixture(
  points = [
    [0, 0],
    [20, 0],
    [20, 20],
    [40, 20],
  ],
) {
  return {
    ok: true,
    campusId: "v-78",
    distanceMeters: 60,
    segments: [{ floorId: "f1", points }],
    steps: [
      { kind: "start", floorId: "f1", position: points[0] },
      { kind: "walk", floorId: "f1", position: points[0] },
      ...points
        .slice(1, -1)
        .map((point) => ({ kind: "turn", floorId: "f1", position: point })),
      { kind: "arrive", floorId: "f1", position: points.at(-1) },
    ],
  };
}
function gps(point, index = 0, extra = {}) {
  return {
    source: "gps",
    status: "inside",
    campusId: "v-78",
    point,
    timestamp: T + index * 1000,
    accuracyMeters: 3,
    accuracyRadiusMap: 3,
    trackingStatus: "live",
    ...extra,
  };
}
function observe(tracker, point, index, extra = {}, options = {}) {
  const location = gps(point, index, extra);
  return tracker.update(location, {
    now: location.timestamp,
    floorId: "f1",
    ...options,
  });
}

test("live progress replaces passed Start with the upcoming instruction after independent fixes", () => {
  const route = fixture();
  const original = JSON.stringify(route);
  const tracker = createRouteTracker(route);
  assert.equal(observe(tracker, [0, 0], 0).status, "acquiring");
  const confirmed = observe(tracker, [1, 0], 1);
  assert.equal(confirmed.status, "tracking");
  assert.equal(confirmed.stepIndex, 2);
  assert.equal(confirmed.distanceToNextMeters, 20);
  assert.equal(confirmed.remainingMeters, 60);
  let result;
  for (let i = 2; i <= 11; i++) result = observe(tracker, [i * 1.5, 0], i);
  assert.equal(result.stepIndex, 2);
  assert.ok(result.distanceToNextMeters < 7);
  assert.equal(JSON.stringify(route), original);
});

test("a display match needs two reliable fixes and clears when the route floor changes", () => {
  const tracker = createRouteTracker(fixture());
  assert.equal(observe(tracker, [0, 1], 0).matchedPoint, null);
  const match = observe(tracker, [2, 1], 1);
  assert.deepEqual(match.matchedPoint, [2, 0]);
  assert.equal(match.floorId, "f1");
  assert.equal(
    observe(tracker, [3, 1], 2, {}, { floorId: "f2" }).matchedPoint,
    null,
  );
});

test("turns advance only after two observations beyond the corner and progress does not rewind", () => {
  const tracker = createRouteTracker(fixture());
  const positions = [
    [0, 0],
    [3, 0],
    [6, 0],
    [9, 0],
    [12, 0],
    [15, 0],
    [18, 0],
    [20, 0],
    [20, 2],
    [20, 4],
    [20, 6],
  ];
  let result;
  positions.forEach((point, i) => {
    result = observe(tracker, point, i);
  });
  assert.equal(result.status, "tracking");
  assert.equal(result.stepIndex, 3);
  assert.equal(result.distance, 24);
  assert.equal(observe(tracker, [20, 4], 11).distance, 24);
});

test("duplicate and out-of-order fixes are not confirmations and do not erase valid evidence", () => {
  const tracker = createRouteTracker(fixture());
  const first = observe(tracker, [0, 0], 1);
  assert.deepEqual(observe(tracker, [0, 0], 1), first);
  assert.deepEqual(observe(tracker, [0, 0], 0), first);
  assert.equal(observe(tracker, [2, 0], 2).status, "tracking");
  const before = tracker.snapshot();
  assert.deepEqual(observe(tracker, [0, 0], 1), before);
});

test("walking back through a turn keeps the marker on the line and resumes instructions from the earlier position", () => {
  const tracker = createRouteTracker(fixture());
  const fix = (point, index) =>
    observe(tracker, point, index, {}, { pauseOnReverse: true });
  for (let i = 0; i <= 10; i++) fix([i * 2, 0], i);
  for (let i = 1; i <= 4; i++) fix([20, i * 2], i + 10);
  assert.equal(tracker.snapshot().stepIndex, 3);
  assert.equal(
    fix([20, 6], 15).status,
    "tracking",
    "one retreat may be GPS jitter",
  );
  const paused = fix([20, 4], 16);
  assert.equal(paused.status, "wrong-way");
  assert.deepEqual(paused.matchedPoint, [20, 4]);
  assert.equal(fix([20, 2], 17).status, "wrong-way");
  const beforeTurn = fix([18, 0], 18);
  assert.equal(beforeTurn.status, "wrong-way");
  assert.deepEqual(beforeTurn.matchedPoint, [18, 0]);
  assert.equal(beforeTurn.stepIndex, paused.stepIndex);
  assert.equal(beforeTurn.distance, paused.distance);
  assert.equal(fix([16, 0], 19).status, "wrong-way");
  assert.equal(fix([16, 0], 20).status, "wrong-way");
  assert.equal(fix([17, 0], 21).status, "acquiring");
  const resumed = fix([18, 0], 22);
  assert.equal(resumed.status, "tracking");
  assert.equal(resumed.stepIndex, 2);
  assert.equal(resumed.distance, 17);
});

test("leaving the route releases the display marker and returning restores tracking", () => {
  const tracker = createRouteTracker(fixture());
  const fix = (point, index) =>
    observe(tracker, point, index, {}, { pauseOnReverse: true });
  fix([0, 0], 0);
  fix([2, 0], 1);
  const before = fix([4, 0], 2);
  const detached = fix([5, 4], 3);
  assert.equal(detached.status, "off-route");
  assert.equal(detached.matchedPoint, null);
  assert.equal(detached.distance, before.distance);
  assert.equal(fix([6, 1], 4).status, "acquiring");
  assert.deepEqual(fix([8, 1], 5).matchedPoint, [8, 0]);
});

test("stale or paused GPS holds even when its timestamp is repeated by a UI refresh", () => {
  const tracker = createRouteTracker(fixture());
  observe(tracker, [0, 0], 0);
  observe(tracker, [2, 0], 1);
  const stale = tracker.update(gps([2, 0], 1), {
    now: T + 12_000,
    floorId: "f1",
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.distance, 0);
  const tracker2 = createRouteTracker(fixture());
  observe(tracker2, [0, 0], 0);
  observe(tracker2, [2, 0], 1);
  assert.equal(
    observe(tracker2, [2, 0], 1, { trackingStatus: "stopped" }).status,
    "stale",
  );
});

test("poor accuracy breaks pending confirmation and a static manual point never walks", () => {
  const tracker = createRouteTracker(fixture());
  observe(tracker, [0, 0], 0);
  assert.equal(
    observe(tracker, [3, 0], 1, { accuracyMeters: 30 }).status,
    "low-accuracy",
  );
  assert.equal(observe(tracker, [3, 0], 2).status, "acquiring");
  assert.equal(observe(tracker, [4, 0], 3).status, "tracking");
  const before = tracker.snapshot().distance;
  const manual = tracker.update(
    { ...gps([10, 0], 4), source: "manual", floorId: "f1" },
    { now: T + 4000, floorId: "f1" },
  );
  assert.equal(manual.status, "waiting");
  assert.equal(manual.reason, "gps-required");
  assert.equal(manual.distance, before);
});

test("jumps, off-path points and rejected map connectors cannot advance instructions", () => {
  const tracker = createRouteTracker(fixture());
  observe(tracker, [0, 0], 0);
  observe(tracker, [2, 0], 1);
  const before = tracker.snapshot().distance;
  assert.equal(observe(tracker, [18, 0], 2).reason, "position-jump");
  assert.equal(tracker.snapshot().distance, before);
  assert.equal(observe(tracker, [10, 8], 3).status, "off-route");
  let args;
  const guarded = observe(
    tracker,
    [3, 0],
    4,
    {},
    {
      allowPoint: (...values) => {
        args = values;
        return false;
      },
    },
  );
  assert.equal(guarded.reason, "unverified-map-connector");
  assert.deepEqual(args[0], [3, 0]);
  assert.equal(args[2].floorId, "f1");
  assert.equal(args[3], 0);
  assert.equal(tracker.snapshot().distance, before);
  assert.equal(
    observe(
      tracker,
      [3, 0],
      5,
      {},
      {
        allowPoint: () => {
          throw Error("missing plan");
        },
      },
    ).status,
    "off-route",
  );
});

test("a rejected jump cannot promote itself by repeating immediately after evidence resets", () => {
  const tracker = createRouteTracker(fixture());
  observe(tracker, [0, 0], 0);
  observe(tracker, [2, 0], 1);
  assert.equal(observe(tracker, [18, 0], 2).reason, "position-jump");
  assert.equal(observe(tracker, [18, 0], 3).reason, "position-jump");
  assert.equal(observe(tracker, [18, 0], 4).reason, "position-jump");
  assert.equal(tracker.snapshot().distance, 0);
  assert.equal(observe(tracker, [3, 0], 5).status, "acquiring");
  assert.equal(observe(tracker, [4, 0], 6).status, "tracking");
});

test("a nearby later crossing or parallel return branch cannot teleport progress", () => {
  const crossing = createRouteTracker(
    fixture([
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, -10],
    ]),
  );
  observe(crossing, [0, 0], 0);
  assert.equal(observe(crossing, [0, 1], 1).distance, 0);
  assert.equal(crossing.snapshot().stepIndex, 2);
  const parallel = createRouteTracker(
    fixture([
      [0, 0],
      [20, 0],
      [20, 2],
      [0, 2],
    ]),
  );
  observe(parallel, [0, 2], 0, { accuracyMeters: 4, accuracyRadiusMap: 4 });
  const result = observe(parallel, [0, 2], 1, {
    accuracyMeters: 4,
    accuracyRadiusMap: 4,
  });
  assert.equal(result.distance, 0);
  assert.equal(result.arrived, false);
  assert.equal(result.stepIndex, 2);
});

test("GPS needs an explicit map-floor context and cannot override a manual own-floor mismatch", () => {
  const tracker = createRouteTracker(fixture());
  assert.equal(
    tracker.update(gps([0, 0]), { now: T }).status,
    "floor-mismatch",
  );
  assert.equal(
    observe(tracker, [0, 0], 1, { floorEvidence: "manual", floorId: "f2" })
      .status,
    "floor-mismatch",
  );
  assert.equal(
    observe(
      tracker,
      [0, 0],
      2,
      { floorEvidence: "manual", floorId: "f1" },
      { floorId: "f2" },
    ).status,
    "floor-mismatch",
  );
  assert.equal(
    observe(
      tracker,
      [0, 0],
      3,
      { floorEvidence: "manual", floorId: "f1" },
      { floorId: null },
    ).status,
    "acquiring",
  );
});

test("manual physical floor must match the projected edge, not just the shared source floorId", () => {
  const route = fixture([
    [0, 0],
    [10, 0],
  ]);
  route.segments[0].nodes = route.segments[0].points.map((position) => ({
    position,
    floorId: "f1",
    building: "А",
    physicalLevel: 2,
  }));
  const tracker = createRouteTracker(route);
  const wrong = {
    floorEvidence: "manual",
    floorId: "f1",
    building: "А",
    physicalLevel: 1,
  };
  assert.equal(observe(tracker, [0, 0], 0, wrong).status, "floor-mismatch");
  assert.equal(observe(tracker, [1, 0], 1, wrong).distance, 0);
  const correct = { ...wrong, physicalLevel: 2 };
  assert.equal(observe(tracker, [0, 0], 2, correct).status, "acquiring");
  assert.equal(observe(tracker, [1, 0], 3, correct).status, "tracking");
  // Re-publishing the same timestamp with conflicting manual evidence must
  // hold rather than returning an earlier successful tracking snapshot.
  assert.equal(observe(tracker, [1, 0], 3, wrong).status, "floor-mismatch");
});

test("a same-floor route can cross wings without retaining an arbitrary first-node building", () => {
  const route = fixture([
    [0, 0],
    [5, 0],
    [10, 0],
    [15, 0],
  ]);
  route.segments[0].nodes = route.segments[0].points.map((position, i) => ({
    position,
    floorId: "f1",
    building: i < 2 ? "А" : "Б",
    physicalLevel: 1,
  }));
  const tracker = createRouteTracker(route);
  const manual = {
    floorEvidence: "manual",
    floorId: "f1",
    building: "А",
    physicalLevel: 1,
  };
  let result;
  for (let i = 0; i <= 12; i++) result = observe(tracker, [i, 0], i, manual);
  assert.equal(result.status, "tracking");
  assert.equal(result.distance, 11);
  // A hall anchor whose building is unspecified can still match a verified
  // physical level; the tracker never fabricates a building for it.
  const hall = createRouteTracker(route);
  observe(hall, [0, 0], 0, { ...manual, building: null });
  assert.equal(
    observe(hall, [1, 0], 1, { ...manual, building: null }).status,
    "tracking",
  );
});

test("a section with several physical floors checks the candidate edge, including duplicate source vertices", () => {
  const route = fixture([
    [0, 0],
    [5, 0],
    [5, 0],
    [10, 0],
    [15, 0],
  ]);
  route.segments[0].nodes = route.segments[0].points.map((position, i) => ({
    position,
    floorId: "f1",
    building: i < 3 ? "А" : "Б",
    physicalLevel: i < 3 ? 2 : 1,
  }));
  const tracker = createRouteTracker(route);
  const anchor = {
    floorEvidence: "manual",
    floorId: "f1",
    building: "А",
    physicalLevel: 2,
  };
  observe(tracker, [0, 0], 0, anchor);
  assert.equal(observe(tracker, [1, 0], 1, anchor).status, "tracking");
  assert.equal(observe(tracker, [4, 0], 2, anchor).status, "tracking");
  // The mixed A2→Б1 edge and subsequent Б1 edge cannot inherit A2 merely
  // because their source floorId is unchanged.
  assert.equal(observe(tracker, [6, 0], 3, anchor).status, "floor-mismatch");
  assert.equal(tracker.snapshot().distance, 1);
  const wrongAnchor = createRouteTracker(route);
  const manualA1 = { ...anchor, physicalLevel: 1 };
  assert.equal(
    observe(wrongAnchor, [11, 0], 0, manualA1).status,
    "floor-mismatch",
  );
  // Manual Б1 matches the later edge after an explicit step selection.
  const inB = createRouteTracker(route);
  const arrive = route.steps.length - 1;
  inB.seekStep(arrive);
  assert.equal(
    observe(inB, [14, 0], 0, { ...anchor, building: "Б", physicalLevel: 1 })
      .status,
    "acquiring",
  );
});

test("walking across a mapped А2 to Г3 edge keeps progress on the confirmed source plan", () => {
  const route = fixture([
    [0, 0],
    [5, 0],
    [10, 0],
    [15, 0],
  ]);
  const nodes = (route.segments[0].nodes = route.segments[0].points.map(
    (position, i) => ({
      position,
      floorId: "f1",
      building: i < 2 ? "А" : "Г",
      physicalLevel: i < 2 ? 2 : 3,
      kind: "waypoint",
    }),
  ));
  const anchor = {
    floorEvidence: "manual",
    floorId: "f1",
    building: "А",
    physicalLevel: 2,
  };
  const options = {
    floorBuildingLevels: { А: 2, Г: 3 },
    allowPoint: () => true,
  };
  const tracker = createRouteTracker(route);
  let progress;
  for (let i = 0; i <= 12; i++)
    progress = observe(tracker, [i, 0], i, anchor, options);
  assert.equal(progress.status, "tracking");
  assert.ok(progress.distance > 10);
  for (const overrides of [
    { floorId: "f2" },
    { floorBuildingLevels: { А: 1, Г: 3 } },
    { floorBuildingLevels: { А: 2, Г: 2 } },
    { allowPoint: undefined },
  ])
    assert.equal(
      observe(createRouteTracker(route), [6, 0], 0, anchor, {
        ...options,
        ...overrides,
      }).status,
      "floor-mismatch",
    );
  nodes[2].kind = "stairs";
  assert.equal(
    observe(createRouteTracker(route), [6, 0], 0, anchor, options).status,
    "floor-mismatch",
  );
});

test("unverifiable physical-floor node metadata cannot authorize a known manual level", () => {
  const route = fixture([
    [0, 0],
    [10, 0],
  ]);
  const tracker = createRouteTracker(route);
  const manual = { floorEvidence: "manual", floorId: "f1", physicalLevel: 1 };
  assert.equal(observe(tracker, [0, 0], 0, manual).status, "floor-mismatch");
});

test("arrival needs repeated close accurate fixes and never happens just because Arrive is upcoming", () => {
  const tracker = createRouteTracker(
    fixture([
      [0, 0],
      [10, 0],
    ]),
  );
  observe(tracker, [0, 0], 0);
  const walking = observe(tracker, [2, 0], 1);
  assert.equal(walking.stepIndex, 2);
  assert.equal(walking.arrived, false);
  observe(tracker, [5, 0], 2);
  observe(tracker, [8, 0], 3, { accuracyMeters: 8 });
  assert.equal(observe(tracker, [9, 0], 4).arrived, false);
  const arrival = observe(tracker, [10, 0], 5);
  assert.equal(arrival.status, "arrived");
  assert.equal(arrival.arrived, true);
  assert.equal(arrival.remainingMeters, 0);
  assert.equal(tracker.update(null).arrived, true);
});

test("stairs and repeated visits to a source floor require an explicit step hand-off", () => {
  const route = {
    campusId: "v-78",
    distanceMeters: 12,
    segments: [
      {
        floorId: "f1",
        points: [
          [0, 0],
          [4, 0],
        ],
      },
      {
        floorId: "f2",
        points: [
          [4, 0],
          [8, 0],
        ],
      },
      {
        floorId: "f1",
        points: [
          [8, 0],
          [12, 0],
        ],
      },
    ],
    transitions: [
      {
        fromFloorId: "f1",
        toFloorId: "f2",
        point: [4, 0],
        targetPoint: [4, 0],
      },
      {
        fromFloorId: "f2",
        toFloorId: "f1",
        point: [8, 0],
        targetPoint: [8, 0],
      },
    ],
    steps: [
      { kind: "start", floorId: "f1", position: [0, 0] },
      { kind: "stairs", floorId: "f1", targetFloorId: "f2", position: [4, 0] },
      { kind: "walk", floorId: "f2", position: [4, 0] },
      { kind: "stairs", floorId: "f2", targetFloorId: "f1", position: [8, 0] },
      { kind: "walk", floorId: "f1", position: [8, 0] },
      { kind: "arrive", floorId: "f1", position: [12, 0] },
    ],
  };
  const tracker = createRouteTracker(route);
  observe(tracker, [0, 0], 0);
  observe(tracker, [2, 0], 1);
  observe(tracker, [3.5, 0], 2);
  const end = observe(tracker, [4, 0], 3);
  assert.equal(end.status, "floor-change");
  assert.equal(end.sectionIndex, 0);
  assert.equal(
    observe(tracker, [5, 0], 4, {}, { floorId: "f2" }).status,
    "floor-mismatch",
  );
  assert.equal(tracker.snapshot().sectionIndex, 0);
  assert.equal(tracker.seekStep(2).sectionIndex, 1);
  assert.equal(
    observe(
      tracker,
      [4, 0],
      5,
      { floorEvidence: "manual", floorId: "f1" },
      { floorId: "f2" },
    ).status,
    "floor-mismatch",
  );
  observe(tracker, [4, 0], 6, {}, { floorId: "f2" });
  assert.equal(
    observe(tracker, [5, 0], 7, {}, { floorId: "f2" }).sectionIndex,
    1,
  );
  assert.equal(tracker.seekStep(4).sectionIndex, 2);
  assert.equal(tracker.seekStep(99), null);
});

test("new manual GPS correction resets evidence without manufacturing route progress", () => {
  const tracker = createRouteTracker(fixture());
  observe(tracker, [0, 0], 0);
  observe(tracker, [2, 0], 1);
  const before = tracker.snapshot().distance;
  const corrected = observe(tracker, [3, 0], 1, {
    correction: { createdAt: T + 1000 },
  });
  assert.equal(corrected.status, "acquiring");
  assert.equal(corrected.distance, before);
  assert.equal(
    observe(tracker, [4, 0], 2, { correction: { createdAt: T + 1000 } }).status,
    "tracking",
  );
});

test("nonmetric or malformed routes never invent numeric metre distances", () => {
  const route = fixture();
  delete route.distanceMeters;
  const tracker = createRouteTracker(route);
  assert.equal(tracker.snapshot().remainingMeters, null);
  assert.equal(
    createRouteTracker({}).update(gps([0, 0]), { now: T, floorId: "f1" })
      .reason,
    "missing-route-geometry",
  );
});

test("real G103-1 to G209 replays each source section without automatically crossing a stair", () => {
  const graph = JSON.parse(
    readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
  );
  const route = findRoute(graph, "v-78--floor-0--200", "v-78--floor-1--6dn");
  assert.equal(route.ok, true);
  const guide = createRouteGuidance(route);
  const tracker = createRouteTracker(route);
  let tick = 0;
  for (let s = 0; s < guide.sections.length; s++) {
    const section = guide.sections[s];
    if (s) {
      const first = guide.anchors.find((a) => a.sectionIndex === s);
      assert.ok(first);
      tracker.seekStep(first.stepIndex);
    }
    let result;
    for (let d = 0; d < section.length; d += 0.5) {
      const sample = sampleRouteGuidance(guide, s, d);
      result = observe(
        tracker,
        sample.position,
        ++tick,
        {},
        { floorId: section.floorId },
      );
      assert.equal(result.sectionIndex, s);
      assert.ok(
        ["tracking", "acquiring", "floor-change", "arrived"].includes(
          result.status,
        ),
        `${s}/${d}: ${result.status}/${result.reason}`,
      );
    }
    for (let i = 0; i < 3; i++)
      result = observe(
        tracker,
        section.points.at(-1),
        ++tick,
        {},
        { floorId: section.floorId },
      );
    assert.equal(
      result.status,
      s < guide.sections.length - 1 ? "floor-change" : "arrived",
    );
  }
});

test("the А-209 to Г-213 corridor continues along its line during bounded lateral GPS drift", () => {
  const graph = JSON.parse(
    readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
  );
  const floor = JSON.parse(
    readFileSync(
      new URL("../public/data/campuses/v-78/v-78-floor2.json", import.meta.url),
    ),
  );
  const route = findRoute(graph, "v-78--floor-2--a01", "v-78--floor-1--6ds");
  assert.equal(route.ok, true);
  assert.equal(
    route.distanceMeters,
    null,
    "the destination is on another floor",
  );
  const guide = createRouteGuidance(route);
  const tracker = createRouteTracker(route);
  const allowPoint = createRouteTrackingSurfaceGuard(floor);
  const sample = (distance) => sampleRouteGuidance(guide, 0, distance);
  const replay = (tick, lateralDrift = 0) => {
    const { position, heading } = sample(tick);
    const point = [
      position[0] - heading[1] * lateralDrift,
      position[1] + heading[0] * lateralDrift,
    ];
    const accuracy = lateralDrift ? 10 : 8;
    return observe(
      tracker,
      point,
      tick,
      { accuracyMeters: accuracy, accuracyRadiusMap: accuracy },
      { floorId: floor.id, allowPoint, pauseOnReverse: true },
    );
  };
  let confirmed;
  for (let tick = 0; tick <= 24; tick++)
    confirmed = replay(tick, tick >= 23 ? (tick - 22) * 1.5 : 0);
  assert.equal(confirmed.status, "tracking");
  for (let tick = 25; tick < 46; tick++) {
    const update = replay(tick, tick === 25 ? 4.5 : 6);
    assert.equal(update.status, "tracking");
    assert.ok(update.distance >= confirmed.distance);
    const expected = sample(tick).position;
    assert.ok(
      Math.hypot(
        update.matchedPoint[0] - expected[0],
        update.matchedPoint[1] - expected[1],
      ) < 0.01,
      `the marker stays on the corridor at second ${tick}`,
    );
  }
  replay(46);
  replay(47);
  const recovered = replay(48);
  assert.equal(recovered.status, "tracking");
  assert.equal(recovered.sectionIndex, 0);
  assert.ok(recovered.distance > confirmed.distance);
});

function guardedLineFixture(
  points = [
    [0, 0],
    [40, 0],
  ],
) {
  const rect = (x0, y0, x1, y1) => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const floor = {
    id: "f1",
    polygons: [
      { id: "corridor", kind: "corridor", points: rect(-2, -2, 42, 2) },
      { id: "closed-room", kind: "room", points: rect(-2, 2, 42, 10) },
    ],
    footprints: [{ points: rect(-2, -2, 42, 10) }],
    walls: [{ a: [-2, 2], b: [42, 2], width: 0.2 }],
    doors: [],
  };
  return {
    tracker: createRouteTracker(fixture(points)),
    options: {
      allowPoint: createRouteTrackingSurfaceGuard(floor),
      pauseOnReverse: true,
    },
    accuracy: { accuracyMeters: 10, accuracyRadiusMap: 10 },
  };
}

test("line following absorbs bounded sideways noise through a room wall or outside the slab without changing GPS", () => {
  const { tracker, options, accuracy } = guardedLineFixture();
  const points = [
    [0, 0],
    [2, 0],
    [4, 6],
    [6, -6],
    [8, 6],
    [10, 6],
  ];
  const before = JSON.stringify(points);
  for (const [index, point] of points.entries()) {
    const result = observe(tracker, point, index, accuracy, options);
    assert.equal(result.status, index ? "tracking" : "acquiring");
    if (index) assert.deepEqual(result.matchedPoint, [point[0], 0]);
  }
  assert.ok(tracker.snapshot().distance >= 6);
  assert.equal(JSON.stringify(points), before);
  const normal = guardedLineFixture();
  assert.equal(
    observe(normal.tracker, [4, 3], 0, accuracy, {
      ...normal.options,
      pauseOnReverse: false,
    }).reason,
    "unverified-map-connector",
  );
});

test("stationary two-metre jitter cannot accumulate route progress or instructions", () => {
  const { tracker, options, accuracy } = guardedLineFixture();
  observe(tracker, [10, 0], 0, accuracy, options);
  const before = observe(tracker, [10, 0], 1, accuracy, options);
  // Include a two-fix reversal and reacquisition inside the same noise band:
  // recovery must not ratchet confirmed distance backward and then forward.
  const jitter = [12, 12, 10, 10, 8, 8, 9, 9, 10, 10, 12, 12];
  for (let index = 2; index < 42; index++) {
    const x = jitter[(index - 2) % jitter.length];
    const result = observe(
      tracker,
      [x, index % 2 ? 4 : -4],
      index,
      accuracy,
      options,
    );
    assert.equal(result.distance, before.distance);
    assert.equal(result.stepIndex, before.stepIndex);
    assert.equal(result.arrived, false);
    assert.notEqual(
      result.status,
      "wrong-way",
      "a noisy peak/trough inside the stable band cannot confirm a turn around",
    );
  }
});

test("a nearby parallel return across a wall is not a shortcut to later route progress", () => {
  const { tracker, options, accuracy } = guardedLineFixture([
    [0, 0],
    [40, 0],
    [40, 6],
    [0, 6],
  ]);
  observe(tracker, [0, 0], 0, accuracy, options);
  observe(tracker, [2, 0], 1, accuracy, options);
  for (let index = 2; index < 10; index++) {
    const result = observe(tracker, [index * 2, 6], index, accuracy, options);
    assert.equal(result.status, "tracking");
    assert.deepEqual(result.matchedPoint, [index * 2, 0]);
    assert.ok(result.distance < 40);
    assert.equal(result.stepIndex, 2);
  }
});

test("longitudinal jumps and sustained departures release the line instead of spending the lateral tolerance", () => {
  const { tracker, options, accuracy } = guardedLineFixture();
  observe(tracker, [0, 0], 0, accuracy, options);
  const before = observe(tracker, [2, 0], 1, accuracy, options);
  const jump = observe(tracker, [14, 0], 2, accuracy, options);
  assert.equal(jump.status, "off-route");
  assert.equal(jump.reason, "route-progress-jump");
  for (let index = 3; index < 20; index++) {
    const result = observe(tracker, [4, 25], index, accuracy, options);
    assert.equal(result.status, "off-route");
    assert.equal(result.matchedPoint, null);
    assert.equal(result.distance, before.distance);
  }
  assert.equal(
    observe(tracker, [4, 0], 20, accuracy, options).status,
    "acquiring",
  );
  assert.equal(
    observe(tracker, [6, 0], 21, accuracy, options).status,
    "tracking",
  );
  const progress = tracker.snapshot().distance;
  for (let index = 22; index < 30; index++) {
    const result = observe(
      tracker,
      [index, 0],
      index,
      { accuracyMeters: 50, accuracyRadiusMap: 50 },
      options,
    );
    assert.equal(result.status, "low-accuracy");
    assert.equal(result.distance, progress);
  }
});

test("verified line following retains a genuine reverse walk through a corner and then resumes forward progress", () => {
  const tracker = createRouteTracker(fixture());
  const floor = {
    id: "f1",
    polygons: [
      {
        id: "hall",
        kind: "hall",
        points: [
          [-5, -5],
          [45, -5],
          [45, 25],
          [-5, 25],
        ],
      },
    ],
    walls: [],
    doors: [],
  };
  const options = {
    pauseOnReverse: true,
    allowPoint: createRouteTrackingSurfaceGuard(floor),
  };
  const fix = (point, index) => observe(tracker, point, index, {}, options);
  for (let index = 0; index <= 10; index++) fix([index * 2, 0], index);
  for (let index = 1; index <= 4; index++) fix([20, index * 2], index + 10);
  assert.equal(tracker.snapshot().stepIndex, 3);
  fix([20, 6], 15);
  assert.equal(fix([20, 4], 16).status, "wrong-way");
  fix([20, 2], 17);
  const beforeTurn = fix([18, 0], 18);
  assert.equal(beforeTurn.status, "wrong-way");
  assert.deepEqual(beforeTurn.matchedPoint, [18, 0]);
  fix([16, 0], 19);
  fix([16, 0], 20);
  assert.equal(fix([17, 0], 21).status, "acquiring");
  const resumed = fix([18, 0], 22);
  assert.equal(resumed.status, "tracking");
  assert.equal(resumed.stepIndex, 2);
  assert.equal(resumed.distance, 17);
});
