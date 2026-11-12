import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import polygonClipping from "polygon-clipping";
import {
  AI_OUTDOOR_PASSAGE,
  confirmedAIOutdoorPassage,
} from "../src/data/outdoor-passage.js";
import {
  outdoorPassageFloorView,
  outdoorPassageExteriorView,
  withOutdoorPassageDisplay,
  withOutdoorPassageRoads,
} from "../src/map/outdoor-passage.js";
import { getBuildingFloorView } from "../src/map/building-view.js";
import { findRoute } from "../src/data/routing.js";
import { pickLocationSurface } from "../src/map/location-view.js";
import { resolveFloorContext } from "../src/data/floor-context.js";

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const floor = read("../public/data/campuses/v-78/v-78-floor1.json");
const graph = read("../public/data/routing/v-78.json");
const exterior = read("../public/data/exterior-shells.json").campuses["v-78"];
const rings = (p) => [p.points, ...(p.holes || [])];
const area = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
const multiArea = (multi) =>
  multi.reduce(
    (s, [outer, ...holes]) =>
      s + area(outer) - holes.reduce((n, hole) => n + area(hole), 0),
    0,
  );
const union = (shapes) => polygonClipping.union(...shapes.map(rings));

test("confirmed A–И street keeps all source ground, rooms and doors, removing only its six open side walls", () => {
  const before = JSON.stringify(floor);
  const view = outdoorPassageFloorView(floor);
  assert.notEqual(view, floor);
  const p = confirmedAIOutdoorPassage(view);
  assert.equal(p.kind, "outdoor");
  assert.equal(p.exteriorEligible, false);
  assert.deepEqual(p.points, AI_OUTDOOR_PASSAGE.points);
  assert.equal(view.polygons.length, floor.polygons.length);
  assert.equal(view.walls.length, floor.walls.length - 6);
  assert.equal(view.doors, floor.doors);
  assert.equal(view.markers, floor.markers);
  assert.equal(view.transitions, floor.transitions);
  assert.equal(
    view.footprints,
    floor.footprints,
    "the walkable ground does not become a hole",
  );
  for (const id of [
    "v-78--floor-1--69j",
    "v-78-floor1-area-124",
    "v-78-floor1-area-437",
  ])
    assert.equal(
      view.polygons.find((p) => p.id === id),
      floor.polygons.find((p) => p.id === id),
    );
  for (const door of floor.doors.filter((d) =>
    ["v-78-floor1-door-437", "v-78-floor1-door-438"].includes(d.id),
  ))
    assert.ok(view.doors.includes(door));
  assert.equal(JSON.stringify(floor), before);
  assert.equal(
    outdoorPassageFloorView(floor),
    view,
    "display geometry is cached",
  );
  assert.equal(outdoorPassageFloorView(view), view);
  for (const building of ["А", "И"]) {
    const scoped = withOutdoorPassageDisplay(
      getBuildingFloorView(view, building),
      view,
      building,
    );
    assert.ok(scoped.polygons.some((p) => p.id === AI_OUTDOOR_PASSAGE.id));
    const surface = pickLocationSurface(scoped, [-75, 43.5], { building });
    assert.equal(surface.kind, "outdoor");
    assert.equal(surface.roomId, null);
    assert.equal(
      surface.building,
      null,
      "the selected wing does not turn the street into that building",
    );
    assert.equal(surface.areaId, AI_OUTDOOR_PASSAGE.id);
    assert.equal(resolveFloorContext(scoped, [-75, 43.5]), null);
  }
});

test("changed or foreign source plans do not receive a guessed street correction", () => {
  for (const change of [
    (f) => (f.campusId = "v-86"),
    (f) => (f.id = "v-78-floor2"),
    (f) => (f.source.svgSha256 = "different"),
    (f) =>
      (f.polygons.find((p) => p.id === AI_OUTDOOR_PASSAGE.id).points[0][0] +=
        0.1),
    (f) =>
      (f.polygons.find((p) => p.id === AI_OUTDOOR_PASSAGE.id).roomId =
        "new-room"),
    (f) =>
      (f.walls = f.walls.filter(
        (w) => !(w.a[0] === -58.419 && w.b[0] === -57.717),
      )),
  ]) {
    const changed = structuredClone(floor);
    change(changed);
    assert.equal(outdoorPassageFloorView(changed), changed);
  }
});

