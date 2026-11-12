import polygonClipping from "polygon-clipping";
import { photographedStairCounterparts } from "../data/stair-counterparts.js";

const samePoint = (a, b) =>
  Array.isArray(a) &&
  a.length === 2 &&
  a.every(
    (value, i) => Number.isFinite(value) && Math.abs(value - b[i]) < 1e-7,
  );
const rectangle = (x, y, X, Y) => [
  [x, y],
  [X, y],
  [X, Y],
  [x, Y],
];

/** Local first-floor photo evidence supplies the shape. The second-floor
 * model does not supply geometry or dimensions, and no other unknown cell
 * is given a staircase merely because its neighbouring floor has one. */
export function photoCounterpartStairLayoutsForFloor(floor) {
  if (
    floor?.campusId !== "v-78" ||
    floor.id !== "v-78-floor1" ||
    floor.level !== 1 ||
    floor.units !== "meters" ||
    floor.buildingLevels?.А !== 1 ||
    !Array.isArray(floor.polygons)
  )
    return [];
  return photographedStairCounterparts.flatMap((reference) => {
    const found = floor.polygons.filter((p) => p.id === reference.sourceAreaId);
    const area = found[0];
    if (
      found.length !== 1 ||
      area.kind !== "unclassified" ||
      area.sourceGeometry !== "native-area-polygon" ||
      area.holes?.length !== 0 ||
      !samePoint(area.center, reference.sourceAreaCenter) ||
      area.points?.length !== reference.sourceAreaPoints.length ||
      !area.points.every((p, i) => samePoint(p, reference.sourceAreaPoints[i]))
    )
      return [];
    if (
      ![floor.markers, floor.transitions].every((collection) => {
        const found = collection?.filter(
          (marker) => marker.id === reference.sourceEdgeId,
        );
        const marker = found?.[0];
        return (
          found?.length === 1 &&
          marker.kind === "stairs" &&
          marker.source === "source-navigation-graph" &&
          marker.confidence === "source-graph" &&
          marker.sourceId === reference.sourceTransitionId &&
          samePoint(marker.position, reference.position) &&
          marker.targetFloorId === reference.targetFloorId &&
          samePoint(marker.targetPosition, reference.targetPosition)
        );
      })
    )
      return [];
    const frame = reference.frame;
    const world = ([u, v]) =>
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
    return [
      {
        id: reference.layoutId,
        campusId: "v-78",
        floorId: floor.id,
        building: reference.building,
        physicalFloor: reference.physicalFloor,
        label: reference.label,
        center: [...reference.position],
        geometryCenter: world([0.5, 0.5]),
        frame,
        fitAreaId: area.id,
        sourcePolygonIds: [area.id],
        sourceMarkerIds: [reference.sourceEdgeId],
        strictSourceMarkerMatch: true,
        sourcePhotoIds: ["photo-3219"],
        sourcePhotos: ["/data/photos/IMG_3219.jpg"],
        shape: "compact-U",
        shapeStatus: "photo-plan-observed",
        placementStatus: "local-native-cell-photo-oriented",
        verticalStatus: "approximate",
        dimensionsStatus: "model-assumptions-not-measured",
        ascentDirectionStatus: "not-inferred-from-evacuation-arrows",
        levelRole: "lower-departure",
        levelRoleSource: "existing-source-upward-transition",
        footprint,
        flights: [
          {
            from: [0.25, 0.75],
            to: [0.25, 0.23],
            widthFraction: 0.42,
            baseFraction: 0,
            topFraction: 0.5,
            treadCount: null,
            treadCountStatus: "not-reliably-readable",
          },
          {
            from: [0.75, 0.23],
            to: [0.75, 0.75],
            widthFraction: 0.42,
            baseFraction: 0.5,
            topFraction: 1,
            treadCount: null,
            treadCountStatus: "not-reliably-readable",
          },
        ],
        landings: [
          { points: rectangle(0.03, 0.02, 0.97, 0.23), elevationFraction: 0.5 },
          { points: rectangle(0.03, 0.75, 0.47, 0.97), elevationFraction: 0 },
          { points: rectangle(0.53, 0.75, 0.97, 0.97), elevationFraction: 1 },
        ],
        landmarkNote: reference.landmarkNote,
        note: "Форма двух маршей и площадки сверена по плану А1 IMG_3219 и соседним подписанным помещениям. Локальное пятно находится внутри исходной лестничной клетки. Высота, размеры ступеней и направление подъёма приблизительные; верхний план не совмещён обмером.",
      },
    ];
  });
}
