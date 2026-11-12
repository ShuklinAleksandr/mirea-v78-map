import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import polygonClipping from "polygon-clipping";
import { libraryStairLayoutsForFloor } from "../src/map/library-stair.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import {
  createStaircase,
  getMapStairMarkers,
  resolveStairTarget,
  stairLayoutFor,
  presentStairIdentity,
  getStairDisplayCutouts,
} from "../src/map/stairs.js";
import { getFloorMarkers } from "../src/data/utils.js";
import { entranceStairPortals } from "../src/data/entrance-stair-portals.js";

const readFloor = (level = 2) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../public/data/campuses/v-78/v-78-floor${level}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
const world = (layout, [u, v]) =>
  layout.frame.origin.map(
    (value, i) =>
      value +
      layout.frame.axisU[i] * u * layout.frame.size[0] +
      layout.frame.axisV[i] * v * layout.frame.size[1],
  );
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;

test("library descent preserves its source start, heads toward the entrance wall and returns after a half-height landing", () => {
  const floor = readFloor();
  const original = structuredClone(floor);
  const layouts = libraryStairLayoutsForFloor(floor);
  assert.equal(layouts.length, 2);
  const layout = layouts[0];
  assert.equal(layout.flights.length, 2);
  const [outward, returning] = layout.flights;
  assert.ok(near(world(layout, outward.from), [30.523, 33.1784]));
  assert.deepEqual(
    layout.flights.map(({ baseFraction, topFraction }) => [
      baseFraction,
      topFraction,
    ]),
    [
      [0, -0.5],
      [-0.5, -1],
    ],
  );
  const start = world(layout, outward.from);
  const turn = world(layout, outward.to);
  const returnStart = world(layout, returning.from);
  const end = world(layout, returning.to);
  const along = [turn[0] - start[0], turn[1] - start[1]];
  const back = [end[0] - returnStart[0], end[1] - returnStart[1]];
  assert.ok(
    along[0] > 0 && along[1] > 0,
    "first flight heads toward the outside entrance side",
  );
  const wallA = [29.075, 40.5804],
    wallB = [36.786, 39.0154];
  const wallDistance = (point) =>
    Math.abs(
      (wallB[0] - wallA[0]) * (wallA[1] - point[1]) -
        (wallA[0] - point[0]) * (wallB[1] - wallA[1]),
    ) / Math.hypot(wallB[0] - wallA[0], wallB[1] - wallA[1]);
  assert.ok(wallDistance(turn) < wallDistance(start));
  assert.ok(Math.abs(along[0] * back[1] - along[1] * back[0]) < 1e-7);
  assert.ok(
    along[0] * back[0] + along[1] * back[1] < 0,
    "the second flight turns through 180 degrees",
  );
  const intermediate = layout.landings.filter(
    (landing) => landing.role === "intermediate",
  );
  assert.equal(intermediate.length, 1);
  assert.equal(intermediate[0].elevationFraction, -0.5);
  assert.deepEqual(layout.sourceMarkerIds, ["v-78:edge:20734"]);
  assert.equal(layout.building, null);
  assert.equal(layout.shapeReviewStatus, "user-confirmed-schematic");
  assert.equal(layout.existenceStatus, "user-confirmed-existence");
  assert.equal(layout.levelRole, "upper-arrival");
  assert.equal(layout.pairedLayoutId, undefined);
  assert.deepEqual(layout.sourcePhotoIds, []);
  assert.deepEqual(layout.shapeSourcePhotoIds, []);
  assert.equal(layout.routingStatus, "display-only-no-source-flight-path");
  assert.match(layout.note, /Нижний вид показан отдельно/);
  assert.match(layout.note, /совмещение.*не установлено/);
  assert.deepEqual(floor, original);
});

test("the entire library schematic and its local shaft opening stay within the known hall", () => {
  const floor = readFloor();
  const [layout] = libraryStairLayoutsForFloor(floor);
  const hall = floor.polygons.find(
    (polygon) => polygon.id === layout.fitAreaId,
  );
  for (const ring of [layout.footprint, ...layout.displayCutoutFootprints]) {
    assert.deepEqual(
      polygonClipping.difference(
        [ring.map((p) => world(layout, p))],
        [hall.points, ...hall.holes],
      ),
      [],
    );
  }
  assert.equal(
    layout.displayCutoutFootprints[0].length,
    4,
    "one bounded local opening exposes both flights without a full-height strip",
  );
  assert.ok(layout.frame.size[0] <= 3.6 && layout.frame.size[1] <= 5.5);
  assert.ok(
    !near(world(layout, layout.flights[1].to), [40.407, 22.8264]),
    "the model does not stretch toward the lower graph portal",
  );
  assert.equal(libraryStairLayoutsForFloor(readFloor(1)).length, 2);
});

