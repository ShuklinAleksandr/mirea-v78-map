import { pointOf } from "./utils.js";
import { placeLocation } from "./place-location.js";

export function isCurrentUserLocation(location, now = Date.now()) {
  if (!pointOf({ center: location?.point })) return false;
  if (location.source === "manual") return Boolean(location.floorId);
  if (location.source !== "gps" || !Number.isFinite(location.timestamp))
    return false;
  if (
    location.trackingStatus &&
    !["live", "tracking"].includes(location.trackingStatus)
  )
    return false;
  if (location.correction && now >= location.correction.expiresAt) return false;
  const expiresAt = location.expiresAt ?? location.timestamp + 60_000;
  return now >= location.timestamp - 10_000 && now < expiresAt;
}

/** A manually chosen location never borrows an adjacent room or a GPS floor. */
export function manualPlaceLocation(place, floor, campusId, now = Date.now()) {
  const point = pointOf(place);
  if (!point || !floor?.id || !campusId) return null;
  const identity = placeLocation(place, floor);
  return {
    source: "manual",
    campusId,
    floorId: floor.id,
    building: identity.building,
    physicalLevel: identity.physicalLevel,
    floorEvidence: "manual",
    point,
    placeId:
      place.routingStatus === "display-only-no-source-transition"
        ? null
        : place.roomId || place.id || null,
    label: place.label || "Точка на карте",
    timestamp: now,
  };
}

export function manualMapLocation(pick, floor, records, now = Date.now()) {
  const point = pointOf({ position: pick?.point });
  if (!point || pick.floorId !== floor?.id || !pick.campusId) return null;
  const ids = [pick.roomId, pick.areaId].filter(Boolean);
  const circulation = ["corridor", "circulation", "unclassified"].includes(
    pick.kind,
  );
  const place =
    !circulation &&
    records.find(
      (record) =>
        record.campusId === pick.campusId &&
        record.floorId === pick.floorId &&
        ids.includes(record.roomId || record.id),
    );
  const ownIdentity = placeLocation(place || {}, floor);
  const identity =
    ownIdentity.building || Number.isFinite(ownIdentity.physicalLevel)
      ? ownIdentity
      : placeLocation({ building: pick.building }, floor);
  return {
    source: "manual",
    campusId: pick.campusId,
    floorId: pick.floorId,
    building: identity.building,
    physicalLevel: identity.physicalLevel,
    floorEvidence: "manual",
    point,
    placeId: place?.id || null,
    label: place?.label || "Точка на карте",
    timestamp: now,
  };
}

export function describeUserLocation(location, floors = []) {
  if (!location) return "Местоположение пока не указано";
  if (location.source === "gps") {
    const knownFloor =
      location.floorEvidence === "manual" &&
      Number.isFinite(location.physicalLevel);
    const floorLabel = knownFloor
      ? `${location.building ? `корпус ${location.building} · ` : ""}${location.physicalLevel === -1 ? "цоколь" : `${location.physicalLevel} этаж`} (указан вами)`
      : "этаж не определяется GPS";
    return [
      !isCurrentUserLocation(location)
        ? "Последняя позиция · GPS устарел или обновление остановлено"
        : location.correction
          ? "GPS с приблизительной поправкой"
          : "GPS",
      Number.isFinite(location.accuracyMeters)
        ? `точность ±${Math.round(location.accuracyMeters)} м`
        : null,
      floorLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const floor = floors.find((item) => item.id === location.floorId);
  const identity = placeLocation(
    { building: location.building, id: location.placeId },
    floor,
  );
  const level = location.physicalLevel ?? identity.physicalLevel;
  return [
    location.label,
    location.building ? `корпус ${location.building}` : null,
    level != null
      ? level === -1
        ? "цоколь"
        : `${level} этаж`
      : "этаж уточняется",
    "указано вручную",
  ]
    .filter(Boolean)
    .join(" · ");
}
