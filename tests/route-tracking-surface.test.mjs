import test from "node:test";
import assert from "node:assert/strict";
import {
  createRouteTrackingSurfaceGuard,
  isRouteTrackingConnectorClear,
} from "../src/data/route-tracking-surface.js";

const rectangle = (x1, z1, x2, z2) => [
  [x1, z1],
  [x2, z1],
  [x2, z2],
  [x1, z2],
];
const polygon = (id, points, kind = "corridor", holes = []) => ({
  id,
  kind,
  points,
  holes,
});
const fixture = (overrides = {}) => ({
  id: "test-floor",
  campusId: "test-campus",
  polygons: [polygon("hall", rectangle(0, 0, 20, 10))],
  footprints: [{ points: rectangle(-1, -1, 21, 11), holes: [] }],
  walls: [],
  doors: [],
  ...overrides,
});

test("live route projection remains in one clear corridor or room without moving either point", () => {
  for (const kind of ["corridor", "hall", "room"]) {
    const floor = fixture({
      polygons: [polygon("area", rectangle(0, 0, 20, 10), kind)],
    });
    const point = [3, 4],
      projection = [8, 4];
    const before = JSON.stringify({ floor, point, projection });
    assert.equal(isRouteTrackingConnectorClear(floor, point, projection), true);
    assert.equal(isRouteTrackingConnectorClear(floor, point, point), true);
    assert.equal(JSON.stringify({ floor, point, projection }), before);
  }
});

test("a projection cannot cross a wall, its thickness, or a doorway", () => {
  const crossing = fixture({ walls: [{ a: [5, 1], b: [5, 9], width: 0.2 }] });
  assert.equal(isRouteTrackingConnectorClear(crossing, [3, 5], [7, 5]), false);
  assert.equal(isRouteTrackingConnectorClear(crossing, [5, 5], [5, 5]), false);
  const nearWall = fixture({
    walls: [{ a: [5, 5.4], b: [8, 5.4], width: 1 }],
  });
  assert.equal(isRouteTrackingConnectorClear(nearWall, [3, 5], [10, 5]), false);
  const door = fixture({ doors: [{ a: [5, 1], b: [5, 9] }] });
  assert.equal(isRouteTrackingConnectorClear(door, [3, 5], [7, 5]), false);
});

test("a sub-sampling-width hole or stair opening cannot hide between valid endpoints", () => {
  const thinHole = rectangle(5, 4, 5.00001, 6);
  const floor = fixture({
    polygons: [polygon("hall", rectangle(0, 0, 20, 10), "hall", [thinHole])],
  });
  assert.equal(isRouteTrackingConnectorClear(floor, [3, 5], [9, 5]), false);
  const guard = createRouteTrackingSurfaceGuard(fixture(), {
    cutouts: [{ points: thinHole }],
  });
  assert.equal(guard([3, 5], [9, 5]), false);
  assert.equal(guard([5.000005, 5], [5.000005, 5]), false);
  assert.equal(guard([3, 3], [9, 3]), true);
});

test("concave polygon and footprint notches prevent an outside shortcut", () => {
  const notched = [
    [0, 0],
    [10, 0],
    [10, 10],
    [6, 10],
    [6, 3],
    [4, 3],
    [4, 10],
    [0, 10],
  ];
  const room = fixture({ polygons: [polygon("hall", notched)] });
  assert.equal(isRouteTrackingConnectorClear(room, [2, 8], [8, 8]), false);
  const slab = fixture({ polygons: [], footprints: [{ points: notched }] });
  assert.equal(isRouteTrackingConnectorClear(slab, [2, 8], [8, 8]), false);
  assert.equal(isRouteTrackingConnectorClear(slab, [2, 2], [8, 2]), true);
});

test("unlabelled slab circulation is allowed only without crossing a room or protected stair area", () => {
  const room = polygon("room", rectangle(6, 4, 8, 6), "room");
  const floor = fixture({ polygons: [room] });
  assert.equal(isRouteTrackingConnectorClear(floor, [2, 2], [10, 2]), true);
  assert.equal(isRouteTrackingConnectorClear(floor, [2, 5], [10, 5]), false);
  assert.equal(isRouteTrackingConnectorClear(floor, [7, 5], [10, 5]), false);
  assert.equal(isRouteTrackingConnectorClear(floor, [6.5, 5], [7.5, 5]), true);
  for (const kind of ["stairs", "elevator", "lift", "door"]) {
    const protectedFloor = fixture({
      polygons: [polygon("protected", room.points, kind)],
    });
    assert.equal(
      isRouteTrackingConnectorClear(protectedFloor, [7, 5], [7, 5]),
      false,
    );
    assert.equal(
      isRouteTrackingConnectorClear(protectedFloor, [2, 5], [10, 5]),
      false,
    );
  }
});

test("parallel and overlapping rooms never borrow one another's route projection", () => {
  const floor = fixture({
    polygons: [
      polygon("left", rectangle(0, 0, 5, 10), "room"),
      polygon("right", rectangle(5, 0, 10, 10), "room"),
    ],
  });
  assert.equal(isRouteTrackingConnectorClear(floor, [4, 5], [6, 5]), false);
  const ambiguous = fixture({
    polygons: [
      polygon("a", rectangle(0, 0, 10, 10), "room"),
      polygon("b", rectangle(5, 0, 15, 10), "room"),
    ],
  });
  assert.equal(isRouteTrackingConnectorClear(ambiguous, [7, 5], [8, 5]), false);
  assert.equal(isRouteTrackingConnectorClear(ambiguous, [7, 5], [7, 5]), false);
});

test("missing, malformed and outside surfaces fail closed", () => {
  for (const floor of [
    null,
    {},
    fixture({ polygons: [], footprints: [] }),
    fixture({
      polygons: [
        {
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    }),
    fixture({ walls: [{ a: [NaN, 0], b: [3, 3] }] }),
  ])
    assert.equal(isRouteTrackingConnectorClear(floor, [2, 2], [3, 3]), false);
  const floor = fixture();
  for (const point of [[NaN, 2], [Infinity, 0], [], null, [100, 100]])
    assert.equal(isRouteTrackingConnectorClear(floor, point, [3, 3]), false);
  assert.equal(isRouteTrackingConnectorClear(floor, [3, 3], [100, 100]), false);
});
