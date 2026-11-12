import polygonClipping from "polygon-clipping";
import {
  AI_OUTDOOR_PASSAGE,
  confirmedAIOutdoorPassage,
} from "../data/outdoor-passage.js";

const floorViews = new WeakMap();
const exteriorViews = new WeakMap();
const roadViews = new WeakMap();
const rings = (p) => [p.points, ...(p.holes || [])];
const pointEqual = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.00001;
const sameSegment = (a, b, segment) =>
  (pointEqual(segment.a, a) && pointEqual(segment.b, b)) ||
  (pointEqual(segment.a, b) && pointEqual(segment.b, a));
const area = (ring) =>
  Math.abs(
    ring.reduce((sum, p, i) => {
      const next = ring[(i + 1) % ring.length];
      return sum + p[0] * next[1] - next[0] * p[1];
    }, 0),
  ) / 2;
const multiArea = (multi) =>
  multi.reduce(
    (sum, [outer, ...holes]) =>
      sum + area(outer) - holes.reduce((s, h) => s + area(h), 0),
    0,
  );
const polygons = (multi, source) =>
  multi.map(([outer, ...holes], index) => ({
    ...source,
    ...(source?.id ? { id: `${source.id}:outdoor-cut:${index}` } : {}),
    points: outer.slice(0, -1),
    holes: holes.map((hole) => hole.slice(0, -1)),
  }));
function subtract(polygon, cut) {
  if (multiArea(polygonClipping.intersection(rings(polygon), cut)) < 1e-7)
    return [polygon];
  return polygons(polygonClipping.difference(rings(polygon), cut), polygon);
}

/** Keep the source ground/doors, remove only the six unshared street walls. */
export function outdoorPassageFloorView(floor) {
  if (floorViews.has(floor)) return floorViews.get(floor);
  const source = confirmedAIOutdoorPassage(floor);
  if (!source || floor.userConfirmedOutdoorPassage?.id === source.id)
    return floor;
  const openEdges = AI_OUTDOOR_PASSAGE.openBoundaryIndices.map((i) => [
    source.points[i],
    source.points[(i + 1) % source.points.length],
  ]);
  if (
    !openEdges.every(([a, b]) => floor.walls?.some((w) => sameSegment(a, b, w)))
  )
    return floor;
  const passage = {
    ...source,
    kind: "outdoor",
    sourceKind: source.kind,
    exteriorEligible: false,
    label: "По улице · А ↔ И",
    environment: "outdoor",
    note: "Открытый переход между А и И по уточнению пользователя. Траектория, границы и дверные проёмы сохранены из исходного плана. Пост охраны находится в начале со стороны А; его размеры пока не нанесены.",
    placeEvidence: {
      type: "user-confirmed-outdoor-passage",
      confirmedAt: "2026-11-12",
    },
  };
  const view = {
    ...floor,
    polygons: floor.polygons.map((p) => (p === source ? passage : p)),
    walls: floor.walls.filter(
      (w) => !openEdges.some(([a, b]) => sameSegment(a, b, w)),
    ),
    // The ground slab still carries the walkable street. Only the indoor
    // silhouette separates here; it must no longer merge A and И as a room.
    exteriorFootprints: (
      floor.exteriorFootprints ||
      floor.footprints ||
      []
    ).flatMap((p) => subtract(p, rings(source))),
    outdoorPolygons: [
      ...(floor.outdoorPolygons || []).filter((p) => p.id !== source.id),
      passage,
    ],
    userConfirmedOutdoorPassage: {
      id: source.id,
      confirmedAt: "2026-11-12",
      removedWallCount: 6,
    },
  };
  floorViews.set(floor, view);
  return view;
}

/** Keep the adjoining street visible when either adjacent wing is selected. */
export function withOutdoorPassageDisplay(
  renderFloor,
  correctedFloor,
  building,
) {
  if (
    !["А", "И"].includes(building) ||
    !correctedFloor.userConfirmedOutdoorPassage
  )
    return renderFloor;
  const passage = confirmedAIOutdoorPassage(correctedFloor);
  if (!passage || renderFloor.polygons.some((p) => p.id === passage.id))
    return renderFloor;
  return {
    ...renderFloor,
    polygons: [...renderFloor.polygons, passage],
    footprints: [...renderFloor.footprints, passage],
  };
}

export function withOutdoorPassageRoads(roads, floor) {
  const passage = confirmedAIOutdoorPassage(floor);
  if (!passage) return roads;
  const cached = roadViews.get(roads);
  if (cached?.floor === floor) return cached.polygons;
  const combined = polygons(
    polygonClipping.union(...roads.map(rings), rings(passage)),
    {},
  );
  roadViews.set(roads, { floor, polygons: combined });
  return combined;
}

/** Remove the low shell only over the confirmed street, not the adjacent
 * A/И wings or their two source vestibules. Taller source volumes stay intact.
 */
export function outdoorPassageExteriorView(data, floor) {
  if (!data || data.units !== "meters" || !confirmedAIOutdoorPassage(floor))
    return data;
  const cached = exteriorViews.get(data);
  if (cached?.floor === floor) return cached.view;
  const shell = data.shells?.find(
    (p) =>
      p.id ===
        "v-78:shell:1:15:override-cut:0:override-cut:0:override-cut:0:override-cut:0" &&
      p.sourceFloorId === AI_OUTDOOR_PASSAGE.floorId &&
      p.base === 0 &&
      p.height === 7.2,
  );
  if (!shell) return data;
  const cut = polygonClipping.intersection(rings(shell), [
    AI_OUTDOOR_PASSAGE.points,
  ]);
  if (Math.abs(multiArea(cut) - 152.3234573943464) > 0.0001) return data;
  const subtractAll = (source) => source?.flatMap((p) => subtract(p, cut));
  const subtractLowShells = (source) =>
    source?.flatMap((p) => (p.height > 7.2 ? [p] : subtract(p, cut)));
  const bands = (source) =>
    source?.map((band) => ({ ...band, rings: subtractAll(band.rings) }));
  const view = {
    ...data,
    shells: subtractLowShells(data.shells),
    ...(data.displayShells
      ? { displayShells: subtractLowShells(data.displayShells) }
      : {}),
    facadeBands: bands(data.facadeBands),
    ...(data.displayFacadeBands
      ? { displayFacadeBands: bands(data.displayFacadeBands) }
      : {}),
    footprints: subtractAll(data.footprints),
    userConfirmedOutdoorPassage: {
      id: AI_OUTDOOR_PASSAGE.id,
      removedShellArea: multiArea(cut),
    },
  };
  exteriorViews.set(data, { floor, view });
  return view;
}
