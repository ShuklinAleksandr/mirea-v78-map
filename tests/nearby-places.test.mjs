import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  rankNearbyPlaces,
  nearbyDistanceLabel,
} from "../src/data/nearby-places.js";
import {
  findPlaces,
  placeCategory,
  categoryForPlaceQuery,
  PLACE_CATEGORIES,
} from "../src/data/place-search.js";
import { findRoute } from "../src/data/routing.js";

const position = {
  source: "manual",
  campusId: "v-78",
  floorId: "f1",
  building: "А",
  point: [0, 0],
  placeId: "start",
};
const node = (id, x, areaId, floorId = "f1") => ({
  id,
  position: [x, 0],
  areaId,
  floorId,
  physicalLevel: floorId === "f1" ? 1 : 2,
  building: "А",
  sourceLevel: floorId === "f1" ? 1 : 2,
});
const edge = (id, from, to, cost, options = {}) => ({
  id,
  from,
  to,
  cost,
  eligible: true,
  kind: "corridor",
  bidirectional: true,
  ...options,
});
const rows = [
  {
    id: "near",
    campusId: "v-78",
    floorId: "f1",
    center: [1, 0],
    building: "А",
    label: "Буфет",
    kind: "cafeteria",
  },
  {
    id: "far",
    campusId: "v-78",
    floorId: "f1",
    center: [10, 0],
    building: "А",
    label: "Столовая",
    kind: "cafeteria",
  },
];
function graph(edges) {
  return {
    campusId: "v-78",
    units: "meters",
    status: "available",
    nodes: [
      node("s", 0, "start"),
      node("n", 1, "near"),
      node("f", 10, "far"),
      node("c", 20, "corridor"),
      node("r", 5, "classroom"),
    ],
    rooms: {
      start: { nodeId: "s", kind: "room", label: "А-101" },
      near: { nodeId: "n", kind: "cafeteria", label: "Буфет" },
      far: { nodeId: "f", kind: "cafeteria", label: "Столовая" },
      classroom: { nodeId: "r", kind: "room", label: "А-102" },
    },
    edges,
  };
}
const manifest = {
  campuses: [
    {
      id: "v-78",
      floors: [
        { id: "f1", level: 0, buildingLevels: { А: 1, Б: 2 } },
        { id: "f2", level: 1, buildingLevels: { А: 2, Б: 3 } },
      ],
    },
  ],
};

test("food groups real buffets, cafeterias and existing named Unifood records", () => {
  const records = [
    ...rows,
    { id: "kiosk", label: "Unifood", kind: "room" },
    { id: "not-food", label: "А-102", kind: "room" },
  ];
  assert.equal(
    PLACE_CATEGORIES.find((category) => category.id === "cafeteria").label,
    "Еда",
  );
  assert.equal(findPlaces(records, { category: "cafeteria" }).length, 3);
  assert.equal(placeCategory(records[2]), "cafeteria");
  assert.equal(categoryForPlaceQuery("Туалеты"), "toilet");
  assert.equal(categoryForPlaceQuery("буфет"), "cafeteria");
  assert.equal(categoryForPlaceQuery("Г-209"), null);
  assert.deepEqual(findPlaces(rows, { query: "Unifood" }), []);
  assert.deepEqual(
    findPlaces(records, { query: "унифуд" }).map((record) => record.id),
    ["kiosk"],
  );
});

test("natural nearby category queries retain category matching without changing numbered-room searches", () => {
  for (const query of [
    "еда",
    "буфет",
    "ближайший буфет",
    "столовая поблизости",
    "где поесть",
    "еда рядом со мной",
  ]) {
    assert.equal(categoryForPlaceQuery(query), "cafeteria", query);
    assert.equal(findPlaces(rows, { query }).length, 2, query);
  }
  assert.equal(categoryForPlaceQuery("туалет рядом"), "toilet");
  assert.equal(categoryForPlaceQuery("туал"), "toilet");
  const toilet = { id: "toilet", label: "Туалет Ж", kind: "toilet" };
  assert.deepEqual(findPlaces([toilet], { query: "туалет рядом" }), [toilet]);
  assert.equal(
    categoryForPlaceQuery("туалет рядом с Г-209"),
    null,
    "an explicit other reference point is not silently treated as the current location",
  );
  assert.equal(categoryForPlaceQuery("Г-209"), null);
});

