import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { pickLocationSurface } from "../src/map/location-view.js";
import { AtlasScene } from "../src/map/scene.js";
import { getHallAdjacencyView } from "../src/map/hall-adjacency.js";
import { getStairDisplayCutouts } from "../src/map/stairs.js";

const rectangle = (x, z, X, Z) => [
  [x, z],
  [X, z],
  [X, Z],
  [x, Z],
];
function corridorFloor() {
  return {
    id: "f2",
    campusId: "v-78",
    polygons: [
      {
        id: "classroom",
        building: "Г",
        kind: "room",
        points: rectangle(-10, -10, -3, 10),
      },
    ],
    footprints: [
      { points: rectangle(-10, -10, 10, 10), holes: [rectangle(6, 6, 8, 8)] },
    ],
    walls: [{ a: [-3, -10], b: [-3, 10], width: 0.2 }],
  };
}

test("a corridor footprint is selectable without inventing a classroom or building", () => {
  const floor = corridorFloor();
  const snapshot = JSON.stringify(floor);
  assert.deepEqual(pickLocationSurface(floor, [0, 0]), {
    kind: "circulation",
    building: null,
    room: null,
    roomId: null,
    areaId: null,
  });
  assert.equal(
    pickLocationSurface(floor, [0, 0], { building: "Г" }).building,
    "Г",
  );
  assert.equal(
    JSON.stringify(floor),
    snapshot,
    "picking never edits source geometry",
  );
  assert.equal(pickLocationSurface(floor, [-6, 0]).roomId, "classroom");
});

test("background, slab holes, stair openings and the rendered wall cannot become survey points", () => {
  const floor = corridorFloor();
  const cutouts = [{ points: rectangle(1, 1, 3, 3) }];
  assert.equal(pickLocationSurface(floor, [12, 0]), null);
  assert.equal(pickLocationSurface(floor, [7, 7]), null);
  assert.equal(
    pickLocationSurface(floor, [6, 7]),
    null,
    "a void edge is not a safe anchor",
  );
  assert.equal(pickLocationSurface(floor, [2, 2], { cutouts }), null);
  assert.equal(pickLocationSurface(floor, [-3, 0]), null);
  assert.equal(pickLocationSurface(floor, [-2.85, 0]).kind, "circulation");
  assert.equal(pickLocationSurface(floor, []), null);
  assert.equal(pickLocationSurface(floor, [NaN, 0]), null);
});

test("an explicit polygon hole is not revived by the broad footprint fallback", () => {
  const floor = corridorFloor();
  floor.polygons.push({
    id: "hall",
    kind: "hall",
    points: rectangle(-2, -2, 4, 4),
    holes: [rectangle(0, 0, 2, 2)],
  });
  assert.equal(pickLocationSurface(floor, [1, 1]), null);
  assert.equal(pickLocationSurface(floor, [3, 3]).areaId, "hall");
});

test("real V78 unnumbered areas preserve area identity and require an explicit building context", () => {
  const floor = getHallAdjacencyView(
    JSON.parse(
      readFileSync(
        new URL(
          "../public/data/campuses/v-78/v-78-floor2.json",
          import.meta.url,
        ),
      ),
    ),
  );
  const area = floor.polygons.find(
    (polygon) => polygon.id === "v-78-floor2-area-3",
  );
  const cutouts = getStairDisplayCutouts(floor);
  const unknown = pickLocationSurface(floor, area.center, { cutouts });
  assert.equal(unknown.building, null);
  assert.equal(unknown.roomId, null);
  assert.equal(unknown.areaId, area.id);
  assert.equal(unknown.room, area);
  const selected = pickLocationSurface(floor, area.center, {
    building: "А",
    cutouts,
  });
  assert.equal(
    selected.building,
    "А",
    "an explicit UI building is usable; a nearby room is not consulted",
  );
  const opening = cutouts.find((cutout) => cutout.points.length === 4);
  assert.ok(opening, "current source display contains an actual stair opening");
  const center = opening.points.reduce(
    (sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4],
    [0, 0],
  );
  assert.equal(pickLocationSurface(floor, center, { cutouts }), null);
});

test("scene ray picking accepts corridor slabs and still enforces the selected wing clip", () => {
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 200);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const floor = corridorFloor();
  const view = Object.assign(Object.create(AtlasScene.prototype), {
    mode: "floor",
    locationPicking: true,
    floor,
    locationFloor: floor,
    locationCutouts: [],
    campus: { id: "v-78" },
    building: "Г",
    camera,
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 400,
          height: 400,
        }),
      },
    },
  });
  const result = view.pickUserLocation({ clientX: 200, clientY: 200 });
  assert.equal(result.kind, "circulation");
  assert.equal(result.building, "Г");
  assert.equal(result.floorId, "f2");
  assert.equal(result.roomId, null);
  view.clipPlanes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -1)];
  assert.equal(view.pickUserLocation({ clientX: 200, clientY: 200 }), null);
});