test("library shaft has four below-floor walls, a receiving platform and a bounded local bottom without a new lower level", () => {
  const floor = readFloor();
  const before = structuredClone(floor);
  const [layout] = libraryStairLayoutsForFloor(floor);
  assert.equal(layout.enclosureWalls.length, 4);
  assert.equal(
    layout.interiorDisplayStatus,
    "local-stairwell-cutaway-not-a-lower-floor-plan",
  );
  assert.match(layout.enclosureStatus, /approximate/);
  assert.deepEqual(layout.focusDirectionLocal, [0.12, 3, -0.2]);
  for (const [i, wall] of layout.enclosureWalls.entries()) {
    assert.deepEqual(wall.from, layout.footprint[i]);
    assert.deepEqual(wall.to, layout.footprint[(i + 1) % 4]);
    assert.equal(wall.bottomFraction, -1);
    assert.equal(wall.topFraction, 0);
    assert.equal(wall.thickness, 0.14);
  }
  const landing = layout.landings.find(
    (item) => item.role === "arrival-display-only",
  );
  assert.equal(landing.elevationFraction, -1);
  const end = layout.flights[1].to;
  assert.ok(landing.points.some((p) => p[1] === end[1]));
  const bottom = layout.landings.find(
    (item) => item.role === "shaft-bottom-display-only",
  );
  assert.equal(bottom.elevationFraction, -1.05);
  assert.deepEqual(bottom.points, layout.footprint);
  assert.equal(
    layout.landings.find((item) => item.role === "intermediate")
      .elevationFraction,
    -0.5,
  );
  assert.equal(
    layout.interiorDisplayStatus,
    "local-stairwell-cutaway-not-a-lower-floor-plan",
  );
  assert.doesNotMatch(layout.note, /v-78|20734/);
  const group = createStaircase(
    { layoutId: layout.id, position: layout.center, center: layout.center },
    floor,
  );
  try {
    const walls = group.children.find((mesh) =>
      mesh.name.endsWith(" · enclosure"),
    );
    assert.ok(walls, "production renderer draws actual enclosure geometry");
    walls.geometry.computeBoundingBox();
    assert.ok(walls.geometry.boundingBox.min.y < -3.4);
    assert.ok(
      walls.geometry.boundingBox.max.y < 0.15,
      "enclosure stays at or below the current floor",
    );
    const landings = group.children.find((mesh) =>
      mesh.name.endsWith(" · landing"),
    );
    landings.geometry.computeBoundingBox();
    assert.ok(
      landings.geometry.boundingBox.min.y < -3.7,
      "a real local bottom closes the view below the return flight",
    );
  } finally {
    group.traverse((object) => {
      object.geometry?.dispose();
      for (const material of [].concat(object.material || []))
        material.dispose();
    });
  }
  assert.deepEqual(floor, before);
  assert.equal(libraryStairLayoutsForFloor(readFloor(1)).length, 2);
});

test("the documented hall adjacency view retains the guarded library module while unknown display changes do not", () => {
  const source = readFloor();
  const view = getHallAdjacencyView(source);
  const before = structuredClone(view);
  assert.equal(view.userConfirmedDisplayAdjacency.applied, true);
  assert.equal(libraryStairLayoutsForFloor(view).length, 2);
  assert.deepEqual(view, before);
  for (const mutate of [
    (floor) => {
      floor.userConfirmedDisplayAdjacency.sourceGeometrySha256 = "unknown";
    },
    (floor) => {
      floor.userConfirmedDisplayAdjacency.sourceHallId = "other";
    },
    (floor) => {
      floor.userConfirmedDisplayAdjacency.applied = false;
    },
    (floor) => {
      floor.polygons
        .find((p) => p.id === "v-78-floor2-area-6")
        .points.find((p) => near(p, [29.075, 40.5804]))[0] += 0.01;
    },
    (floor) => {
      const [layout] = libraryStairLayoutsForFloor(floor);
      floor.polygons
        .find((p) => p.id === "v-78-floor2-area-6")
        .holes.push(layout.footprint.map((p) => world(layout, p)));
    },
  ]) {
    const changed = structuredClone(view);
    mutate(changed);
    assert.equal(
      libraryStairLayoutsForFloor(changed).some(
        (layout) => layout.id === "v-78-floor2-user-stair-library",
      ),
      false,
    );
  }
});

