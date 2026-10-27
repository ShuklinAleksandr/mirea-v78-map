import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getFloorMarkers } from "../src/data/utils.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import {
  middleStairArrival,
  inspectMiddleStairArrival,
} from "../src/map/stair-arrivals.js";

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const rawRegistry = () => read("../public/data/stair-layouts.json");
const readFloor = (level) =>
  read(`../public/data/campuses/v-78/v-78-floor${level}.json`);
const getLayout = (registry, id = "v78-Г-2-ЛК2") =>
  registry.layouts.find((layout) => layout.id === id);
const mutateTransition = (floor, id, mutate) => {
  for (const list of [floor.markers, floor.transitions])
    for (const item of list) if (item.id === id) mutate(item);
};

test("G3 LK2 gains a source-backed incoming profile while the original ascent and source coordinates stay unchanged", () => {
  const registry = rawRegistry(),
    floor = readFloor(2);
  const layout = getLayout(registry),
    lower = getLayout(registry, "v78-Г-1-ЛК2");
  const source = structuredClone({ registry, floor });
  const result = inspectMiddleStairArrival(layout, floor, registry);
  assert.equal(result.status, "available");
  const child = result.arrival;
  assert.equal(child.id, "v78-Г-2-ЛК2:incoming");
  assert.equal(child.parentLayoutId, layout.id);
  assert.equal(child.floorId, floor.id);
  assert.equal(child.pairedLayoutId, lower.id);
  assert.equal(child.sourceLowerLayoutId, lower.id);
  assert.equal(child.sourceLowerFloorId, "v-78-floor1");
  assert.deepEqual(child.sourceEdgeIds, ["v-78:edge:20721"]);
  assert.deepEqual(
    child.frame,
    layout.frame,
    "display uses the current photographed cell without distorting a lower frame",
  );
  assert.notDeepEqual(
    child.frame,
    lower.frame,
    "the source floor coordinate discrepancy is not silently called exact alignment",
  );
  assert.equal(child.horizontalStatus, "current-photo-approximate-frame");
  assert.deepEqual(
    child.flights.map((flight) => [flight.baseFraction, flight.topFraction]),
    [
      [-1, -0.5],
      [-0.5, 0],
    ],
  );
  assert.deepEqual(
    layout.flights.map((flight) => [flight.baseFraction, flight.topFraction]),
    [
      [0, 0.5],
      [0.5, 1],
    ],
  );
  assert.deepEqual(
    child.landings.map((landing) => landing.elevationFraction),
    [-0.5, -1, 0],
  );
  assert.deepEqual(child.sourcePhotoIds, ["photo-3156", "photo-3151"]);
  assert.equal(child.evidence.horizontalBasis, "current-photo-cell-frame");
  assert.equal(child.incomingDisplayOnly, true);
  assert.equal(child.displayOnlyArrival, true);
  assert.equal(child.levelRole, "upper-arrival");
  assert.equal(child.displayCutout, true);
  const area = floor.polygons.find(
    (polygon) => polygon.id === layout.fitAreaId,
  );
  assert.deepEqual(
    child.displayCutoutPoints,
    area.points.map(([x, z]) => [
      area.center[0] + (x - area.center[0]) * 0.98,
      area.center[1] + (z - area.center[1]) * 0.98,
    ]),
  );
  assert.deepEqual(
    middleStairArrival(layout, floor, registry, {
      markers: getFloorMarkers(floor),
    }),
    child,
  );
  assert.deepEqual({ registry, floor }, source);
  child.frame.origin[0] += 10;
  child.flights[0].from[0] += 10;
  child.landings[0].points[0][0] += 10;
  assert.deepEqual(
    { registry, floor },
    source,
    "the returned display geometry owns its coordinate arrays",
  );
});

test("middle-floor arrival coverage is limited to the 16 matching photo/transition pairs", () => {
  const registry = rawRegistry();
  const floors = new Map(
    [0, 1, 2, 3, 4].map((level) => {
      const floor = readFloor(level);
      return [floor.id, floor];
    }),
  );
  const before = structuredClone({ registry, floors: [...floors] });
  const audits = registry.layouts.map((layout) =>
    inspectMiddleStairArrival(layout, floors.get(layout.floorId), registry),
  );
  assert.deepEqual(
    audits
      .filter((audit) => audit.arrival)
      .map((audit) => audit.layoutId)
      .sort(),
    [
      "v78-Г-1-ЛК2",
      "v78-Г-1-ЛК3",
      "v78-Г-2-ЛК1",
      "v78-Г-2-ЛК2",
      "v78-Г-2-ЛК3",
      "v78-В-1-ЛК2",
      "v78-В-2-ЛК2",
      "v78-Б-2-ЛК2",
      "v78-А-2-ЛК-7",
      "v78-А-3-ЛК-2",
      "v78-А-3-ЛК-3",
      "v78-А-3-ЛК-4",
      "v78-А-3-ЛК-5",
      "v78-А-3-ЛК-7",
      "v78-А-3-ЛК-8",
      "v78-А-3-ЛК-9",
    ].sort(),
  );
  const byId = new Map(audits.map((audit) => [audit.layoutId, audit]));
  assert.equal(
    byId.get("v78-Б-1-ЛК2").reason,
    "lower-photographed-shape-missing",
  );
  assert.equal(
    byId.get("v78-Г-1-ЛК1").arrival,
    null,
    "a missing G1 LK1 photo cannot be replaced by another stair",
  );
  assert.equal(
    byId.get("v78-В-2-ЛК3").arrival,
    null,
    "a matching name without a down transition is insufficient",
  );
  assert.ok(
    byId
      .get("v78-А-2-ЛК-9")
      .rejected.some(
        (item) => item.reason === "lower-portal-outside-photo-frame",
      ),
  );
  assert.equal(
    byId.get("v-78-floor2-photo-stair-wide-hall").reason,
    "explicit-or-user-confirmed-role",
  );
  assert.deepEqual({ registry, floors: [...floors] }, before);
});