test("nearest means an existing permitted route, not the visually closest room", () => {
  const data = graph([
    edge("sf", "s", "f", 10),
    edge("sc", "s", "c", 20),
    edge("cn", "c", "n", 19),
  ]);
  const result = rankNearbyPlaces(rows, { position, graph: data });
  assert.equal(result.mode, "routes");
  assert.equal(result.nearest.room.id, "far");
  assert.equal(result.nearest.distanceMeters, 10);
  assert.equal(nearbyDistanceLabel(result.nearest), "≈ 10 м по карте");
});

test("directionality and ineligible edges are respected without straight-line path fallback", () => {
  const data = graph([
    edge("wrong-way", "n", "s", 1, { bidirectional: false }),
    edge("invalid", "s", "n", 1, { eligible: false }),
    edge("valid", "s", "f", 10),
  ]);
  const result = rankNearbyPlaces(rows, { position, graph: data });
  assert.equal(result.nearest.room.id, "far");
  assert.equal(result.unreachableCount, 1);
  assert.equal(result.items[1].reachable, false);
  assert.equal(result.items[1].distanceMeters, null);
});

test("neither a classroom nor another candidate facility is used as a shortcut", () => {
  const data = graph([
    edge("sr", "s", "r", 5),
    edge("rf", "r", "f", 5),
    edge("sn", "s", "n", 1),
    edge("nf", "n", "f", 1),
  ]);
  const result = rankNearbyPlaces(rows, { position, graph: data });
  assert.equal(result.nearest.room.id, "near");
  assert.equal(
    result.items.find((entry) => entry.room.id === "far").reachable,
    false,
  );
});

test("the selected facility itself has zero distance", () => {
  const data = graph([edge("sn", "s", "n", 1)]);
  const result = rankNearbyPlaces(rows, {
    position: { ...position, placeId: "near", point: [1, 0] },
    graph: data,
  });
  assert.equal(result.nearest.room.id, "near");
  assert.equal(result.nearest.distanceMeters, 0);
  assert.equal(nearbyDistanceLabel(result.nearest), "Вы здесь");
});

test("GPS or a viewed floor alone never produces indoor nearest results", () => {
  for (const location of [
    null,
    { source: "gps", campusId: "v-78", point: [0, 0], floorId: null },
    { ...position, point: null },
  ]) {
    const result = rankNearbyPlaces(rows, { position: location, manifest });
    assert.equal(result.mode, "no-location");
    assert.equal(result.nearest, null);
  }
});

test("a free point compares only known physical floors and labels straight-line distance", () => {
  const otherRows = [
    ...rows,
    { ...rows[0], id: "upstairs", floorId: "f2", center: [0, 0] },
    { ...rows[0], id: "different-wing-floor", building: "Б", center: [0, 0] },
    { ...rows[0], id: "unknown", building: null, center: [0, 0] },
  ];
  const result = rankNearbyPlaces(otherRows, {
    position: { ...position, placeId: null },
    manifest,
  });
  assert.equal(result.mode, "straight-line");
  assert.equal(result.nearest.room.id, "near");
  assert.match(
    nearbyDistanceLabel(result.nearest),
    /по прямой.*проходы не учтены/u,
  );
  for (const id of ["upstairs", "different-wing-floor", "unknown"])
    assert.equal(
      result.items.find((entry) => entry.room.id === id).distanceMeters,
      null,
    );
});

