import * as THREE from "three";
import polygonClipping from "polygon-clipping";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getFloorMarkers } from "../data/utils.js";
import { libraryStairLayoutsForFloor } from "./library-stair.js";
import { middleStairArrival } from "./stair-arrivals.js";
import defaults from "../../public/data/stair-assumptions.json" with { type: "json" };
import registry from "../../public/data/stair-layouts.json" with { type: "json" };

const finitePoint = (point) =>
  Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite);

// Registry labels include modeling shorthand. Keep it in sourceLabel rather
// than presenting a U-shaped model as if "U" were the name of a campus place.
const stairDisplayLabels = new Map([
  ["v78-А-1-U у А-146", "Лестница А-146"],
  ["v78-А-3-Малая U у А-324", "Лестница у А-324"],
  ["v-78-floor1-photo-stair-A154", "Лестница 2 ↔ 1 (по описанию)"],
  ["v-78-floor2-photo-stair-A154-arrival", "Лестница 2 ↔ 1 (по описанию)"],
  ["v-78-floor1-user-stair-basement", "Спуск к ИВЦ (по описанию)"],
  ["v-78-floor2-photo-stair-wide-hall", "Главная лестница холла"],
  ["v-78-floor3-photo-stair-wide-hall", "Главная лестница холла"],
]);
const userDescribedLowerStairs = new Set([
  "v-78-floor1-photo-stair-A154",
  "v-78-floor2-photo-stair-A154-arrival",
  "v-78-floor1-user-stair-basement",
]);
const lowerStairSchematicNote =
  "Схема подтверждена пользователем по рисунку: от центральной верхней части две зеркальные ветви идут наружу к боковым миниплощадкам на половине высоты, разворачиваются и возвращаются к центру следующего этажа. Последующее уточнение 25 октября: форма сохраняется, начало спуска находится ближе к коридору, а не к стене; нижние модули отражены по глубине. Задние стенки ниже пола добавлены по ответу пользователя «сзади»; боковые и передние стороны не закрываются. Последовательность: 2 этаж → миниплощадки → 1 этаж → миниплощадки → ИВЦ. Размеры, высота, число ступеней и точное положение в холле — допущения модели. Номер этажа ИВЦ не установлен. План нижнего уровня и маршрут по нему уточняются.";

