import polygonClipping from "polygon-clipping";
import { firstFloorStairSchematics } from "../data/first-floor-stair-schematics.js";
import { remainingStairSchematics } from "../data/remaining-stair-schematics.js";

const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every((n, i) => Number.isFinite(n) && Math.abs(n - b[i]) < 1e-7);
const rectangle = (x, y, X, Y) => [
  [x, y],
  [X, y],
  [X, Y],
  [x, Y],
];

/** Conditional depictions explicitly authorized by the user. A contour proves
 * containment, not the generic flight shape, orientation or actual stair height. */
export function firstFloorSchematicLayoutsForFloor(floor) {
  return conditionalStairLayoutsForFloor(floor, firstFloorStairSchematics);
}

export function remainingStairSchematicLayoutsForFloor(floor) {
  return conditionalStairLayoutsForFloor(floor, remainingStairSchematics);
}

function conditionalStairLayoutsForFloor(floor, references) {
  if (
    floor?.campusId !== "v-78" ||
    floor.units !== "meters" ||
    !Array.isArray(floor.polygons)
  )
    return [];
  return references
    .filter((r) => r.floorId === floor.id)
    .flatMap((ref) => {
      if (
        ref.building &&
        floor.buildingLevels?.[ref.building] !== ref.physicalFloor
      )
        return [];
      const areas = floor.polygons.filter((p) => p.id === ref.sourceArea.id),
        area = areas[0],
        expected = ref.sourceArea;
      if (
        areas.length !== 1 ||
        area.kind !== expected.kind ||
        area.label !== expected.label ||
        area.sourceGeometry !== expected.sourceGeometry ||
        !samePoint(area.center, expected.center) ||
        area.points?.length !== expected.points.length ||
        !area.points.every((p, i) => samePoint(p, expected.points[i])) ||
        area.holes?.length !== 0
      )
        return [];
      if (
        !ref.portals.every((portal) =>
          [floor.markers, floor.transitions].every((collection) => {
            const matches = collection?.filter(
                (m) =>
                  m.id === portal.sourceEdgeId &&
                  m.sourceId === portal.sourceTransitionId &&
                  samePoint(m.position, portal.position),
              ),
              m = matches?.[0];
            return (
              matches?.length === 1 &&
              m.kind === "stairs" &&
              m.source === "source-navigation-graph" &&
              m.confidence === "source-graph" &&
              m.sourceId === portal.sourceTransitionId &&
              samePoint(m.position, portal.position) &&
              m.targetFloorId === portal.targetFloorId &&
              samePoint(m.targetPosition, portal.targetPosition)
            );
          }),
        )
      )
        return [];
      const frame = ref.frame,
        world = ([u, v]) =>
          frame.origin.map(
            (n, i) =>
              n +
              frame.axisU[i] * u * frame.size[0] +
              frame.axisV[i] * v * frame.size[1],
          );
      const footprint = rectangle(0, 0, 1, 1);
      if (
        polygonClipping.difference([footprint.map(world)], [area.points]).length
      )
        return [];
      const compact = ref.profile === "compact-return";
      const arrival = ref.levelRole === "upper-arrival";
      const flight = (from, to, base, top, width) => ({
        from,
        to,
        baseFraction: arrival ? base - 1 : base,
        topFraction: arrival ? top - 1 : top,
        widthFraction: width,
        treadCount: null,
        treadCountStatus: "schematic-not-observed",
        sourceTransitionId: null,
      });
      const arrivalNote = arrival
        ? " Локальный проём нужен только для видимости условного спуска; его размер и форма не обмерены."
        : "";
      const note = `Условная объёмная модель разрешена пользователем 12 ноября 2026: ${ref.sourcePhotoIds.length ? "на фото подтверждено наличие лестницы, точная форма показана условно" : "известна исходная лестничная точка или подпись ЛК, но форма маршей пока не проверена"}. Пятно ограничено собственной исходной клеткой; размеры, направление, высота, ступени и перила условные. ${compact ? "Два марша показаны как условный пример, а не как подтверждённый обмер." : "Показан только условный фрагмент марша, не полное соединение этажей."} ${ref.portals.length ? "Для маршрутов сохранены прежние порталы без смещения." : "Межэтажных маршрутных соединений для этой клетки в источнике нет; они не добавлены."}${arrivalNote}`;
      return [
        {
          id: ref.layoutId,
          campusId: "v-78",
          floorId: floor.id,
          building: ref.building,
          physicalFloor: ref.physicalFloor,
          label: ref.label,
          center: [...(ref.portals[0]?.position || area.center)],
          geometryCenter: world([0.5, 0.5]),
          frame,
          footprint,
          fitAreaId: area.id,
          sourcePolygonIds: [area.id],
          containerAreaId: area.id,
          sourceMarkerIds: ref.portals.map((p) => p.sourceEdgeId),
          sourcePortals: ref.portals,
          strictSourceMarkerMatch: true,
          sourcePhotoIds: ref.sourcePhotoIds,
          sourcePhotos: ref.sourcePhotoIds.map(
            (id) => `/data/photos/IMG_${id.slice(6)}.jpg`,
          ),
          shapeSourcePhotoIds: [],
          shapeSourcePhotos: [],
          shape: compact
            ? "conditional-compact-return"
            : "conditional-representative-flight",
          shapeStatus: "unverified-shape-user-authorized-schematic",
          shapeReviewStatus: "user-authorized-schematic",
          geometryStatus: "user-authorized-schematic",
          geometrySource: "conditional-profile-within-native-cell",
          geometryEvidence:
            ref.geometryEvidence ||
            "user-authorized-first-floor-schematic-2026-11-12",
          existenceStatus: ref.existenceStatus || "user-confirmed-existence",
          dimensionsStatus: "model-assumptions-not-measured",
          placementStatus: "conditional-local-frame-inside-source-cell",
          verticalStatus: "approximate-not-measured",
          ascentDirectionStatus: "unknown-schematic",
          evidence: {
            type: "user-authorized-conditional-display",
            authorizedAt: "2026-11-12",
            description: note,
          },
          note,
          levelRole: ref.levelRole || "lower-departure",
          ...(arrival
            ? {
                displayCutout: true,
                displayCutoutFootprints: [rectangle(0.1, 0.14, 0.9, 0.97)],
                enclosureStatus: "conditional-local-opening-not-measured",
              }
            : {}),
          levelRoleSource: ref.levelRole
            ? "existing-source-endpoint-display-fragment"
            : ref.portals.length
              ? "existing-upward-source-portal"
              : "schematic-depiction-no-vertical-connection",
          routingStatus: ref.portals.length
            ? "existing-source-portals-only"
            : "display-only-no-source-transition",
          verticalRise: ref.verticalRise,
          focusDirectionLocal: [0.15, 3, 1],
          flights: compact
            ? [
                flight([0.25, 0.86], [0.25, 0.2], 0, 0.5, 0.38),
                flight([0.75, 0.2], [0.75, 0.86], 0.5, 1, 0.38),
              ]
            : [flight([0.5, 0.88], [0.5, 0.14], 0, 1, 0.74)],
          landings: compact
            ? [
                {
                  points: rectangle(0.06, 0.04, 0.94, 0.2),
                  elevationFraction: 0.5,
                },
                {
                  points: rectangle(0.06, 0.86, 0.44, 0.96),
                  elevationFraction: 0,
                },
                {
                  points: rectangle(0.56, 0.86, 0.94, 0.96),
                  elevationFraction: 1,
                },
              ]
            : [
                {
                  points: rectangle(0.13, 0.04, 0.87, 0.14),
                  elevationFraction: arrival ? 0 : 1,
                },
                {
                  points: rectangle(0.13, 0.88, 0.87, 0.96),
                  elevationFraction: arrival ? -1 : 0,
                },
              ],
        },
      ];
    });
}