test("library schematic refuses changed source identity, geometry and graph endpoints", () => {
  const mutations = [
    (floor) => {
      floor.id = "v-78-floor1";
    },
    (floor) => {
      floor.campusId = "other";
    },
    (floor) => {
      floor.level = 1;
    },
    (floor) => {
      floor.units = "pixels";
    },
    (floor) => {
      floor.markers.find((m) => m.id === "v-78:edge:20734").position[0] += 0.01;
    },
    (floor) => {
      floor.transitions.find(
        (m) => m.id === "v-78:edge:20734",
      ).targetPosition[1] += 0.01;
    },
    (floor) => {
      floor.markers.find((m) => m.id === "v-78:edge:20734").sourceId =
        "unknown";
    },
    (floor) => {
      floor.transitions = [];
    },
    (floor) => {
      floor.markers.push(
        structuredClone(floor.markers.find((m) => m.id === "v-78:edge:20734")),
      );
    },
    ...[
      "v-78-floor2-area-6",
      "v-78--floor-2--9yc",
      "v-78--floor-2--9yb",
    ].flatMap((id) => [
      (floor) => {
        floor.polygons.find((p) => p.id === id).points[0][0] += 0.01;
      },
      (floor) => {
        floor.polygons.find((p) => p.id === id).center[1] += 0.01;
      },
      (floor) => {
        floor.polygons.find((p) => p.id === id).kind = "room";
      },
      (floor) => {
        floor.polygons = floor.polygons.filter((p) => p.id !== id);
      },
    ]),
  ];
  for (const mutate of mutations) {
    const floor = readFloor();
    mutate(floor);
    const before = structuredClone(floor);
    assert.equal(
      libraryStairLayoutsForFloor(floor).some(
        (layout) => layout.id === "v-78-floor2-user-stair-library",
      ),
      false,
    );
    assert.deepEqual(floor, before);
  }
  assert.deepEqual(libraryStairLayoutsForFloor(null), []);
  const [first] = libraryStairLayoutsForFloor(readFloor());
  first.frame.size[0] = 500;
  assert.equal(
    libraryStairLayoutsForFloor(readFloor())[0].frame.size[0],
    3.6,
    "results do not share mutable model state",
  );
});

test("all four entrance stair views retain exact original portal targets without geometric pairing", () => {
  const floors = [readFloor(1), readFloor(2)];
  const before = JSON.stringify(floors);
  for (const reference of entranceStairPortals) {
    const floor = floors.find((item) => item.id === reference.floorId);
    const marker = getMapStairMarkers(floor).find(
      (item) => item.layoutId === reference.layoutId,
    );
    assert.ok(marker, reference.layoutId);
    const layout = stairLayoutFor(marker, floor);
    assert.equal(layout.pairedLayoutId, undefined);
    assert.deepEqual(marker.center, reference.position);
    assert.deepEqual(marker.sourceIds, [reference.sourceEdgeId]);
    assert.equal(marker.targets.length, 1);
    const raw = getFloorMarkers(floor).find((item) =>
      item.sourceIds.includes(reference.sourceEdgeId),
    );
    assert.equal(presentStairIdentity(raw, floor).layoutId, reference.layoutId);
    assert.deepEqual(marker.targets, raw.targets);
    const target = marker.targets[0];
    const targetFloor = floors.find((item) => item.id === target.floorId);
    const other = entranceStairPortals.find(
      (item) =>
        item.sourceEdgeId === reference.sourceEdgeId &&
        item.floorId === target.floorId,
    );
    const resolved = resolveStairTarget(marker, floor, targetFloor, target);
    assert.equal(resolved.layoutId, other.layoutId);
    assert.deepEqual(resolved.center, target.center);
    assert.deepEqual(resolved.targets[0].center, reference.position);
  }
  assert.equal(JSON.stringify(floors), before);
});

