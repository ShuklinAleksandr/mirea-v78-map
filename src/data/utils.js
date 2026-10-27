/** Data adapters. These functions never infer dimensions or a room's identity. */
export function pointOf(object) {
  for (const value of [object?.center, object?.position]) {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.slice(0, 2).every(Number.isFinite)
    ) {
      return value.slice(0, 2);
    }
  }
  return null;
}

/** Return the physical floor only if a named building has an explicit mapping.
 * With no building selected, the return value is the source level.
 */
export function physicalLevel(floor, building = null) {
  if (!floor) return null;
  if (!building) return Number.isFinite(floor.level) ? floor.level : null;
  const value = floor.buildingLevels?.[building];
  return Number.isFinite(value) ? value : null;
}

export function levelLabel(floor, building = null) {
  const value = physicalLevel(floor, building);
  if (building && value != null)
    return value === -1 ? "Цоколь" : `${value} этаж`;
  return Number.isFinite(floor?.level)
    ? `Уровень ${floor.level}`
    : "Уровень не указан";
}

export function floorsForBuilding(floors, building = null) {
  if (!building) return floors;
  return floors.filter(
    (floor) =>
      floor.buildings?.includes(building) ||
      Object.hasOwn(floor.buildingLevels || {}, building) ||
      floor.polygons?.some((p) => p.building === building) ||
      floor.markers?.some((p) => p.building === building),
  );
}

/** Normalized point markers, including stairs without polygon footprints.
 * Two graph transitions meeting at one location become one marker with targets.
 * A target is a proven connection; missing targets (MP-1) must remain missing.
 */
export function getFloorMarkers(floor) {
  const groups = new Map();
  for (const source of [
    ...(floor.markers || []),
    ...(floor.transitions || []),
  ]) {
    const center = pointOf(source);
    if (!center) continue;
    const kind = source.kind || "unknown";
    const key = `${kind}:${center.map((n) => n.toFixed(4)).join(",")}`;
    let marker = groups.get(key);
    if (!marker) {
      marker = {
        ...source,
        id: source.targetFloorId
          ? `${source.id || floor.id}@${key}`
          : source.id || `${floor.id}:marker:${groups.size}`,
        floorId: floor.id,
        campusId: floor.campusId,
        level: floor.level,
        center,
        position: center,
        label:
          source.label || (kind === "stairs" ? "Лестница" : "Объект плана"),
        hasPolygon: false,
        sourceIds: [],
        targets: [],
      };
      groups.set(key, marker);
    }
    if (source.id && !marker.sourceIds.includes(source.id))
      marker.sourceIds.push(source.id);
    if (
      source.targetFloorId &&
      !marker.targets.some(
        (t) =>
          t.floorId === source.targetFloorId &&
          JSON.stringify(t.center) === JSON.stringify(source.targetPosition),
      )
    ) {
      marker.targets.push({
        floorId: source.targetFloorId,
        center: source.targetPosition || null,
        sourceId: source.sourceId || source.id,
      });
    }
  }
  return [...groups.values()];
}

/** Resolve an index result without losing its source URL or marker coordinates.
 * `roomId` also covers an area whose polygon was split when repairing SVG rings.
 */
export function resolveRoom(floor, query) {
  if (!floor || !query) return null;
  const incoming = typeof query === "string" ? { id: query } : query;
  const polygons = (floor.polygons || []).filter(
    (p) => p.id === incoming.id || p.roomId === incoming.id,
  );
  const marker = getFloorMarkers(floor).find(
    (m) => m.id === incoming.id || m.sourceIds.includes(incoming.id),
  );
  const geometry = polygons[0] || marker || {};
  const center = pointOf(geometry) || pointOf(incoming);
  if (!center && !polygons.length) return null;
  return {
    ...incoming,
    ...geometry,
    center,
    floorId: floor.id,
    campusId: floor.campusId,
    level: floor.level,
    hasPolygon: polygons.length > 0,
    polygons,
  };
}

/** A point marker has no measured room boundary, even in a metric campus. */
export function geometryEvidence(room, campus = null) {
  if (room?.shapeReviewStatus === "user-confirmed-schematic")
    return {
      kind: "user-schematic",
      label: "Схема по вашему описанию · размеры ≈",
    };
  if (room?.shapeReviewStatus === "requires-correction")
    return {
      kind: "review",
      label: "Схема лестницы уточняется · условная отметка",
    };
  if (room?.displayEvidence?.type === "user-confirmed-room-adjacency")
    return {
      kind: "user-adjacency",
      label: "Примыкание уточнено по описанию · размеры ≈",
    };
  if (room?.sourcePhotoIds?.length)
    return { kind: "photo-plan", label: "Марши по пожарному плану · высота ≈" };
  const hasPolygon = room?.hasPolygon ?? Boolean(room?.points?.length);
  if (!hasPolygon)
    return { kind: "point", label: "Точка из источника · контур не задан" };
  if (room?.kind === "outdoor")
    return { kind: "outdoor", label: "Открытая область из плана" };
  if (
    room?.confidence === "schematic" ||
    campus?.layoutStatus === "schematic" ||
    campus?.id === "mp-1"
  ) {
    return { kind: "schematic", label: "Схематичная геометрия" };
  }
  return { kind: "source-plan", label: "Контур из векторного плана" };
}
