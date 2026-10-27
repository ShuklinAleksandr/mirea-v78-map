import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  JSON.parse(
    readFileSync(new URL(`../public/data/${path}`, import.meta.url), "utf8"),
  );
const shells = read("exterior-shells.json");
const overrides = read("exterior-overrides.json");
const context = read("exterior-context.json");
const hall = read("exterior-hall.json");
const special = read("exterior-special.json");

const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
const area = (polygon) =>
  ringArea(polygon.points) -
  polygon.holes.reduce((sum, h) => sum + ringArea(h), 0);

test("all four exterior models reach the common visual ground without adding interior rooms", () => {
  assert.deepEqual(Object.keys(shells.campuses), [
    "v-78",
    "v-86",
    "s-20",
    "mp-1",
  ]);
  for (const campus of Object.values(shells.campuses)) {
    assert.ok(campus.shells.length);
    for (const shell of campus.shells) {
      assert.equal(shell.base, 0);
      assert.ok(shell.height > 0);
      assert.equal(shell.lowerInteriorStatus, "not-inferred");
      assert.ok(shell.points.length >= 3);
    }
    assert.equal(campus.facadeBands[0].base, 0);
    campus.facadeBands.forEach((band, i) => {
      assert.ok(band.top > band.base);
      if (i) assert.equal(band.base, campus.facadeBands[i - 1].top);
    });
  }
});

test("photo-informed heights are separate from real source room geometry", () => {
  assert.equal(overrides.overrides.length, 4);
  for (const feature of overrides.overrides) {
    const floor = read(`campuses/${feature.campusId}/${feature.floorId}.json`);
    const room = floor.polygons.find((p) => p.id === feature.roomId);
    assert.ok(room);
    assert.equal(room.height, undefined);
    assert.equal(feature.heightStatus, "photo-informed-approximation");
    const applied = shells.campuses[feature.campusId].shells.filter(
      (s) => s.overrideRoomId === feature.roomId,
    );
    assert.ok(applied.length);
    assert.ok(applied.every((s) => s.height === feature.height));
  }
  assert.equal(
    overrides.overrides.find((o) => o.roomId.endsWith("6kc")).roof.type,
    "shallow-cone",
  );
});

test("optional OSM background preserves attribution and does not claim neighbouring towers as campus buildings", () => {
  assert.equal(context.defaultVisible, false);
  assert.equal(context.source.license, "ODbL 1.0");
  assert.ok(context.source.attribution.includes("OpenStreetMap"));
  assert.equal(context.registration.status, "approximate");
  assert.ok(context.buildings.length > 0);
  for (const building of context.buildings) {
    assert.ok(!building.address || building.address.startsWith("78"));
    assert.equal(building.interiorStatus, "not-available");
    assert.equal(building.geometryStatus, "osm-affine-approximate");
    assert.ok(building.sourceUrl.startsWith("https://www.openstreetmap.org/"));
  }
  assert.ok(context.roads.some((r) => r.name === "улица Коштоянца"));
});

test("the main hall roof covers the cloakroom and cafeteria island without creating a roof hole", () => {
  const floor = read("campuses/v-78/v-78-floor2.json");
  assert.equal(hall.sourcePolygonIds.length, 13);
  for (const id of hall.sourcePolygonIds)
    assert.ok(
      floor.polygons.some((p) => p.id === id),
      id,
    );
  assert.ok(hall.sourcePolygonIds.includes("v-78--floor-2--9yc"));
  assert.ok(hall.sourcePolygonIds.includes("v-78--floor-2--9y7"));
  assert.equal(hall.lowPolygon.holes.length, 0);
  assert.equal(hall.roofPolygons.length, 1);
  assert.equal(hall.roofPolygons[0].holes.length, 0);
  assert.equal(hall.volumePolygons.length, 1);
  assert.ok(
    hall.protectedUpperOverlapArea > 0,
    "upper A facade must be retained",
  );
  const entrance = floor.polygons.find((p) => p.id === "v-78--floor-2--9yb");
  for (const end of [
    hall.entranceFrontSegment.a,
    hall.entranceFrontSegment.b,
  ]) {
    assert.ok(entrance.points.some((p) => p[0] === end[0] && p[1] === end[1]));
  }
  assert.equal(
    hall.canopy.geometryStatus,
    "photo-approximation-offset-from-native-frontage",
  );
});

test("exterior roof regularization preserves the source footprint and special low volumes", () => {
  const v78 = shells.campuses["v-78"];
  assert.ok(v78.displayShells.length < v78.shells.length);
  const originalArea = v78.shells.reduce((sum, p) => sum + area(p), 0);
  const displayArea = v78.displayShells.reduce((sum, p) => sum + area(p), 0);
  assert.ok(Math.abs(originalArea - displayArea) < 0.01);
  assert.ok(v78.displayPolicy.adjustedArea / originalArea < 0.02);
  for (const original of v78.shells.filter((p) => p.overrideRoomId)) {
    const display = v78.displayShells.find((p) => p.id === original.id);
    assert.deepEqual(display, original);
  }
  assert.ok(v78.displayPolicy.heightAdjustments.every((a) => a.to > a.from));
});

test("the circular conference exterior replaces its full room group without inventing a sports bridge location", () => {
  const conference = special.features.find((f) => f.id === "conference-hall");
  const floor = read("campuses/v-78/v-78-floor1.json");
  assert.equal(conference.sourcePolygonIds.length, 20);
  assert.ok(
    conference.sourcePolygonIds.every((id) =>
      floor.polygons.some((p) => p.id === id),
    ),
  );
  assert.equal(conference.polygons.length, 1);
  assert.equal(conference.polygons[0].holes.length, 0);
  assert.ok(conference.radius > 15 && conference.radius < 20);
  for (const p of conference.polygons[0].points) {
    assert.ok(
      Math.abs(
        Math.hypot(p[0] - conference.center[0], p[1] - conference.center[1]) -
          conference.radius,
      ) < 0.001,
    );
  }
  const bridge = special.unmodeledFeatures.find(
    (f) => f.id === "sports-elevated-bridge",
  );
  assert.equal(bridge.existenceStatus, "photo-confirmed");
  assert.equal(bridge.render, false);
  assert.equal(bridge.points, undefined);
});
