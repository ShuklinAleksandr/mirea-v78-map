import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getFloorMarkers, resolveRoom } from "../src/data/utils.js";
import {
  getMapStairMarkers,
  getPhotoStairMarkers,
  presentStairIdentity,
  stairLayoutFor,
  withConfirmedStairSearch,
} from "../src/map/stairs.js";
import { findPlaces } from "../src/data/place-search.js";

const floor = (level) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

test("legacy library point links and new schematic markers preserve the source transition and honest location", () => {
  const upper = floor(2);
  const original = structuredClone(upper);
  const raw = getFloorMarkers(upper).find((marker) =>
    marker.sourceIds.includes("v-78:edge:20734"),
  );
  const shown = presentStairIdentity(raw, upper);
  assert.equal(shown.layoutId, "v-78-floor2-user-stair-library");
  assert.equal(shown.building, null);
  assert.equal(shown.shapeReviewStatus, "user-confirmed-schematic");
  assert.deepEqual(shown.center, raw.center);
  assert.deepEqual(shown.targets, raw.targets);
  assert.deepEqual(shown.sourceIds, raw.sourceIds);
  assert.match(shown.note, /180°/);
  assert.match(shown.note, /физический этаж.*не установлены/i);
  assert.deepEqual(shown.shapeSourcePhotoIds, []);
  assert.equal(
    stairLayoutFor(
      { id: "unrelated-hall-point", kind: "stairs", center: [32, 35] },
      upper,
    ),
    null,
    "sharing the large hall never identifies another marker as the library stair",
  );
  assert.equal(
    stairLayoutFor({ ...raw, center: [32, 35], position: [32, 35] }, upper),
    null,
    "a changed source portal is not forced into the library schematic",
  );
  assert.deepEqual(upper, original);
});

test("confirmed stairs can be found by library text without changing or deduplicating the archived search index", () => {
  const source = JSON.parse(
    readFileSync(
      new URL("../public/data/search-index.json", import.meta.url),
      "utf8",
    ),
  );
  const original = structuredClone(source);
  const floors = [floor(1), floor(2)];
  const shown = withConfirmedStairSearch(source, floors);
  assert.equal(shown.length, source.length + 4);
  assert.deepEqual(shown.slice(0, source.length), source);
  const matches = findPlaces(shown, { query: "библиот" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].layoutId, "v-78-floor2-user-stair-library");
  assert.equal(matches[0].building, null);
  assert.deepEqual(matches[0].center, [30.523, 33.1784]);
  assert.deepEqual(
    withConfirmedStairSearch(shown, floors),
    shown,
    "loading a campus again never duplicates the extra search rows",
  );
  assert.deepEqual(
    withConfirmedStairSearch(shown, []),
    source,
    "unavailable confirmed models cannot leave stale search entries",
  );
  assert.deepEqual(source, original);
});

test("the photographed stair at A146 keeps its identity despite the source room label", () => {
  const first = floor(1);
  const before = JSON.stringify(first);
  const marker = getMapStairMarkers(first).find(
    (item) => item.layoutId === "v78-А-1-U у А-146",
  );
  const polygon = first.polygons.find((item) => item.id === marker.fitAreaId);
  assert.equal(polygon.label, "А-146");
  assert.equal(polygon.kind, "room");
  assert.equal(marker.kind, "stairs");
  assert.equal(marker.label, "Лестница А-146 · корпус А");
  assert.equal(marker.sourceLabel, "U у А-146");
  assert.deepEqual(marker.sourcePhotoIds, ["photo-3221"]);
  assert.deepEqual(marker.center, [92.4024, -7.4606]);
  assert.equal(marker.shapeReviewStatus, undefined);
  assert.equal(JSON.stringify(first), before);
});

