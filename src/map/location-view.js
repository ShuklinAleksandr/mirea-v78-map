import {
  GPS_MAX_AGE_MS,
  pointInLocationPolygon,
  projectGpsToMap,
} from "../location.js";
import registration from "../data/gps-registration.json" with { type: "json" };

export const USER_HEADING_MAX_AGE_MS = 5_000;

/** A compass observation is separate from GPS course or camera rotation. */
export function presentUserHeading(heading, location, now = Date.now()) {
  if (
    !heading ||
    heading.source !== "compass" ||
    !Number.isFinite(heading.degrees) ||
    !Number.isFinite(heading.timestamp) ||
    heading.timestamp > now + 10_000 ||
    now - heading.timestamp > USER_HEADING_MAX_AGE_MS ||
    !["magnetic", "true"].includes(heading.reference)
  )
    return null;
  const degrees = ((heading.degrees % 360) + 360) % 360;
  const origin = registration.anchors[0];
  const latitude = Number.isFinite(location?.latitude)
    ? location.latitude
    : origin.latitude;
  const longitude = Number.isFinite(location?.longitude)
    ? location.longitude
    : origin.longitude;
  const radians = (degrees * Math.PI) / 180;
  const from = projectGpsToMap(longitude, latitude);
  const to = projectGpsToMap(
    longitude +
      Math.sin(radians) / (111_320 * Math.cos((latitude * Math.PI) / 180)),
    latitude + Math.cos(radians) / 111_320,
  );
  if (!from || !to) return null;
  const vector = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(...vector);
  if (!length) return null;
  const accuracy = heading.accuracyDegrees ?? heading.accuracy;
  if (Number.isFinite(accuracy) && accuracy < 0) return null;
  return {
    degrees,
    vector: vector.map((value) => value / length),
    accuracyDegrees: Number.isFinite(accuracy) ? accuracy : null,
    label: `Направление телефона ${Math.round(degrees)}°${heading.reference === "magnetic" ? " · магнитный компас, приблизительно" : " · по компасу"}`,
  };
}

const inRing = (point, points) => pointInLocationPolygon(point, { points });

function onWall(point, wall, defaultThickness) {
  if (!wall.a || !wall.b) return false;
  const dx = wall.b[0] - wall.a[0],
    dz = wall.b[1] - wall.a[1],
    squared = dx * dx + dz * dz;
  if (!squared) return false;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - wall.a[0]) * dx + (point[1] - wall.a[1]) * dz) / squared,
    ),
  );
  return (
    Math.hypot(point[0] - wall.a[0] - t * dx, point[1] - wall.a[1] - t * dz) <=
    (wall.width || defaultThickness) / 2
  );
}

/** Match the existing rendered slab, including corridors with no room polygon.
 * A footprint hit has no room identity and never borrows a nearby classroom.
 */
export function pickLocationSurface(
  floor,
  point,
  { building = null, cutouts = [], wallThickness = 0.2 } = {},
) {
  if (
    !floor ||
    !Array.isArray(point) ||
    point.length < 2 ||
    !point.slice(0, 2).every(Number.isFinite)
  )
    return null;
  const footprints = floor.footprints || [];
  if (
    footprints.length &&
    !footprints.some((polygon) => pointInLocationPolygon(point, polygon))
  )
    return null;
  if (
    cutouts.some((cutout) => inRing(point, cutout.points)) ||
    (floor.walls || []).some((wall) => onWall(point, wall, wallThickness))
  )
    return null;
  const polygons = floor.polygons || [];
  const room = polygons.find((polygon) =>
    pointInLocationPolygon(point, polygon),
  );
  if (room)
    return {
      building: room.building || building,
      kind: room.kind || "room",
      room,
      roomId:
        room.kind === "unclassified" ||
        room.kind === "circulation" ||
        room.kind === "corridor"
          ? null
          : room.roomId || room.id || null,
      areaId: room.sourceAreaId || room.id || null,
    };
  // Polygon holes are explicit missing surfaces, not unnamed corridor space.
  if (
    !footprints.length ||
    polygons.some((polygon) =>
      (polygon.holes || []).some((hole) => inRing(point, hole)),
    )
  )
    return null;
  return {
    building,
    kind: "circulation",
    room: null,
    roomId: null,
    areaId: null,
  };
}

/** Render projection does not change the user's confirmed floor or coordinates. */
export function presentLocationOnMap(
  location,
  {
    campusId,
    mode,
    floor,
    floors = [],
    stages = [],
    survey = false,
    now = Date.now(),
  },
) {
  if (
    !location ||
    location.campusId !== campusId ||
    !Array.isArray(location.point) ||
    location.point.length < 2 ||
    !location.point.slice(0, 2).every(Number.isFinite) ||
    !["manual", "gps"].includes(location.source) ||
    !["overview", "floor", "building-overview", "route-overview"].includes(mode)
  )
    return null;
  const gps = location.source === "gps";
  const expiresAt = Number.isFinite(location.expiresAt)
    ? location.expiresAt
    : location.timestamp + GPS_MAX_AGE_MS;
  const expired = gps && now >= expiresAt;
  const correctionExpired =
    gps &&
    Number.isFinite(location.correction?.expiresAt) &&
    now >= location.correction.expiresAt;
  if (
    gps &&
    (!Number.isFinite(location.timestamp) ||
      location.timestamp > now + 10_000 ||
      (expired && !location.trackingStatus))
  )
    return null;
  const knownFloor = Boolean(
    location.floorId &&
      (gps
        ? location.floorEvidence === "manual"
        : location.floorEvidence !== "unknown"),
  );
  const stacked = mode.endsWith("-overview");
  const matchingStage = knownFloor
    ? stages.find((stage) => stage.floorId === location.floorId)
    : null;
  const visibleStage = stages.find((stage) => stage.floorId === floor?.id);
  const sameFloor = knownFloor && location.floorId === floor?.id;
  if (
    survey &&
    (!knownFloor ||
      mode === "overview" ||
      (stacked ? !matchingStage : !sameFloor))
  )
    return null;
  const sourceFloor = floors.find((item) => item.id === location.floorId);
  const physicalLevel =
    location.physicalLevel ?? sourceFloor?.buildingLevels?.[location.building];
  const floorLabel = !knownFloor
    ? null
    : Number.isFinite(physicalLevel)
      ? physicalLevel === -1
        ? "цоколь"
        : `${physicalLevel} этаж`
      : mode !== "overview" && !sameFloor
        ? "другой этаж"
        : null;
  const manualUnrefreshed =
    !gps &&
    ["needs-refinement", "signal-lost"].includes(location.trackingStatus);
  const stale = Boolean(
    manualUnrefreshed ||
      (gps &&
        (expired ||
          correctionExpired ||
          (location.trackingStatus && location.trackingStatus !== "live"))),
  );
  const label = [
    survey
      ? "Точка замера"
      : manualUnrefreshed
        ? "Указано вручную · нет обновления"
        : stale
          ? "Последняя позиция"
          : gps
            ? location.correction?.type === "manual-offset"
              ? "GPS с поправкой"
              : "GPS"
            : "Я здесь",
    floorLabel,
    gps && Number.isFinite(location.accuracyMeters)
      ? `±${Math.round(location.accuracyMeters)} м`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    label,
    y: (stacked ? (matchingStage || visibleStage)?.y || 0 : 0) + 0.4,
    floorState: !knownFloor
      ? "unknown"
      : !sameFloor && mode !== "overview"
        ? "other-floor"
        : "known",
    projection:
      !knownFloor ||
      (!sameFloor && mode === "floor") ||
      (stacked && !matchingStage),
    stale,
  };
}
