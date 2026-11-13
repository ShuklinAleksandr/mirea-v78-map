import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIBRARY_PASSAGE_EDGE_ID,
  withLibraryPassageGraph,
} from "../src/data/library-passage.js";
import { isRouteTrackingConnectorClear } from "../src/data/route-tracking-surface.js";
import {
  makeCurrentRouteEndpoint,
  attachCurrentRouteEndpoint,
} from "../src/data/current-route-origin.js";
import { findNavigationRoute } from "../src/data/entrance-route.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const floor = read("../public/data/campuses/v-78/v-78-floor1.json");
const upper = read("../public/data/campuses/v-78/v-78-floor2.json");
const graph = read("../public/data/routing/v-78.json");
const corrected = withLibraryPassageGraph(graph);
const portals = corrected.nodes.slice(-2).map((node) => node.position);
const center = corrected.userConfirmedLibraryPassage.center;
const neighbourWall = {
  a: [-45.844, 44.9094],
  b: [-40.722, 43.2804],
};
const neighbourCenter = neighbourWall.a.map(
  (n, i) => (n + neighbourWall.b[i]) / 2,
);

test("real library corridor projections cross the confirmed open end in both directions and on its former centreline", () => {
  const before = JSON.stringify(floor);
  for (const [a, b] of [
    portals,
    [...portals].reverse(),
    [center, portals[0]],
    [center, portals[1]],
    [center, center],
  ])
    assert.equal(isRouteTrackingConnectorClear(floor, a, b), true);
  const stale = structuredClone(floor);
  stale.source.svgSha256 = "changed-source";
  assert.equal(
    isRouteTrackingConnectorClear(stale, ...portals),
    false,
    "without valid source evidence the old wall remains closed",
  );
  assert.equal(JSON.stringify(floor), before);
});

test("opening the library end cannot authorize a neighbouring room wall or another obstacle on the passage", () => {
  assert.ok(
    floor.walls.some(
      (wall) =>
        JSON.stringify(wall.a) === JSON.stringify(neighbourWall.a) &&
        JSON.stringify(wall.b) === JSON.stringify(neighbourWall.b),
    ),
  );
  const dx = neighbourWall.b[0] - neighbourWall.a[0],
    dz = neighbourWall.b[1] - neighbourWall.a[1];
  const length = Math.hypot(dx, dz),
    normal = [-dz / length, dx / length];
  const sides = [-0.35, 0.35].map((offset) =>
    neighbourCenter.map((n, i) => n + normal[i] * offset),
  );
  assert.equal(isRouteTrackingConnectorClear(floor, ...sides), false);
  assert.equal(isRouteTrackingConnectorClear(floor, sides[1], sides[0]), false);
  assert.equal(
    isRouteTrackingConnectorClear(floor, neighbourCenter, neighbourCenter),
    false,
  );
  const obstructed = structuredClone(floor);
  obstructed.walls.push({
    a: center.map((n, i) => n + (i ? 0.2 : 0)),
    b: center.map((n, i) => n - (i ? 0.2 : 0)),
  });
  assert.equal(
    isRouteTrackingConnectorClear(obstructed, ...portals),
    false,
    "the narrow exception never skips the remaining wall checks",
  );
});

test("fresh GPS origins on either side attach to their existing corridors and route across the confirmed passage", () => {
  const now = Date.now();
  const make = (point) =>
    makeCurrentRouteEndpoint(
      {
        source: "gps",
        campusId: "v-78",
        floorId: floor.id,
        floorEvidence: "manual-view-selection",
        point,
        timestamp: now,
        accuracyMeters: 4,
        status: "inside",
      },
      { now, snapToRoute: true, viewFloor: floor, campusId: "v-78" },
    );
  for (const [i, target] of [
    [0, "v-78--floor-2--a7o"],
    [1, "photo-stair:v-78-floor2-user-stair-library"],
  ]) {
    const made = make(portals[i]);
    assert.equal(made.ok, true);
    const attached = attachCurrentRouteEndpoint(
      corrected,
      made.endpoint,
      floor,
    );
    assert.equal(attached.ok, true, attached.message);
    const route = findNavigationRoute(graph, made.endpoint, target, {
      floors: [floor, upper],
    });
    assert.equal(route.ok, true, route.message);
    assert.equal(route.start.endpointKind, "user-location");
    assert.ok(route.edges.some((edge) => edge.id === LIBRARY_PASSAGE_EDGE_ID));
    assert.ok(
      route.nodes.every((node) => node.areaId !== "v-78-floor1-area-604"),
    );
  }
  const blocked = make(neighbourCenter);
  assert.equal(blocked.ok, true);
  const attached = attachCurrentRouteEndpoint(
    corrected,
    blocked.endpoint,
    floor,
  );
  assert.equal(
    attached.ok,
    false,
    "a GPS origin on the adjacent real wall is still rejected",
  );
});
