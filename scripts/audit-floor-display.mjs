import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import polygonClipping from "polygon-clipping";
import * as THREE from "three";
import { AtlasScene } from "../src/map/scene.js";
import { getBuildingFloorComponentScopes } from "../src/map/building-view.js";

const read = (file) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url)));
const campus = read("public/data/manifest.json").campuses.find(
  ({ id }) => id === "v-78",
);
const floors = campus.floors.map((entry) => read(`public${entry.url}`));
const sourceBefore = JSON.stringify(floors);
const view = Object.assign(Object.create(AtlasScene.prototype), {
  floorHeight: 3.6,
  wallHeight: 2.7,
  plan: false,
  model: new THREE.Group(),
  context: new THREE.Group(),
  selection: new THREE.Group(),
  hover: new THREE.Group(),
  labelLayer: { replaceChildren() {} },
  addLabel() {
    return {};
  },
  setRouteGuidance() {},
  invalidate() {},
  refreshUserLocation() {},
});
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((total, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return total + p[0] * q[1] - q[0] * p[1];
    }, 0),
  ) / 2;
const area = (polygons) =>
  polygons.reduce(
    (sum, rings) =>
      sum +
      ringArea(rings[0]) -
      rings.slice(1).reduce((part, ring) => part + ringArea(ring), 0),
    0,
  );
const triangulationError = (polygon) => {
  const shape = new THREE.Shape(
    polygon.points.map(([x, z]) => new THREE.Vector2(x, z)),
  );
  for (const hole of polygon.holes || [])
    shape.holes.push(
      new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, z))),
    );
  const geometry = new THREE.ShapeGeometry(shape);
  const positions = geometry.attributes.position,
    index = geometry.index;
  let trianglesArea = 0;
  for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
    const ids = [0, 1, 2].map((offset) =>
      index ? index.getX(i + offset) : i + offset,
    );
    const points = ids.map((id) => [positions.getX(id), positions.getY(id)]);
    trianglesArea += ringArea(points);
  }
  geometry.dispose();
  const expected = area([[polygon.points, ...(polygon.holes || [])]]);
  const error = Math.abs(trianglesArea - expected);
  return error > Math.max(0.02, expected * 0.00001) ? error : 0;
};
const cutawayRing = (planes) => {
  let points = [
    [-10000, -10000],
    [10000, -10000],
    [10000, 10000],
    [-10000, 10000],
  ];
  for (const plane of planes || []) {
    const next = [];
    const distance = ([x, z]) =>
      plane.normal.x * x + plane.normal.z * z + plane.constant;
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length],
        da = distance(a),
        db = distance(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        next.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    points = next;
  }
  return points;
};
const records = [];
for (const floor of floors)
  for (const [building, physicalFloor] of Object.entries(
    floor.buildingLevels,
  )) {
    const started = performance.now();
    view.setFloor(floor, building, { fit: false });
    const buildMs = performance.now() - started;
    const prepared = view.floorDisplay;
    const own = floor.polygons.filter(
      (polygon) => polygon.building === building,
    );
    const visible = new Set(prepared.renderFloor.polygons.map(({ id }) => id));
    const omitted = own
      .filter(({ id }) => !visible.has(id))
      .map(({ id }) => id);
    const pointClipped = ([x, z]) =>
      view.clipPlanes?.some(
        (plane) => plane.distanceToPoint(new THREE.Vector3(x, 0, z)) < -0.001,
      );
    const components = getBuildingFloorComponentScopes(floor, building).filter(
      ({ footprint }) => prepared.renderFloor.footprints.includes(footprint),
    );
    const exclusive = components.filter((component) => component.exclusive);
    const cutaway = cutawayRing(view.clipPlanes);
    const partiallyClippedUnassigned = [];
    for (const polygon of prepared.renderFloor.polygons.filter(
      (p) => !p.building,
    )) {
      const rings = [polygon.points, ...(polygon.holes || [])];
      const visible = area(polygonClipping.intersection(rings, [cutaway]));
      const lost = area([rings]) - visible;
      if (visible > 0.0001 && lost > 0.0001)
        partiallyClippedUnassigned.push({
          id: polygon.id,
          label: polygon.label,
          kind: polygon.kind,
          removedArea: Number(lost.toFixed(4)),
          exclusiveComponent: exclusive.some(
            ({ footprint }) =>
              area(
                polygonClipping.difference(rings, [
                  footprint.points,
                  ...(footprint.holes || []),
                ]),
              ) < 0.0001,
          ),
        });
    }
    let preservedHoles = 0,
      coveredHoleArea = 0,
      invalidVertices = 0,
      vertices = 0,
      triangles = 0;
    const slabTriangulationError = prepared.slabs.reduce(
      (sum, slab) => sum + triangulationError(slab),
      0,
    );
    for (let i = 0; i < prepared.slabs.length; i++)
      for (const hole of prepared.renderFloor.footprints[i].holes || []) {
        preservedHoles++;
        const slab = prepared.slabs[i];
        coveredHoleArea += area(
          polygonClipping.intersection(
            [slab.points, ...(slab.holes || [])],
            [hole],
          ),
        );
      }
    view.model.traverse((object) => {
      const g = object.geometry,
        p = g?.attributes?.position;
      if (!p) return;
      vertices += p.count;
      invalidVertices += Array.from(p.array).filter(
        (x) => !Number.isFinite(x),
      ).length;
      if (object.isMesh)
        triangles +=
          ((g.index?.count ?? p.count) / 3) *
          (object.isInstancedMesh ? object.count : 1);
    });
    const repeatStarted = performance.now();
    view.setFloor(floor, building, { fit: false });
    const repeatBuildMs = performance.now() - repeatStarted;
    records.push({
      building,
      physicalFloor,
      floorId: floor.id,
      sourceNamedPolygons: own.length,
      visibleNamedPolygons: own.length - omitted.length,
      omittedNamedIds: omitted,
      clippedNamedIds: own
        .filter((p) => p.points.some(pointClipped))
        .map(({ id }) => id),
      displayedPolygons: prepared.renderFloor.polygons.length,
      displayedWalls: prepared.stairPartitions.walls.length,
      sourceFootprints: prepared.renderFloor.footprints.length,
      preservedSourceHoles: preservedHoles,
      exclusiveComponents: exclusive.length,
      sharedComponentOwners: components
        .filter((component) => !component.exclusive && component.owners.length)
        .map(({ owners }) => owners),
      partiallyClippedUnassigned,
      coveredSourceHoleArea: Number(coveredHoleArea.toFixed(8)),
      invalidVertices,
      slabTriangulationError: Number(slabTriangulationError.toFixed(6)),
      vertices,
      triangles,
      buildMs: Number(buildMs.toFixed(2)),
      repeatBuildMs: Number(repeatBuildMs.toFixed(2)),
      bounds: view.boundsForBuilding(building, floor),
    });
  }