// The user confirmed the topology of BOTH mirrored return branches on 25 Oct.
// This adapter replaces the rejected narrow central U only for display. Its
// footprint fits inside the known A1/A2 halls; its dimensions are model choices,
// never measurements or flight shapes verified by the old fire-plan registry.
function lowerStairSchematic(layout) {
  const arrivalOnFirst = layout.id === "v-78-floor1-photo-stair-A154";
  const toIvc = layout.id === "v-78-floor1-user-stair-basement";
  const top = arrivalOnFirst ? 1 : 0;
  const rectangle = (u0, v0, u1, v1) => [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  const flight = (branch, from, to, baseFraction, topFraction) => ({
    branch,
    from,
    to,
    baseFraction,
    topFraction,
    widthFraction: 0.32,
    treadCount: null,
    treadCountStatus: "model-tessellation-not-measured",
    // The source edge does not identify a particular physical side branch.
    sourceTransitionId: null,
  });
  return {
    ...layout,
    label: stairDisplayLabels.get(layout.id),
    sourceLabel: layout.label,
    sourceShape: layout.shape,
    shape: "mirrored-side-return-branches",
    layoutMode: "mirrored-side-return-branches",
    shapeStatus: "user-confirmed-topology-schematic-dimensions",
    shapeReviewStatus: "user-confirmed-schematic",
    geometryStatus: "user-confirmed-schematic",
    geometrySource: "user-description",
    geometryEvidence: "user-description-and-sketch",
    dimensionsStatus: "model-assumptions-not-measured",
    existenceStatus: "user-confirmed-existence",
    evidence: {
      type: "user-confirmed-topology",
      confirmedAt: "2026-10-25",
      sketch: "docs/evidence/2026-10-25/user-stair-sketch.png",
      description: lowerStairSchematicNote,
    },
    containerSourcePhotoIds: layout.sourcePhotoIds,
    shapeSourcePhotoIds: [],
    shapeSourcePhotos: [],
    frame: {
      origin: [39.5, -20],
      axisU: [1, 0],
      axisV: [0, 1],
      size: [20, 5],
    },
    center: [49.5, arrivalOnFirst ? -18.75 : -16.25],
    geometryCenter: [49.5, -17.5],
    footprint: rectangle(0.02, 0.09, 0.98, 0.91),
    displayCutout: !arrivalOnFirst,
    displayCutoutFootprints: [
      rectangle(0.02, 0.09, 0.4, 0.91),
      rectangle(0.6, 0.09, 0.98, 0.91),
    ],
    levelRole: arrivalOnFirst ? "lower-departure" : "upper-arrival",
    levelRoleSource: "user-confirmed-topology-schematic",
    // A1's 1..0 view and A2's 0..-1 view show the same physical module.
    // The IVC descent has no paired lower source floor and must remain visible.
    pairedLayoutId: toIvc ? undefined : layout.pairedLayoutId,
    placementStatus: "schematic-within-known-hall-approximate",
    verticalStatus: "approximate",
    ascentDirectionStatus: "user-confirmed-outward-then-inward-descent",
    orientationStatus: "user-confirmed-corridor-side-departure",
    enclosureStatus: "user-confirmed-rear-only-approximate-dimensions",
    enclosureWalls: [
      {
        from: [0.02, 0.09],
        to: [0.4, 0.09],
        bottomFraction: top - 1,
        topFraction: top,
      },
      {
        from: [0.6, 0.09],
        to: [0.98, 0.09],
        bottomFraction: top - 1,
        topFraction: top,
      },
    ],
    flights: [
      flight("left", [0.4, 0.75], [0.12, 0.75], top, top - 0.5),
      flight("left", [0.12, 0.25], [0.4, 0.25], top - 0.5, top - 1),
      flight("right", [0.6, 0.75], [0.88, 0.75], top, top - 0.5),
      flight("right", [0.88, 0.25], [0.6, 0.25], top - 0.5, top - 1),
    ],
    landings: [
      {
        role: "intermediate",
        branch: "left",
        points: rectangle(0.02, 0.09, 0.12, 0.91),
        elevationFraction: top - 0.5,
        // Depth reflection swaps edges 0/2; both are railed. The outer
        // side edge stays closed and the inner side stays open to flights.
        railEdges: [0, 2, 3],
      },
      {
        role: "intermediate",
        branch: "right",
        points: rectangle(0.88, 0.09, 0.98, 0.91),
        elevationFraction: top - 0.5,
        railEdges: [0, 1, 2],
      },
      {
        role: "central-departure",
        points: rectangle(0.4, 0.59, 0.6, 0.91),
        elevationFraction: top,
        railEdges: [],
      },
      {
        role: "central-arrival",
        points: rectangle(0.4, 0.09, 0.6, 0.41),
        elevationFraction: top - 1,
        railEdges: [],
      },
    ],
    note: lowerStairSchematicNote,
    ...(toIvc
      ? {
          destinationLabel: "ИВЦ · номер этажа уточняется",
          routingStatus: "display-only-no-source-transition",
        }
      : {}),
  };
}
const a146Stair = {
  polygonId: "v-78--floor-1--68n",
  layoutId: "v78-А-1-U у А-146",
  floorId: "v-78-floor1",
  note: "На пожарном плане лестничная клетка обозначена А-146; между А-144 и А-148.",
};

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function polygonArea(points) {
  return (
    Math.abs(
      points.reduce((sum, point, i) => {
        const next = points[(i + 1) % points.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0),
    ) / 2
  );
}
function containingArea(anchor, floor) {
  return (floor.polygons || [])
    .filter(
      (polygon) =>
        ["unclassified", "stairs"].includes(polygon.kind) &&
        inRing(anchor, polygon.points) &&
        !(polygon.holes || []).some((hole) => inRing(anchor, hole)),
    )
    .sort((a, b) => polygonArea(a.points) - polygonArea(b.points))[0];
}

// The catalogue describes a photographed shape on each level. Most of these
// records have no vertical role, so their 0..1 profiles used to grow another
// storey even on the last available building plan. Keep the source immutable:
// show that same local shape as an arrival from below, not a new roof flight.
// This is a display role, not proof that the real building has no higher level.
function displayLayoutsForFloor(floor) {
  const layouts = registry.layouts.filter(
    (layout) => layout.floorId === floor.id,
  );
  const markers = getFloorMarkers(floor);
  const displayed = layouts.map((layout) => {
    if (userDescribedLowerStairs.has(layout.id))
      return lowerStairSchematic(layout);
    if (layout.levelRole || !Number.isFinite(layout.physicalFloor))
      return layout;
    const buildingLayouts = registry.layouts.filter(
      (candidate) =>
        candidate.campusId === layout.campusId &&
        candidate.building === layout.building &&
        Number.isFinite(candidate.physicalFloor),
    );
    const lastAvailableFloor = Math.max(
      ...buildingLayouts.map((candidate) => candidate.physicalFloor),
    );
    if (layout.physicalFloor !== lastAvailableFloor) return layout;
    const relatedMarkers = markers.filter(
      (marker) => matchStairLayout(marker, floor, layouts)?.id === layout.id,
    );
    const targets = relatedMarkers.flatMap((marker) => marker.targets || []);
    // Explicit upward connections take precedence, even when their destination
    // is outside our photographed set. An unknown destination cannot be assumed
    // to be below merely because this is the last available plan.
    const targetLevels = targets.map((target) =>
      target.floorId === floor.id
        ? layout.physicalFloor
        : buildingLayouts.find(
            (candidate) => candidate.floorId === target.floorId,
          )?.physicalFloor,
    );
    if (
      targetLevels.some(
        (level) => level == null || level > layout.physicalFloor,
      )
    )
      return layout;
    const topFraction = Math.max(
      ...layout.flights.map((flight) => flight.topFraction),
      ...layout.landings.map((landing) => landing.elevationFraction),
    );
    if (!Number.isFinite(topFraction) || topFraction <= 0) return layout;
    const sourceArea = floor.polygons.find(
      (polygon) => polygon.id === layout.fitAreaId,
    );
    const center = sourceArea?.center;
    const lowerView = buildingLayouts.find(
      (candidate) =>
        candidate.label === layout.label &&
        candidate.physicalFloor === layout.physicalFloor - 1,
    );
    return {
      ...layout,
      levelRole: "upper-arrival",
      levelRoleSource: "last-available-building-plan",
      displayOnlyArrival: true,
      displayCutout: true,
      // The named lower view is used only to avoid rendering a second physical
      // module in a stacked scene. It never supplies a navigation target.
      ...(lowerView ? { pairedLayoutId: lowerView.id } : {}),
      // Use the native stair cell for its opening, rather than a bounding box
      // that could remove a neighbouring room. Leave a thin visible slab rim.
      ...(finitePoint(center)
        ? {
            displayCutoutPoints: sourceArea.points.map(([x, z]) => [
              center[0] + (x - center[0]) * 0.98,
              center[1] + (z - center[1]) * 0.98,
            ]),
          }
        : {}),
      flights: layout.flights.map((flight) => ({
        ...flight,
        baseFraction: flight.baseFraction - topFraction,
        topFraction: flight.topFraction - topFraction,
      })),
      landings: layout.landings.map((landing) => ({
        ...landing,
        elevationFraction: landing.elevationFraction - topFraction,
      })),
    };
  });
  return [
    ...displayed.map((layout) => {
      const incomingDisplay = middleStairArrival(layout, floor, registry, {
        markers,
      });
      return incomingDisplay
        ? {
            ...layout,
            incomingDisplay,
            ...(layout.shape === "wide-well-U"
              ? { focusDirectionLocal: [0.05, 1.5, 1] }
              : {}),
          }
        : layout;
    }),
    ...libraryStairLayoutsForFloor(floor),
  ];
}

/** Display-only openings for stairs descending from the selected level.
 * Original floor polygons and navigation geometry remain untouched.
 */
export function getStairDisplayCutouts(floor) {
  return displayLayoutsForFloor(floor)
    .flatMap((layout) =>
      layout.incomingDisplay ? [layout, layout.incomingDisplay] : [layout],
    )
    .filter((layout) => layout.displayCutout)
    .flatMap((layout) => {
      const world = ([u, v]) => [
        layout.frame.origin[0] +
          layout.frame.axisU[0] * u * layout.frame.size[0] +
          layout.frame.axisV[0] * v * layout.frame.size[1],
        layout.frame.origin[1] +
          layout.frame.axisU[1] * u * layout.frame.size[0] +
          layout.frame.axisV[1] * v * layout.frame.size[1],
      ];
      // Only the descent crossing the selected floor needs an opening. Cutting
      // the whole cell would remove the common entrance landing and make the
      // partition appear to float over a black void.
      const middleOpenings = layout.incomingDisplayOnly
        ? layout.flights
            .filter((flight) => Math.abs(flight.topFraction) < 1e-6)
            .flatMap((flight) => {
              const a = world(flight.from),
                b = world(flight.to);
              const dx = b[0] - a[0],
                dz = b[1] - a[1],
                length = Math.hypot(dx, dz);
              const alongU =
                Math.abs(flight.to[0] - flight.from[0]) >
                Math.abs(flight.to[1] - flight.from[1]);
              const half =
                (flight.width ??
                  flight.widthFraction * layout.frame.size[alongU ? 1 : 0]) /
                  2 +
                0.03;
              const side = [(-dz / length) * half, (dx / length) * half];
              const opening = [
                [a[0] + side[0], a[1] + side[1]],
                [b[0] + side[0], b[1] + side[1]],
                [b[0] - side[0], b[1] - side[1]],
                [a[0] - side[0], a[1] - side[1]],
              ];
              // Photo frames are approximate rectangles; native stair cells may
              // have wall notches. Clip inside the known inset cell instead of
              // dropping the entire opening when one corner meets a notch.
              return layout.displayCutoutPoints
                ? polygonClipping
                    .intersection([opening], [layout.displayCutoutPoints])
                    .map((polygon) => polygon[0].slice(0, -1))
                : [opening];
            })
        : null;
      const openings =
        middleOpenings ||
        (layout.displayCutoutFootprints
          ? layout.displayCutoutFootprints.map((points) => points.map(world))
          : [layout.displayCutoutPoints || layout.footprint.map(world)]);
      return openings.map((points, index) => ({
        layoutId: layout.id,
        sourcePolygonIds: layout.sourcePolygonIds,
        openingIndex: index,
        points,
      }));
    });
}

export function withStairDisplayCutouts(polygon, cutouts) {
  const holes = cutouts.filter(
    (cutout) =>
      cutout.points.every((point) => inRing(point, polygon.points)) &&
      !(polygon.holes || []).some((hole) =>
        cutout.points.some((point) => inRing(point, hole)),
      ),
  );
  if (!holes.length) return polygon;
  return {
    ...polygon,
    holes: [...(polygon.holes || []), ...holes.map((cutout) => cutout.points)],
  };
}

/** A display path through observed flights and their landings.
 * Heights are the same approximate heights used by the stair mesh.
 */
export function getStairRoutePaths(
  route,
  floor,
  floorRise = 3.6,
  { stack = false } = {},
) {
  const layouts = displayLayoutsForFloor(floor).filter(
    (layout) => layout.shapeReviewStatus !== "user-confirmed-schematic",
  );
  const paths = [];
  for (const transition of route?.transitions || []) {
    const departing = transition.fromFloorId === floor.id;
    const arriving = transition.toFloorId === floor.id;
    if (!departing && !arriving) continue;
    let layout =
      layouts.find((item) =>
        item.sourceMarkerIds?.includes(transition.sourceEdgeId),
      ) ||
      layouts.find((item) => {
        const anchor = departing ? transition.point : transition.targetPoint;
        const polygon = floor.polygons.find((p) => p.id === item.fitAreaId);
        return polygon && inRing(anchor, polygon.points);
      });
    if (!layout) continue;
    const middleFloor = Boolean(layout.incomingDisplay);
    if (layout.incomingDisplay?.sourceEdgeIds.includes(transition.sourceEdgeId))
      layout = layout.incomingDisplay;
    const fromLevel = route.segments?.find(
      (segment) => segment.floorId === transition.fromFloorId,
    )?.nodes?.[0]?.sourceLevel;
    const targetLevel = route.segments?.find(
      (segment) => segment.floorId === transition.toFloorId,
    )?.nodes?.[0]?.sourceLevel;
    const arrivingAtLowerLevel =
      arriving && fromLevel != null && fromLevel > floor.level;
    if (
      !departing &&
      layout.levelRole !== "upper-arrival" &&
      !arrivingAtLowerLevel
    )
      continue;
    if (
      departing &&
      targetLevel != null &&
      targetLevel < floor.level &&
      layout.levelRole !== "upper-arrival"
    )
      continue;
    // Same-level graph stairs have no reliable rise in these source data.
    if (transition.fromFloorId === transition.toFloorId) continue;
    let flights = layout.flights.filter(
      (flight) =>
        !flight.sourceTransitionId ||
        flight.sourceTransitionId === transition.sourceEdgeId,
    );
    if (middleFloor && !stack)
      flights = flights.filter(
        (flight) =>
          Math.abs(flight.baseFraction) < 1e-6 ||
          Math.abs(flight.topFraction) < 1e-6,
      );
    if (!flights.length) continue;
    const world = ([u, v], fraction) => [
      layout.frame.origin[0] +
        layout.frame.axisU[0] * u * layout.frame.size[0] +
        layout.frame.axisV[0] * v * layout.frame.size[1],
      defaults.baseElevation + fraction * floorRise + 0.07,
      layout.frame.origin[1] +
        layout.frame.axisU[1] * u * layout.frame.size[0] +
        layout.frame.axisV[1] * v * layout.frame.size[1],
    ];
    const points = [];
    for (const flight of flights) {
      const a = world(flight.from, flight.baseFraction),
        b = world(flight.to, flight.topFraction);
      const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const n =
        flight.treadCount ??
        Math.max(4, Math.min(28, Math.round(run / defaults.visualTreadLength)));
      points.push(a);
      for (let i = 0; i < n; i++) {
        const y = a[1] + ((b[1] - a[1]) * (i + 1)) / n;
        points.push([
          a[0] + ((b[0] - a[0]) * i) / n,
          y,
          a[2] + ((b[2] - a[2]) * i) / n,
        ]);
        points.push([
          a[0] + ((b[0] - a[0]) * (i + 1)) / n,
          y,
          a[2] + ((b[2] - a[2]) * (i + 1)) / n,
        ]);
      }
    }
    if (
      (departing && layout.levelRole === "upper-arrival") ||
      arrivingAtLowerLevel
    )
      points.reverse();
    paths.push({
      sourceEdgeId: transition.sourceEdgeId,
      floorId: floor.id,
      points,
      layoutId: layout.id,
      status: "photo-shape-approximate-height",
      sourcePoint: departing ? transition.point : transition.targetPoint,
      anchorAtEnd: !departing,
      descending: layout.levelRole === "upper-arrival" && departing,
    });
  }
  return paths;
}

/** Photo evidence adds a physical stair symbol, never an unproven graph edge. */
export function getPhotoStairMarkers(floor) {
  return displayLayoutsForFloor(floor).map((layout) => ({
    id: `photo-stair:${layout.id}`,
    layoutId: layout.id,
    fitAreaId: layout.fitAreaId,
    label: `${stairDisplayLabels.get(layout.id) || layout.label}${layout.building ? ` · корпус ${layout.building}` : ""}`,
    ...(stairDisplayLabels.has(layout.id) ? { sourceLabel: layout.label } : {}),
    kind: "stairs",
    building: layout.building,
    center: layout.center,
    position: layout.center,
    campusId: layout.campusId,
    floorId: layout.floorId,
    hasPolygon: false,
    source:
      layout.existenceStatus === "user-confirmed-existence"
        ? "user-confirmed-location"
        : "photo-fire-plan",
    confidence:
      layout.existenceStatus === "user-confirmed-existence"
        ? "user-confirmed-existence"
        : "photo-plan",
    existenceStatus: layout.existenceStatus,
    destinationLabel:
      layout.id === "v-78-floor1-user-stair-basement"
        ? "ИВЦ · номер этажа уточняется"
        : layout.destinationLabel,
    destinationStatus: layout.destinationStatus,
    routingStatus: layout.routingStatus,
    note: layout.incomingDisplay
      ? "На этом этаже показаны ближайшие марши вверх и вниз в разрезе. Полный объём лестницы доступен в режиме «Этажи». Высоты и размеры приблизительные."
      : layout.shapeReviewStatus === "user-confirmed-schematic"
        ? layout.note
        : layout.id === a146Stair.layoutId
          ? a146Stair.note
          : layout.displayOnlyArrival
            ? "На последнем доступном плане корпуса показан приходящий снизу марш. Продолжение выше не подтверждено; высота и направление внутри клетки приблизительны."
            : layout.note,
    shapeReviewStatus: layout.shapeReviewStatus,
    geometryStatus: layout.geometryStatus,
    geometrySource: layout.geometrySource,
    geometryEvidence: layout.geometryEvidence,
    dimensionsStatus: layout.dimensionsStatus,
    enclosureStatus: layout.enclosureStatus,
    anchorLayoutId: layout.anchorLayoutId,
    levelRole: layout.levelRole,
    levelRoleSource: layout.levelRoleSource,
    displayOnlyArrival: layout.displayOnlyArrival,
    incomingDisplay: layout.incomingDisplay
      ? {
          sourceLowerLayoutId: layout.incomingDisplay.sourceLowerLayoutId,
          sourcePhotoIds: layout.incomingDisplay.sourcePhotoIds,
          evidence: layout.incomingDisplay.evidence,
        }
      : undefined,
    sourcePhotoIds:
      layout.incomingDisplay?.sourcePhotoIds || layout.sourcePhotoIds,
    sourcePhotos: layout.incomingDisplay?.sourcePhotos || layout.sourcePhotos,
    shapeSourcePhotoIds: layout.shapeSourcePhotoIds,
    shapeSourcePhotos: layout.shapeSourcePhotos,
    nativeCoverageException: layout.nativeCoverageException,
    targets: [],
  }));
}

/** Resolve by explicit layout ID or the same native containing area. */
export function stairLayoutFor(marker, floor) {
  return matchStairLayout(marker, floor, displayLayoutsForFloor(floor));
}

function matchStairLayout(marker, floor, layouts) {
  const explicit = layouts.find((layout) => layout.id === marker.layoutId);
  if (explicit) return explicit;
  const anchor = marker.position || marker.center;
  if (!finitePoint(anchor)) return null;
  const sourceIds = marker.sourceIds || [marker.id];
  const graphMatch = layouts.find((layout) => {
    if (!layout.sourceMarkerIds?.some((id) => sourceIds.includes(id)))
      return false;
    if (
      layout.strictSourceMarkerMatch &&
      Math.hypot(anchor[0] - layout.center[0], anchor[1] - layout.center[1]) >
        0.0001
    )
      return false;
    // One graph edge may have several source endpoints on the same level.
    // A hall region only owns the endpoints actually inside its source hall.
    if (!layout.containerAreaId) return true;
    const container = floor.polygons.find(
      (polygon) => polygon.id === layout.containerAreaId,
    );
    return (
      container &&
      inRing(anchor, container.points) &&
      !(container.holes || []).some((hole) => inRing(anchor, hole))
    );
  });
  if (graphMatch) return graphMatch;
  const areaId = marker.fitAreaId || containingArea(anchor, floor)?.id;
  const areaMatch = layouts.find(
    (layout) => !layout.strictSourceMarkerMatch && layout.fitAreaId === areaId,
  );
  if (areaMatch) return areaMatch;
  // Some photographed stair cells retain a room label in the original catalogue.
  return (
    layouts.find((layout) => {
      if (layout.strictSourceMarkerMatch) return false;
      const polygon = floor.polygons.find(
        (candidate) => candidate.id === layout.fitAreaId,
      );
      return (
        polygon &&
        inRing(anchor, polygon.points) &&
        !(polygon.holes || []).some((hole) => inRing(anchor, hole))
      );
    }) || null
  );
}

/** Prefer the other view of this physical stair over a nearby overlapping stair. */
export function resolveStairTarget(marker, sourceFloor, targetFloor, target) {
  const candidates = getMapStairMarkers(targetFloor);
  const paired = stairLayoutFor(marker, sourceFloor)?.pairedLayoutId;
  return (
    (paired && candidates.find((candidate) => candidate.layoutId === paired)) ||
    candidates.find(
      (candidate) =>
        target.center &&
        [
          candidate.center,
          ...(candidate.graphAnchors || []).map((anchor) => anchor.center),
        ].some(
          (point) =>
            point &&
            Math.hypot(
              point[0] - target.center[0],
              point[1] - target.center[1],
            ) < 1,
        ),
    ) ||
    null
  );
}

/** Merge photo shapes with original graph transitions, preserving their endpoints. */
export function getMapStairMarkers(floor) {
  const photos = getPhotoStairMarkers(floor).map((marker) => ({
    ...marker,
    sourceIds: [],
    graphAnchors: [],
  }));
  const byLayout = new Map(photos.map((marker) => [marker.layoutId, marker]));
  const unmatched = [];
  for (const marker of getFloorMarkers(floor)) {
    const layout = stairLayoutFor(marker, floor);
    const photo = layout && byLayout.get(layout.id);
    if (!photo) {
      unmatched.push(marker);
      continue;
    }
    photo.sourceIds.push(...(marker.sourceIds || [marker.id]));
    photo.graphAnchors.push({
      id: marker.id,
      center: marker.center,
      position: marker.position,
      sourceIds: marker.sourceIds || [marker.id],
    });
    for (const target of marker.targets || []) {
      if (
        !photo.targets.some(
          (existing) =>
            existing.floorId === target.floorId &&
            JSON.stringify(existing.center) === JSON.stringify(target.center),
        )
      )
        photo.targets.push({ ...target });
    }
  }
  for (const photo of photos) photo.sourceIds = [...new Set(photo.sourceIds)];
  return [...photos, ...unmatched];
}

/** Confirmed display modules are searchable without rewriting the source index. */
export function withConfirmedStairSearch(index = [], floors = []) {
  const entries = index.filter(
    (place) => place.searchEvidence !== "user-confirmed-stair-display",
  );
  for (const floor of floors)
    for (const marker of getMapStairMarkers(floor))
      if (marker.shapeReviewStatus === "user-confirmed-schematic")
        entries.push({
          ...marker,
          searchEvidence: "user-confirmed-stair-display",
        });
  return entries;
}

/** Present the one source room polygon identified as a stair on IMG_3221.
 * Keep its original catalogue ID and geometry, so links and route anchors do
 * not move. Other polygons labelled A146 are separate places and stay intact.
 */
export function presentStairIdentity(place, floor = null) {
  if (place?.kind === "stairs" && floor) {
    const library = libraryStairLayoutsForFloor(floor)[0];
    if (library) {
      const marker = getMapStairMarkers(floor).find(
        (candidate) =>
          candidate.layoutId === library.id &&
          (candidate.id === place.id ||
            candidate.sourceIds.includes(place.id) ||
            candidate.graphAnchors.some((anchor) => anchor.id === place.id)),
      );
      if (marker) return { ...place, ...marker };
    }
  }
  if (
    !place ||
    place.id !== a146Stair.polygonId ||
    (place.floorId && place.floorId !== a146Stair.floorId) ||
    (place.campusId && place.campusId !== "v-78") ||
    (floor && floor.id !== a146Stair.floorId)
  )
    return place;
  const layout = registry.layouts.find(
    (candidate) => candidate.id === a146Stair.layoutId,
  );
  const marker = floor
    ? getMapStairMarkers(floor).find(
        (candidate) => candidate.layoutId === a146Stair.layoutId,
      )
    : null;
  return {
    ...place,
    kind: "stairs",
    label: stairDisplayLabels.get(a146Stair.layoutId),
    sourceLabel: place.sourceLabel || place.label,
    sourceKind: place.sourceKind || place.kind,
    layoutId: a146Stair.layoutId,
    fitAreaId: a146Stair.polygonId,
    sourcePhotoIds: layout.sourcePhotoIds,
    sourcePhotos: layout.sourcePhotos,
    note: a146Stair.note,
    ...(marker
      ? {
          targets: marker.targets,
          sourceIds: marker.sourceIds,
          graphAnchors: marker.graphAnchors,
        }
      : {}),
  };
}

function pointSymbol(marker, anchor, areaId) {
  const group = new THREE.Group();
  group.name = "Лестница · только исходная точка, форма неизвестна";
  group.position.set(anchor[0], 0, anchor[1]);
  group.userData = {
    room: marker,
    sourceAnchor: [...anchor],
    geometryCenter: [...anchor],
    fitAreaId: areaId,
    geometryStatus: "source-marker-only",
    approximate: true,
    note: "Положение есть в источнике; форма маршей не подтверждена, поэтому объёмная лестница не придумана.",
  };
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(defaults.unknownMarkerRadius, 20),
    new THREE.MeshBasicMaterial({ color: 0x76958a }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.16;
  disc.userData = { room: marker, geometryStatus: "source-marker-only" };
  group.add(disc);
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.2, 0.18, 0.34),
    new THREE.Vector3(-0.2, 0.18, -0.34),
    new THREE.Vector3(-0.2, 0.18, -0.34),
    new THREE.Vector3(-0.38, 0.18, -0.12),
    new THREE.Vector3(-0.2, 0.18, -0.34),
    new THREE.Vector3(-0.02, 0.18, -0.12),
    new THREE.Vector3(0.2, 0.18, -0.34),
    new THREE.Vector3(0.2, 0.18, 0.34),
    new THREE.Vector3(0.2, 0.18, 0.34),
    new THREE.Vector3(0.38, 0.18, 0.12),
    new THREE.Vector3(0.2, 0.18, 0.34),
    new THREE.Vector3(0.02, 0.18, 0.12),
  ]);
  group.add(
    new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xf2f7ef }),
    ),
  );
  return group;
}