test("search and polygon selections present the photographed A146 stair without relabelling the other A146 rooms", () => {
  const first = floor(1);
  const search = JSON.parse(
    readFileSync(
      new URL("../public/data/search-index.json", import.meta.url),
      "utf8",
    ),
  );
  const source = search.filter(
    (place) => place.floorId === first.id && place.label === "А-146",
  );
  const before = JSON.stringify(source);
  assert.equal(source.length, 4);
  const shown = source.map((place) => presentStairIdentity(place));
  const stair = shown.find((place) => place.kind === "stairs");
  assert.equal(stair.id, "v-78--floor-1--68n");
  assert.equal(stair.label, "Лестница А-146");
  assert.equal(stair.sourceLabel, "А-146");
  assert.equal(stair.sourceKind, "room");
  assert.match(stair.note, /между А-144 и А-148/);
  assert.equal(
    stair.sourceUrl,
    source.find((place) => place.id === stair.id).sourceUrl,
  );
  for (const room of shown.filter((place) => place.id !== stair.id)) {
    assert.equal(
      room,
      source.find((place) => place.id === room.id),
    );
    assert.equal(room.kind, "room");
    assert.equal(room.label, "А-146");
  }
  for (const incoming of [
    stair,
    stair.id,
    first.polygons.find((place) => place.id === stair.id),
  ]) {
    const resolved = resolveRoom(first, incoming);
    // Source geometry is deliberately unchanged; presentation owns the correction.
    assert.equal(resolved.kind, "room");
    const selected = presentStairIdentity(resolved, first);
    assert.equal(selected.kind, "stairs");
    assert.equal(selected.id, stair.id);
    assert.equal(selected.hasPolygon, true);
    assert.equal(selected.points, resolved.points);
    assert.equal(selected.center, resolved.center);
    const marker = getMapStairMarkers(first).find(
      (place) => place.layoutId === selected.layoutId,
    );
    assert.deepEqual(selected.targets, marker.targets);
    assert.deepEqual(selected.sourceIds, marker.sourceIds);
  }
  assert.equal(JSON.stringify(source), before);
});

test("model shorthand does not become a place name while the original label stays available", () => {
  const markers = [1, 2, 3].flatMap((level) =>
    getPhotoStairMarkers(floor(level)),
  );
  for (const marker of markers) {
    assert.doesNotMatch(marker.label, /(^|\s)U(\s|$)/);
    if (marker.sourceLabel) assert.ok(marker.layoutId);
  }
  assert.equal(markers.filter((marker) => marker.sourceLabel).length, 7);
  assert.equal(
    markers.find((marker) => marker.layoutId === "v78-А-1-ЛК-7").label,
    "ЛК-7 · корпус А",
  );
});

test("confirmed lower schemes state their user evidence while preserving the accepted upper stair", () => {
  const markers = [1, 2, 3].flatMap((level) =>
    getPhotoStairMarkers(floor(level)),
  );
  const confirmed = markers.filter(
    (marker) =>
      marker.shapeReviewStatus === "user-confirmed-schematic" &&
      marker.layoutId !== "v-78-floor2-user-stair-library",
  );
  assert.equal(confirmed.length, 3);
  for (const marker of confirmed) {
    assert.match(marker.note, /две зеркальные ветви/);
    assert.match(marker.note, /половине высоты/);
    assert.match(marker.note, /допущения модели/);
    assert.match(
      marker.note,
      /начало спуска находится ближе к коридору, а не к стене/,
    );
    assert.match(marker.label, /по описанию/);
    assert.equal(marker.geometryEvidence, "user-description-and-sketch");
    assert.deepEqual(marker.shapeSourcePhotoIds, []);
  }
  const ivc = confirmed.find(
    (marker) => marker.destinationStatus === "plan-unavailable",
  );
  assert.match(ivc.note, /План нижнего уровня и маршрут/);
  assert.match(ivc.destinationLabel, /ИВЦ/);
  assert.doesNotMatch(ivc.destinationLabel, /цоколь|этаж [0-9]/i);
  assert.equal(ivc.routingStatus, "display-only-no-source-transition");
  assert.deepEqual(ivc.targets, []);
  for (const marker of markers.filter((item) =>
    item.layoutId.endsWith("photo-stair-wide-hall"),
  )) {
    assert.equal(marker.label, "Главная лестница холла · корпус А");
    assert.equal(marker.shapeReviewStatus, undefined);
  }
});