test("new local stair footprints fit known source areas without changing toilets or creating lower cutouts", () => {
  for (const level of [1, 2]) {
    const floor = readFloor(level),
      before = JSON.stringify(floor);
    for (const layout of libraryStairLayoutsForFloor(floor)) {
      const points = layout.footprint.map((p) => world(layout, p));
      const area = floor.polygons.find((p) => p.id === layout.fitAreaId);
      assert.deepEqual(
        polygonClipping.difference([points], [area.points, ...area.holes]),
        [],
        layout.id,
      );
      for (const toilet of floor.polygons.filter((p) => p.kind === "toilet"))
        assert.deepEqual(
          polygonClipping.intersection(
            [points],
            [toilet.points, ...toilet.holes],
          ),
          [],
          layout.id,
        );
      assert.ok(near(world(layout, layout.flights[0].from), layout.center));
      assert.equal(layout.routingStatus, "display-only-no-source-flight-path");
      if (level === 1) {
        assert.equal(
          layout.physicalFloor,
          undefined,
          "source plan1 does not establish the lower corridor physical level",
        );
        assert.equal(layout.displayCutout, false);
        assert.equal(
          getStairDisplayCutouts(floor).some(
            (cutout) => cutout.layoutId === layout.id,
          ),
          false,
        );
        assert.deepEqual(
          layout.flights.map((f) => [f.baseFraction, f.topFraction]),
          [
            [0, 0.5],
            [0.5, 1],
          ],
        );
        assert.ok(
          layout.frame.axisV[1] < 0,
          "lower model extends into its retained source corridor",
        );
      }
    }
    assert.equal(JSON.stringify(floor), before);
  }
  const right = libraryStairLayoutsForFloor(readFloor(2)).find((layout) =>
    layout.id.endsWith("entrance-right"),
  );
  assert.deepEqual(right.frame.size, [3.6, 4.9]);
  assert.ok(right.frame.axisU[0] < 0 && right.frame.axisV[1] > 0);
  assert.match(right.note, /Длина модели уменьшена/);
});

test("lower views render ascending solid flights, walls, receiving platforms and a floor rather than a point symbol", () => {
  const floor = readFloor(1);
  for (const layout of libraryStairLayoutsForFloor(floor)) {
    const marker = getMapStairMarkers(floor).find(
      (item) => item.layoutId === layout.id,
    );
    const group = createStaircase(marker, floor);
    try {
      const enclosure = group.children.find((mesh) =>
        mesh.name.endsWith(" · enclosure"),
      );
      const platforms = group.children.find((mesh) =>
        mesh.name.endsWith(" · landing"),
      );
      assert.ok(enclosure && platforms);
      enclosure.geometry.computeBoundingBox();
      platforms.geometry.computeBoundingBox();
      assert.ok(enclosure.geometry.boundingBox.max.y > 3.5);
      assert.ok(platforms.geometry.boundingBox.min.y < 0.05);
      assert.ok(platforms.geometry.boundingBox.max.y > 3.5);
      assert.deepEqual(
        layout.enclosureWalls[0].to,
        [0.46, 0.04],
        "entrance into the lower landing remains open",
      );
      assert.equal(
        layout.landings.find(
          (item) => item.role === "shaft-bottom-display-only",
        ).elevationFraction,
        -0.05,
      );
    } finally {
      group.traverse((object) => {
        object.geometry?.dispose();
        for (const material of [].concat(object.material || []))
          material.dispose();
      });
    }
  }
});

test("companion models refuse changed source portals and corridor geometry independently", () => {
  for (const reference of entranceStairPortals.filter(
    (item) => item.layoutId !== "v-78-floor2-user-stair-library",
  )) {
    const level = reference.floorId.endsWith("floor1") ? 1 : 2;
    for (const kind of ["marker", "transition", "area"]) {
      const floor = readFloor(level);
      const layout = libraryStairLayoutsForFloor(floor).find(
        (item) => item.id === reference.layoutId,
      );
      if (kind === "area")
        floor.polygons.find(
          (item) => item.id === layout.fitAreaId,
        ).points[0][0] += 0.1;
      else
        floor[kind === "marker" ? "markers" : "transitions"].find(
          (item) => item.id === reference.sourceEdgeId,
        ).position[0] += 0.1;
      const before = JSON.stringify(floor);
      assert.equal(
        libraryStairLayoutsForFloor(floor).some(
          (item) => item.id === reference.layoutId,
        ),
        false,
        `${reference.layoutId}: ${kind}`,
      );
      assert.equal(JSON.stringify(floor), before);
    }
  }
});