/**
 * Render observed plan flights/landings in their native frame. Vertical rise,
 * tread count, rail dimensions and ascent direction are explicitly approximate.
 * Unknown layouts remain point symbols instead of receiving a generic U stair.
 */
export function createStaircase(
  marker,
  floor,
  assumptions = {},
  renderOptions = {},
) {
  const anchor = marker?.position || marker?.center;
  if (!finitePoint(anchor)) return new THREE.Group();
  const registeredLayout = stairLayoutFor(marker, floor);
  const incoming = !renderOptions.stack
    ? registeredLayout?.incomingDisplay
    : null;
  let layout = registeredLayout;
  if (incoming) {
    const up = layout.flights.filter(
      (flight) => Math.abs(flight.baseFraction) < 1e-6,
    );
    const down = incoming.flights.filter(
      (flight) => Math.abs(flight.topFraction) < 1e-6,
    );
    const upper = Math.max(...up.map((flight) => flight.topFraction));
    const lower = Math.min(...down.map((flight) => flight.baseFraction));
    layout = {
      ...layout,
      flights: [...up, ...down],
      landings: [
        ...layout.landings.filter(
          (landing) => landing.elevationFraction <= upper,
        ),
        ...incoming.landings.filter(
          (landing) =>
            landing.elevationFraction >= lower && landing.elevationFraction < 0,
        ),
      ],
      sourcePhotoIds: incoming.sourcePhotoIds,
      sourcePhotos: incoming.sourcePhotos,
    };
  }
  if (!layout)
    return pointSymbol(
      marker,
      anchor,
      containingArea(anchor, floor)?.id || null,
    );
  const overrides = assumptions.stairs || assumptions;
  const options = {
    ...defaults,
    ...overrides,
    colors: { ...defaults.colors, ...overrides.colors },
  };
  const rise = Number.isFinite(layout.verticalRise)
    ? layout.verticalRise
    : Number.isFinite(overrides.floorRise)
      ? overrides.floorRise
      : assumptions.floorHeight || defaults.floorRise;
  const base = options.baseElevation,
    slab = options.slabThickness;
  const group = new THREE.Group();
  group.position.set(anchor[0], 0, anchor[1]);
  const userConfirmed = layout.existenceStatus === "user-confirmed-existence";
  const schematic = layout.shapeReviewStatus === "user-confirmed-schematic";
  const geometryStatus = schematic
    ? "user-confirmed-schematic"
    : userConfirmed
      ? "user-confirmed-stair-approximate-geometry"
      : "photo-plan-layout-approximate-vertical";
  group.name = userConfirmed
    ? `${layout.label} · схема по описанию, размеры приблизительные`
    : `${layout.label} · план ${layout.sourcePhotoIds.join(", ")}`;
  group.userData = {
    room: marker,
    approximate: true,
    geometryStatus,
    sourceAnchor: [...anchor],
    geometryCenter: [...(layout.geometryCenter || layout.center)],
    shapeReviewStatus: layout.shapeReviewStatus,
    geometrySource: layout.geometrySource,
    geometryEvidence: layout.geometryEvidence,
    dimensionsStatus: layout.dimensionsStatus,
    sourceGraphAnchors: marker.graphAnchors,
    middleFloorCutaway: Boolean(incoming),
    incomingLayoutId: incoming?.id,
    incomingEvidence: incoming?.evidence,
    enclosureStatus: layout.enclosureStatus,
    fitAreaId: layout.fitAreaId,
    layoutId: layout.id,
    sourcePhotoIds: layout.sourcePhotoIds,
    shape: layout.shape,
    horizontalStatus: layout.placementStatus,
    verticalStatus: layout.verticalStatus,
    ascentDirectionStatus: layout.ascentDirectionStatus,
    nativeCoverageException: layout.nativeCoverageException,
    existenceStatus: layout.existenceStatus,
    evidence: layout.evidence,
    destinationStatus: layout.destinationStatus,
    routingStatus: layout.routingStatus,
    levelRole: layout.levelRole,
    levelRoleSource: layout.levelRoleSource,
    displayOnlyArrival: layout.displayOnlyArrival,
    floorRise: rise,
    assumptionsUrl: "/data/stair-assumptions.json",
    layoutsUrl: "/data/stair-layouts.json",
    note: layout.displayOnlyArrival
      ? "Приходящий снизу марш на последнем доступном плане корпуса; выше переход не подтверждён. Форма по местному фотоплану, вертикальные размеры приблизительны."
      : userConfirmed
        ? layout.note
        : "Марши и площадки — по пожарному плану; высота, число ступеней и поручни приблизительны.",
  };
  const frame = layout.frame;
  const world = ([u, v]) => [
    frame.origin[0] +
      frame.axisU[0] * u * frame.size[0] +
      frame.axisV[0] * v * frame.size[1] -
      anchor[0],
    frame.origin[1] +
      frame.axisU[1] * u * frame.size[0] +
      frame.axisV[1] * v * frame.size[1] -
      anchor[1],
  ];
  const materials = Object.fromEntries(
    Object.entries({
      ...options.colors,
      ...(layout.enclosureWalls?.length ? { enclosure: "#c4cbd2" } : {}),
    }).map(([key, color]) => [
      key,
      new THREE.MeshStandardMaterial({
        color,
        roughness: key === "railing" ? 0.65 : 0.92,
        metalness: key === "railing" ? 0.15 : 0,
      }),
    ]),
  );
  const batches = new Map();
  function add(geometry, key) {
    if (geometry.index) {
      const old = geometry;
      geometry = geometry.toNonIndexed();
      old.dispose();
    }
    for (const name of Object.keys(geometry.attributes))
      if (!["position", "normal"].includes(name))
        geometry.deleteAttribute(name);
    const batch = batches.get(key) || [];
    batch.push(geometry);
    batches.set(key, batch);
  }
  function box(w, h, d, point, y, angle, key) {
    const geometry = new THREE.BoxGeometry(w, h, d);
    geometry.rotateY(-angle);
    geometry.translate(point[0], y, point[1]);
    add(geometry, key);
  }
  function rod(a, b) {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      delta = end.clone().sub(start),
      length = delta.length();
    if (length < 0.001) return;
    const geometry = new THREE.CylinderGeometry(
      options.railRadius,
      options.railRadius,
      length,
      6,
    );
    const matrix = new THREE.Matrix4().compose(
      start.add(end).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        delta.normalize(),
      ),
      new THREE.Vector3(1, 1, 1),
    );
    geometry.applyMatrix4(matrix);
    add(geometry, "railing");
  }
  const displayedSteps = [];
  for (const flight of layout.flights) {
    const a = world(flight.from),
      b = world(flight.to),
      dx = b[0] - a[0],
      dz = b[1] - a[1],
      run = Math.hypot(dx, dz);
    if (run < 0.1) continue;
    const side = [-dz / run, dx / run],
      angle = Math.atan2(dz, dx);
    const alongU =
      Math.abs(flight.to[0] - flight.from[0]) >
      Math.abs(flight.to[1] - flight.from[1]);
    const width =
      flight.width ?? flight.widthFraction * frame.size[alongU ? 1 : 0];
    const y0 = base + rise * flight.baseFraction,
      y1 = base + rise * flight.topFraction;
    // Visual tessellation follows the native run; no universal count is assigned.
    const n =
      flight.treadCount ??
      Math.max(
        4,
        Math.min(28, Math.round(run / (options.visualTreadLength || 0.3))),
      );
    displayedSteps.push(n);
    const step = run / n,
      dy = (y1 - y0) / n,
      profile = [[0, y0]];
    for (let i = 0; i < n; i++)
      profile.push(
        [i * step, y0 + (i + 1) * dy],
        [(i + 1) * step, y0 + (i + 1) * dy],
      );
    profile.push([run, y1 - slab], [0, y0 - slab]);
    const shape = new THREE.Shape(
      profile.map(([x, y]) => new THREE.Vector2(x, y)),
    );
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.translate(0, 0, -width / 2);
    geometry.rotateY(-angle);
    geometry.translate(a[0], 0, a[1]);
    add(geometry, "structure");
    for (let i = 0; i < n; i++) {
      const d = (i + 0.04) * step,
        p = [a[0] + (dx * d) / run, a[1] + (dz * d) / run];
      box(
        Math.min(0.035, step * 0.14),
        0.018,
        width,
        p,
        y0 + (i + 1) * dy + 0.012,
        angle,
        "nosing",
      );
    }
    for (const sign of [-1, 1]) {
      const offset = sign * (width / 2 - options.railRadius * 2),
        postCount = Math.max(2, Math.ceil(run / 1.2) + 1);
      for (let i = 0; i < postCount; i++) {
        const t = i / (postCount - 1),
          index = Math.min(n - 1, Math.floor(t * n)),
          distance = (index + 0.35) * step;
        const x = a[0] + (dx * distance) / run + side[0] * offset,
          z = a[1] + (dz * distance) / run + side[1] * offset,
          y = y0 + (index + 1) * dy;
        rod([x, y, z], [x, y + options.railingHeight, z]);
      }
      rod(
        [
          a[0] + (dx * 0.35) / n + side[0] * offset,
          y0 + dy + options.railingHeight,
          a[1] + (dz * 0.35) / n + side[1] * offset,
        ],
        [
          b[0] - (dx * 0.65) / n + side[0] * offset,
          y1 + options.railingHeight,
          b[1] - (dz * 0.65) / n + side[1] * offset,
        ],
      );
    }
  }
  for (const landing of layout.landings) {
    const points = landing.points.map(world),
      height = base + rise * landing.elevationFraction;
    const shape = new THREE.Shape(
      points.map(([x, z]) => new THREE.Vector2(x, -z)),
    );
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: slab,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, height - slab, 0);
    add(geometry, "landing");
    // Rails only on explicitly listed free edges; open flight connections stay open.
    for (const edge of landing.railEdges || []) {
      const a = points[edge],
        b = points[(edge + 1) % points.length];
      rod([a[0], height, a[1]], [a[0], height + options.railingHeight, a[1]]);
      rod([b[0], height, b[1]], [b[0], height + options.railingHeight, b[1]]);
      rod(
        [a[0], height + options.railingHeight, a[1]],
        [b[0], height + options.railingHeight, b[1]],
      );
    }
  }
  for (const wall of layout.enclosureWalls || []) {
    const a = world(wall.from),
      b = world(wall.to);
    const low = base + rise * wall.bottomFraction;
    const high = base + rise * wall.topFraction;
    box(
      Math.hypot(b[0] - a[0], b[1] - a[1]),
      high - low,
      wall.thickness || 0.14,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      (low + high) / 2,
      Math.atan2(b[1] - a[1], b[0] - a[0]),
      "enclosure",
    );
  }
  for (const [key, geometries] of batches) {
    const geometry = mergeGeometries(geometries);
    geometries.forEach((item) => item.dispose());
    const mesh = new THREE.Mesh(geometry, materials[key]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${layout.label} · ${key}`;
    mesh.userData = {
      room: marker,
      approximate: true,
      layoutId: layout.id,
      sourcePhotoIds: layout.sourcePhotoIds,
      geometryStatus,
    };
    group.add(mesh);
  }
  for (const [key, material] of Object.entries(materials))
    if (!batches.has(key)) material.dispose();
  group.userData.materialBatches = batches.size;
  group.userData.visualStepCounts = displayedSteps;
  return group;
}