const timings = [];
for (const physicalFloor of [2, 1, 2, 1]) {
  const floor = floors.find((f) => f.buildingLevels["Е"] === physicalFloor);
  const started = performance.now();
  view.setFloor(floor, "Е", { fit: false });
  timings.push({
    physicalFloor,
    buildMs: Number((performance.now() - started).toFixed(2)),
  });
}
view.clear();
const timingSummary = (key) => {
  const samples = records.map((record) => record[key]).sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    maxMs: samples.at(-1),
  };
};
const report = {
  evidence:
    "CPU Three.js geometry construction; no WebGL render/FPS or device-motion claim",
  sourceUnchanged: JSON.stringify(floors) === sourceBefore,
  buildingCount: new Set(records.map(({ building }) => building)).size,
  viewCount: records.length,
  namedOmissions: records.reduce((sum, r) => sum + r.omittedNamedIds.length, 0),
  clippedNamedPolygons: records.reduce(
    (sum, r) => sum + r.clippedNamedIds.length,
    0,
  ),
  coveredSourceHoleArea: records.reduce(
    (sum, r) => sum + r.coveredSourceHoleArea,
    0,
  ),
  invalidVertices: records.reduce((sum, r) => sum + r.invalidVertices, 0),
  slabTriangulationError: records.reduce(
    (sum, r) => sum + r.slabTriangulationError,
    0,
  ),
  partiallyClippedUnassigned: records.reduce(
    (sum, r) => sum + r.partiallyClippedUnassigned.length,
    0,
  ),
  exclusiveComponentClippedUnassigned: records.reduce(
    (sum, r) =>
      sum +
      r.partiallyClippedUnassigned.filter((p) => p.exclusiveComponent).length,
    0,
  ),
  preparedCacheEntries: view.floorDisplayCache.length,
  firstVisitCpu: timingSummary("buildMs"),
  repeatVisitCpu: timingSummary("repeatBuildMs"),
  eSwitchTimings: timings,
  views: records,
};
const destination =
  process.argv[2] || ".native-build/floor-display-audit/all-buildings.json";
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, views: undefined }, null, 2));
console.log(destination);
if (
  !report.sourceUnchanged ||
  report.namedOmissions ||
  report.clippedNamedPolygons ||
  report.coveredSourceHoleArea > 0.0001 ||
  report.invalidVertices ||
  report.slabTriangulationError ||
  report.partiallyClippedUnassigned
)
  process.exitCode = 1;
