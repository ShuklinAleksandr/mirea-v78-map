import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  pointOf,
  physicalLevel,
  levelLabel,
  floorsForBuilding,
  getFloorMarkers,
  resolveRoom,
  geometryEvidence,
} from "../src/data/utils.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const manifest = read("public/data/manifest.json");
const search = read("public/data/search-index.json");
const floors = manifest.campuses.flatMap((c) =>
  c.floors.map((f) => read(`public${f.url}`)),
);
const floorById = new Map(floors.map((f) => [f.id, f]));
const campus = (id) => manifest.campuses.find((c) => c.id === id);

test("physical floor numbering preserves the mixed-height levels at Vernadskogo 78", () => {
  const zero = floorById.get("v-78-floor0"),
    one = floorById.get("v-78-floor1");
  assert.equal(physicalLevel(zero, "Г"), 1);
  assert.equal(physicalLevel(zero, "А"), null); // No A ground floor invented.
  assert.equal(physicalLevel(one, "Г"), 2);
  assert.equal(physicalLevel(one, "А"), 1);
  assert.equal(levelLabel(one, "Г"), "2 этаж");
  assert.equal(levelLabel(one), "Уровень 1");
  assert.equal(physicalLevel(floorById.get("v-78-floor4"), "А"), 4);
  assert.deepEqual(
    floorsForBuilding(campus("v-78").floors, "Г").map((f) =>
      physicalLevel(f, "Г"),
    ),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    floorsForBuilding(campus("v-78").floors, "А").map((f) =>
      physicalLevel(f, "А"),
    ),
    [1, 2, 3, 4],
  );
});

test("source internal levels and the MP-1 basement are not used as physical floor numbers", () => {
  const f = campus("v-86").floors.find((f) => f.level === 1);
  assert.equal(f.sourceInternalLevel, 3);
  assert.equal(physicalLevel(f, "Л"), 1);
  assert.equal(floorById.get("mp-1-floor0").level, -1);
  assert.equal(levelLabel(floorById.get("mp-1-floor0"), "А"), "Цоколь");
  assert.equal(campus("mp-1").units, "map-units");
  assert.equal(campus("mp-1").sourceMeterFidelity, "absent-schematic");
});

test("every real search result resolves to its polygon or a source marker with a usable camera target", () => {
  let points = 0;
  for (const entry of search) {
    const floor = floorById.get(entry.floorId);
    const result = resolveRoom(floor, entry);
    assert.ok(result, entry.id);
    assert.equal(result.label, entry.label);
    assert.equal(result.hasPolygon, entry.hasPolygon, entry.id);
    assert.equal(result.sourceUrl, entry.sourceUrl);
    assert.ok(pointOf(result)?.every(Number.isFinite), entry.id);
    if (!result.hasPolygon) {
      points++;
      assert.equal(result.kind, "stairs");
      assert.equal(geometryEvidence(result).kind, "point");
      assert.equal(
        result.targets.length,
        0,
        "MP-1 has no proven inter-floor links",
      );
    }
  }
  assert.equal(points, 70);
});

test("all 86 proven stair transitions survive marker normalization and point to existing floors", () => {
  const uniqueTransitions = new Set();
  let endpointCount = 0;
  for (const floor of floors) {
    const markers = getFloorMarkers(floor);
    for (const transition of floor.transitions) {
      uniqueTransitions.add(transition.id);
      endpointCount++;
      const marker = markers.find(
        (m) =>
          m.sourceIds.includes(transition.id) &&
          JSON.stringify(m.center) === JSON.stringify(transition.position),
      );
      assert.ok(marker, transition.id);
      assert.deepEqual(marker.center, transition.position);
      assert.ok(
        marker.targets.some((t) => t.floorId === transition.targetFloorId),
      );
      assert.ok(floorById.has(transition.targetFloorId));
      assert.equal(marker.kind, "stairs");
      assert.equal(marker.hasPolygon, false);
      const other = floorById.get(transition.targetFloorId);
      assert.ok(
        other.transitions.some(
          (t) => t.id === transition.id && t.targetFloorId === floor.id,
        ),
      );
    }
  }
  assert.equal(uniqueTransitions.size, 86);
  assert.equal(endpointCount, 172);
});

test("marker-only results work when their source has position but no center", () => {
  const floor = {
    id: "test-floor",
    campusId: "test",
    level: 1,
    polygons: [],
    markers: [
      {
        id: "stairs",
        kind: "stairs",
        position: [12, 34],
        label: "Лестница",
        targetFloorId: "upper",
        targetPosition: [12, 35],
      },
    ],
    transitions: [
      {
        id: "stairs",
        kind: "stairs",
        position: [12, 34],
        targetFloorId: "upper",
        targetPosition: [12, 35],
      },
    ],
  };
  assert.deepEqual(resolveRoom(floor, { id: "stairs" }).center, [12, 34]);
  const markers = getFloorMarkers(floor);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].targets.length, 1);
  assert.equal(resolveRoom(floor, { id: "missing" }), null);
});

test("uncertain building placement remains distinct from source-plan polygon confidence", () => {
  const floor = floorById.get("v-86-floor1");
  assert.ok(floor.uncertaintyRegions.length > 0);
  const room = floor.polygons.find(
    (p) => p.label && p.placementConfidence === "unverified",
  );
  assert.ok(room);
  const resolved = resolveRoom(
    floor,
    search.find((r) => r.id === room.id),
  );
  assert.equal(resolved.placementConfidence, "unverified");
  assert.equal(resolved.confidence, "source-plan");
});

test("the named sidewalk and its two outdoor approaches never become building volumes", () => {
  const floor = floorById.get("v-78-floor2");
  assert.equal(floor.outdoorPolygons.length, 3);
  const sidewalk = floor.polygons.find(
    (p) => p.label === "Тротуар вдоль ул. Коштоянца",
  );
  assert.ok(sidewalk);
  assert.equal(sidewalk.sourceKind, "room"); // Incorrect broad source category preserved for provenance.
  assert.equal(sidewalk.kind, "outdoor");
  assert.equal(sidewalk.exteriorEligible, false);
  assert.ok(sidewalk.classification.evidence.length);
  for (const p of floor.outdoorPolygons)
    assert.equal(p.exteriorEligible, false);
  assert.ok(floor.exteriorBounds[0] > floor.bounds[0]);
  assert.ok(floor.exteriorBounds[3] < floor.bounds[3]);
  const resolved = resolveRoom(
    floor,
    search.find((r) => r.id === sidewalk.id),
  );
  assert.equal(geometryEvidence(resolved).kind, "outdoor");
});

test("a rejected stair shape never claims its flights were verified from a fire plan", () => {
  const result = geometryEvidence({
    shapeReviewStatus: "requires-correction",
    sourcePhotoIds: ["IMG_3220"],
  });
  assert.equal(result.kind, "review");
  assert.match(result.label, /схема|Схема/);
  assert.doesNotMatch(result.label, /Марши по пожарному плану/);
});