test("the exterior loses only the low volume above the street; neighbouring high buildings and vestibules remain", () => {
  const before = JSON.stringify(exterior);
  const view = outdoorPassageExteriorView(exterior, floor);
  assert.notEqual(view, exterior);
  assert.ok(
    Math.abs(
      view.userConfirmedOutdoorPassage.removedShellArea - 152.3234573943464,
    ) < 0.0001,
  );
  const street = [AI_OUTDOOR_PASSAGE.points];
  for (const name of ["shells", "displayShells"]) {
    const old = union(exterior[name]),
      current = union(view[name]);
    const removed = polygonClipping.difference(old, current);
    assert.ok(
      multiArea(polygonClipping.difference(removed, street)) < 0.0001,
      "nothing outside the street removed",
    );
    assert.ok(
      multiArea(polygonClipping.difference(current, old)) < 0.0001,
      "no building volume added",
    );
    for (const p of exterior[name].filter((p) => p.height > 7.2))
      assert.ok(
        view[name].includes(p),
        "taller source geometry stays unchanged",
      );
    for (const id of ["v-78-floor1-area-124", "v-78-floor1-area-437"]) {
      const vestibule = rings(floor.polygons.find((p) => p.id === id));
      assert.ok(
        multiArea(polygonClipping.intersection(removed, vestibule)) < 0.0001,
      );
    }
  }
  const roads = [confirmedAIOutdoorPassage(floor)];
  const merged = withOutdoorPassageRoads(roads, floor);
  assert.ok(
    Math.abs(
      multiArea(union(merged)) - multiArea(street.length ? [street] : []),
    ) < 0.0001,
    "overlapping road surfaces are merged instead of flickering",
  );
  assert.equal(withOutdoorPassageRoads(roads, floor), merged);
  assert.equal(JSON.stringify(exterior), before);
  assert.equal(outdoorPassageExteriorView(exterior, floor), view);
  const stale = structuredClone(floor);
  stale.source.svgSha256 = "new";
  assert.equal(outdoorPassageExteriorView(exterior, stale), exterior);
});

test("A177 to И200 and back identify the street on existing edges; isolated A177.1 and И100 are not connected by guess", () => {
  const before = JSON.stringify(graph);
  const a = "v-78--floor-1--6ae",
    i = "v-78--floor-2--a6x";
  const sourceEdges = new Map(graph.edges.map((e) => [e.id, e]));
  for (const [from, to, destination] of [
    [a, i, "И"],
    [i, a, "А"],
  ]) {
    const route = findRoute(graph, from, to);
    assert.equal(route.ok, true);
    assert.ok(route.graphNodes.some((n) => n.areaId === AI_OUTDOOR_PASSAGE.id));
    for (const edge of route.edges)
      assert.deepEqual(edge, sourceEdges.get(edge.id));
    const entry = route.steps.filter((s) => s.environment === "outdoor");
    const exit = route.steps.filter((s) => s.environment === "indoor");
    assert.equal(entry.length, 1);
    assert.equal(exit.length, 1);
    assert.ok(entry[0].text.includes(`к корпусу ${destination}`));
    assert.equal(exit[0].text, `Войдите с улицы в корпус ${destination}`);
    for (const step of [...entry, ...exit])
      assert.ok(
        route.nodes.some(
          (n) =>
            n.floorId === step.floorId &&
            n.position.every(
              (v, j) => Math.abs(v - step.position[j]) < 0.00001,
            ),
        ),
      );
  }
  const unsupported = findRoute(
    graph,
    "v-78--floor-1--69j",
    "v-78--floor-1--6hn",
  );
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "no-path");
  assert.equal(JSON.stringify(graph), before);
  const stale = structuredClone(graph);
  stale.source.geometrySha256["v-78-floor1"] = "different";
  const unchanged = findRoute(stale, a, i);
  assert.equal(unchanged.ok, true);
  assert.ok(!unchanged.steps.some((s) => s.environment === "outdoor"));
});