test("an arbitrary point cannot be attached to a graph room by proximity", () => {
  const data = graph([edge("sn", "s", "n", 1)]);
  const result = rankNearbyPlaces(rows, {
    position: { ...position, placeId: null },
    manifest,
    graph: data,
  });
  assert.equal(result.mode, "straight-line");
  assert.equal(result.nearest.distanceKind, "straight-line");
});

test("a stale room ID from another floor cannot supply a graph origin", () => {
  const data = graph([edge("sn", "s", "n", 1)]);
  data.rooms.start.floorId = "f2";
  const result = rankNearbyPlaces(rows, { position, manifest, graph: data });
  assert.equal(result.mode, "straight-line");
  assert.equal(result.nearest.distanceKind, "straight-line");
});

test("V78 nearby graph winners are reachable with the production route algorithm", () => {
  const allRows = JSON.parse(
    readFileSync(new URL("../public/data/search-index.json", import.meta.url)),
  ).filter((room) => room.campusId === "v-78");
  const data = JSON.parse(
    readFileSync(new URL("../public/data/routing/v-78.json", import.meta.url)),
  );
  const origin = allRows.find((room) => room.label === "Г-209");
  const loc = {
    source: "manual",
    campusId: "v-78",
    floorId: origin.floorId,
    point: origin.center,
    placeId: origin.id,
  };
  for (const category of ["cafeteria", "toilet", "medical", "cloakroom"]) {
    const result = rankNearbyPlaces(findPlaces(allRows, { category }), {
      position: loc,
      graph: data,
    });
    for (const candidate of result.items
      .filter((entry) => entry.reachable)
      .slice(0, 3))
      assert.equal(
        findRoute(data, origin, candidate.room).ok,
        true,
        candidate.room.id,
      );
  }
  assert.equal(
    allRows.filter((room) => /unifood|унифуд|юнифуд/iu.test(room.label)).length,
    0,
    "No kiosk is fabricated for the current archive",
  );
});

test("a fresh GPS context can rank the chosen physical floor while stale and unknown-floor GPS cannot", () => {
  const now = 100000;
  const gps = {
    source: "gps",
    campusId: "v-78",
    point: [9, 0],
    timestamp: now,
    expiresAt: now + 60000,
    trackingStatus: "live",
    floorId: "f1",
    building: "А",
    physicalLevel: 1,
    floorEvidence: "manual-view-selection",
  };
  const result = rankNearbyPlaces(rows, { position: gps, manifest, now });
  assert.equal(result.mode, "straight-line");
  assert.equal(result.floorContext, "view");
  assert.equal(result.nearest.room.id, "far");
  assert.equal(result.nearest.distanceMeters, 1);
  assert.equal(
    rankNearbyPlaces(rows, {
      position: { ...gps, floorId: null },
      manifest,
      now,
    }).mode,
    "no-location",
  );
  assert.equal(
    rankNearbyPlaces(rows, { position: gps, manifest, now: now + 60001 }).mode,
    "no-location",
  );
  assert.equal(
    rankNearbyPlaces(rows, {
      position: { ...gps, trackingStatus: "stopped" },
      manifest,
      now,
    }).mode,
    "no-location",
  );
});

test("a route across levels gives measured horizontal metres as a lower bound instead of fabricating stair length", () => {
  const data = graph([
    edge("sc", "s", "c", 20),
    edge("cf", "c", "f", 10, { kind: "stairs" }),
  ]);
  const target = data.nodes.find((n) => n.id === "f");
  target.floorId = "f2";
  target.physicalLevel = 2;
  const result = rankNearbyPlaces([{ ...rows[1], floorId: "f2" }], {
    position,
    graph: data,
    manifest,
  });
  assert.equal(result.nearest.distanceMeters, null);
  assert.equal(result.nearest.horizontalMeters, 20);
  assert.match(
    nearbyDistanceLabel(result.nearest),
    /от 20 м по карте.*с переходами/,
  );
});