test("a changed source edge, portal, floor, photograph or topology cannot manufacture a middle arrival", () => {
  for (const mutate of [
    ({ floor }) => {
      floor.id = "other";
    },
    ({ floor }) => {
      floor.units = "pixels";
    },
    ({ floor }) => {
      floor.level = NaN;
    },
    ({ floor }) => {
      floor.markers = floor.markers.filter(
        (item) => item.id !== "v-78:edge:20721",
      );
      floor.transitions = floor.transitions.filter(
        (item) => item.id !== "v-78:edge:20721",
      );
    },
    ({ floor }) =>
      mutateTransition(floor, "v-78:edge:20721", (item) => {
        item.targetFloorId = "v-78-floor0";
      }),
    ({ floor }) =>
      mutateTransition(floor, "v-78:edge:20721", (item) => {
        item.targetPosition = [9999, 9999];
      }),
    ({ floor }) =>
      mutateTransition(floor, "v-78:edge:20721", (item) => {
        item.position = [9999, 9999];
      }),
    ({ layout }) => {
      layout.levelRole = "lower-departure";
    },
    ({ layout }) => {
      layout.shapeReviewStatus = "user-confirmed-schematic";
    },
    ({ layout }) => {
      layout.sourcePhotoIds = [];
    },
    ({ layout }) => {
      layout.frame.axisU = [0, 0];
    },
    ({ registry }) => {
      getLayout(registry, "v78-Г-1-ЛК2").sourcePhotoIds = [];
    },
    ({ registry }) => {
      getLayout(registry, "v78-Г-1-ЛК2").physicalFloor = 1;
    },
    ({ registry }) => {
      getLayout(registry, "v78-Г-1-ЛК2").flights[0].from[0] += 0.01;
    },
    ({ registry }) => {
      getLayout(registry, "v78-Г-1-ЛК2").landings[0].points[0][0] += 0.01;
    },
    ({ registry }) => {
      const duplicate = structuredClone(getLayout(registry, "v78-Г-1-ЛК2"));
      duplicate.id = "ambiguous-other-cell";
      registry.layouts.push(duplicate);
    },
  ]) {
    const registry = rawRegistry(),
      floor = readFloor(2),
      layout = getLayout(registry);
    mutate({ registry, floor, layout });
    assert.equal(
      middleStairArrival(layout, floor, registry),
      null,
      mutate.toString(),
    );
  }
});

test("documented hall display changes preserve generic pair evidence and source roles stay separate", () => {
  const registry = rawRegistry(),
    floor = readFloor(2);
  const layout = getLayout(registry);
  assert.deepEqual(
    middleStairArrival(layout, getHallAdjacencyView(floor), registry),
    middleStairArrival(layout, floor, registry),
  );
  for (const id of [
    "v-78-floor2-photo-stair-wide-hall",
    "v-78-floor2-photo-stair-A154-arrival",
    "v-78-floor1-user-stair-basement",
  ])
    assert.equal(
      middleStairArrival(getLayout(registry, id), floor, registry),
      null,
      id,
    );
  assert.equal(
    middleStairArrival(
      { ...layout, id: "library", existenceStatus: "user-confirmed-existence" },
      floor,
      registry,
    ),
    null,
  );
});

test("portal tolerance is a bounded source distance and never authorizes another distant cell", () => {
  const registry = rawRegistry(),
    floor = readFloor(2),
    layout = getLayout(registry);
  const lower = getLayout(registry, "v78-Г-1-ЛК2");
  const at = (u) =>
    lower.frame.origin.map(
      (value, i) =>
        value +
        lower.frame.axisU[i] * u +
        lower.frame.axisV[i] * lower.frame.size[1] * 0.7,
    );
  const original = structuredClone(floor);
  mutateTransition(floor, "v-78:edge:20721", (item) => {
    item.targetPosition = at(-0.05);
  });
  assert.ok(
    middleStairArrival(layout, floor, registry),
    "a source doorway 5 cm outside its photo frame is accepted",
  );
  assert.equal(
    middleStairArrival(layout, floor, registry, { portalTolerance: 0 }),
    null,
  );
  mutateTransition(floor, "v-78:edge:20721", (item) => {
    item.targetPosition = at(-0.2);
  });
  assert.equal(
    middleStairArrival(layout, floor, registry, { portalTolerance: 100 }),
    null,
    "even a caller cannot enlarge the source allowance beyond 10 cm",
  );
  assert.notDeepEqual(
    floor,
    original,
    "fixture deliberately changed portals only",
  );
});
