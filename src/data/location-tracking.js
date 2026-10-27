/** Foreground tracking policy. All decisions use actual provider fixes; there is
 * no interpolated walking, floor inference, route snapping, or radio model. */
export const LOCATION_CALIBRATION_REVIEW_MS = 120_000;
export const LOCATION_ANCHOR_MAX_AGE_MS = 10_000;
export const LOCATION_CALIBRATION_MAX_ACCURACY_METERS = 50;
export const LOCATION_CALIBRATION_MAX_GAP_MS = 30_000;

const pointValid = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const recent = (timestamp, now, maxAge) =>
  Number.isFinite(timestamp) &&
  timestamp <= now + 10_000 &&
  now - timestamp <= maxAge;
const explicitFloor = (floor) =>
  floor?.campusId &&
  floor.floorId &&
  typeof floor.building === "string" &&
  floor.building.length > 0 &&
  Number.isFinite(floor.physicalLevel) &&
  floor.floorEvidence === "manual"
    ? {
        campusId: floor.campusId,
        floorId: floor.floorId,
        building: floor.building,
        physicalLevel: floor.physicalLevel,
        floorEvidence: "manual",
      }
    : null;

/** The user must explicitly choose a building and its physical floor. Merely
 * browsing a source level is not evidence of the user's current floor. */
export function normalizeTrackingFloor(selection, floors = []) {
  if (
    !selection?.campusId ||
    !selection.floorId ||
    typeof selection.building !== "string" ||
    !Number.isFinite(selection.physicalLevel)
  )
    return null;
  const floor = floors.find((item) => item.id === selection.floorId);
  if (
    !floor ||
    (floor.campusId && floor.campusId !== selection.campusId) ||
    floor.buildingLevels?.[selection.building] !== selection.physicalLevel
  )
    return null;
  return explicitFloor({ ...selection, floorEvidence: "manual" });
}

function usableFix(rawFix, now) {
  return (
    rawFix?.source === "gps" &&
    rawFix.status === "inside" &&
    rawFix.campusId &&
    pointValid(rawFix.point) &&
    Number.isFinite(rawFix.accuracyMeters) &&
    rawFix.accuracyMeters > 0 &&
    rawFix.accuracyMeters <= 200 &&
    recent(rawFix.timestamp, now, 60_000) &&
    (!Number.isFinite(rawFix.expiresAt) || now < rawFix.expiresAt)
  );
}

/** A manual translation applied to actual provider updates, not an indoor positioning system. The provider's
 * error and the approximate map registration remain unknown after alignment. */
export function createLocationCalibration(
  anchor,
  rawFix,
  { now = Date.now(), floor = null } = {},
) {
  if (
    anchor?.source !== "manual" ||
    !anchor.campusId ||
    !anchor.floorId ||
    !pointValid(anchor.point) ||
    !recent(anchor.timestamp, now, LOCATION_ANCHOR_MAX_AGE_MS)
  )
    throw new Error("Сначала укажите, где вы сейчас, на карте.");
  if (
    !usableFix(rawFix, now) ||
    rawFix.campusId !== anchor.campusId ||
    !recent(rawFix.timestamp, now, LOCATION_ANCHOR_MAX_AGE_MS) ||
    Math.abs(rawFix.timestamp - anchor.timestamp) >
      LOCATION_ANCHOR_MAX_AGE_MS ||
    rawFix.accuracyMeters > LOCATION_CALIBRATION_MAX_ACCURACY_METERS
  )
    throw new Error(
      "Для поправки нужен свежий GPS с точностью не хуже ±50 м. Ручная точка сохранена.",
    );
  const selectedFloor = explicitFloor(floor);
  if (
    selectedFloor &&
    (selectedFloor.campusId !== anchor.campusId ||
      selectedFloor.floorId !== anchor.floorId ||
      (anchor.building && selectedFloor.building !== anchor.building) ||
      (Number.isFinite(anchor.physicalLevel) &&
        selectedFloor.physicalLevel !== anchor.physicalLevel))
  )
    throw new Error(
      "Корпус или этаж ручной точки и выбранный этаж не совпадают.",
    );
  const anchorFloor = explicitFloor({
    ...anchor,
    floorEvidence: "manual",
  });
  return {
    type: "manual-offset",
    valid: true,
    campusId: anchor.campusId,
    createdAt: now,
    reviewAt: now + LOCATION_CALIBRATION_REVIEW_MS,
    anchor: { ...anchor, point: anchor.point.slice(0, 2) },
    floor: selectedFloor || anchorFloor,
    offset: anchor.point.slice(0, 2).map((value, i) => value - rawFix.point[i]),
    anchorAccuracyMeters: rawFix.accuracyMeters,
    anchorAccuracyRadiusMap: rawFix.accuracyRadiusMap,
    lastRawPoint: rawFix.point.slice(0, 2),
    lastRawTimestamp: rawFix.timestamp,
  };
}

/** Keep the timestamp of the last observation. A rejected fix never makes a
 * manual anchor or last-known GPS position appear newly observed. */
function held(previous, calibration, status, reason) {
  const fallback = previous || calibration?.anchor || null;
  return {
    location: fallback ? { ...fallback, trackingStatus: status } : null,
    status,
    reason,
    calibration,
  };
}

function invalidCorrection(previous, calibration, reason) {
  return held(
    previous,
    { ...calibration, valid: false, invalidReason: reason },
    "needs-refinement",
    reason,
  );
}

/** Apply one normalized OS fix. Callers may provide a verified map-surface
 * guard; rejection freezes the point and never snaps it into a room/corridor.
 * A failed correction stays failed until the user explicitly aligns it again. */
export function applyLocationTracking(
  rawFix,
  {
    floor = null,
    calibration = null,
    previous = null,
    reapply = false,
    now = Date.now(),
    allowPoint,
  } = {},
) {
  if (calibration) {
    if (!calibration.valid)
      return held(
        previous,
        calibration,
        "needs-refinement",
        calibration.invalidReason || "invalid-correction",
      );
    if (
      !Number.isFinite(calibration.createdAt) ||
      calibration.createdAt > now + 10_000 ||
      (Number.isFinite(calibration.expiresAt) && now >= calibration.expiresAt)
    )
      return invalidCorrection(previous, calibration, "correction-expired");
  }
  if (!usableFix(rawFix, now))
    return held(previous, calibration, "signal-lost", "unusable-fix");
  if (calibration && !recent(rawFix.timestamp, now, LOCATION_ANCHOR_MAX_AGE_MS))
    return held(previous, calibration, "signal-lost", "stale-fix");
  const selectedFloor = explicitFloor(floor);
  if (selectedFloor && selectedFloor.campusId !== rawFix.campusId)
    return held(previous, calibration, "signal-lost", "campus-mismatch");
  if (
    !reapply &&
    previous?.source === "gps" &&
    rawFix.timestamp <= previous.timestamp
  )
    return held(
      previous,
      calibration,
      previous.trackingStatus || "tracking",
      "out-of-order-fix",
    );

  let point = rawFix.point.slice(0, 2);
  let assignedFloor = selectedFloor;
  let correction = null;
  let accuracyMeters = rawFix.accuracyMeters;
  let accuracyRadiusMap = rawFix.accuracyRadiusMap;
  if (calibration) {
    if (
      rawFix.campusId !== calibration.campusId ||
      !pointValid(calibration.offset) ||
      !pointValid(calibration.lastRawPoint) ||
      !Number.isFinite(calibration.lastRawTimestamp)
    )
      return invalidCorrection(previous, calibration, "invalid-correction");
    if (
      selectedFloor &&
      calibration.floor &&
      (selectedFloor.floorId !== calibration.floor.floorId ||
        selectedFloor.building !== calibration.floor.building ||
        selectedFloor.physicalLevel !== calibration.floor.physicalLevel)
    )
      return invalidCorrection(previous, calibration, "floor-changed");
    if (rawFix.accuracyMeters > LOCATION_CALIBRATION_MAX_ACCURACY_METERS)
      return held(previous, calibration, "signal-lost", "poor-accuracy");
    const elapsed = rawFix.timestamp - calibration.lastRawTimestamp;
    if (elapsed < 0)
      return held(previous, calibration, "tracking", "out-of-order-fix");
    if (elapsed > LOCATION_CALIBRATION_MAX_GAP_MS)
      return invalidCorrection(previous, calibration, "signal-gap");
    // This is a conservative spike rejection policy in map metres, not a speed
    // measurement. A long gap or spike requires a fresh manual alignment.
    const jumpBudget = Math.max(12, Math.min(40, (elapsed / 1000) * 4));
    if (distance(rawFix.point, calibration.lastRawPoint) > jumpBudget)
      return invalidCorrection(previous, calibration, "position-jump");
    point = point.map((value, i) => value + calibration.offset[i]);
    assignedFloor ||= calibration.floor || {
      floorId: calibration.anchor.floorId,
      building: calibration.anchor.building || null,
      physicalLevel: Number.isFinite(calibration.anchor.physicalLevel)
        ? calibration.anchor.physicalLevel
        : null,
    };
    accuracyMeters = Math.max(accuracyMeters, calibration.anchorAccuracyMeters);
    accuracyRadiusMap = Math.max(
      accuracyRadiusMap || 0,
      calibration.anchorAccuracyRadiusMap || 0,
    );
    correction = {
      type: "manual-offset",
      approximate: true,
      createdAt: calibration.createdAt,
      reviewAt: calibration.reviewAt,
      reviewRecommended:
        Number.isFinite(calibration.reviewAt) && now >= calibration.reviewAt,
      offset: calibration.offset.slice(),
    };
  }
  if (typeof allowPoint === "function" && !allowPoint(point, assignedFloor))
    return calibration
      ? invalidCorrection(previous, calibration, "point-not-on-known-surface")
      : held(
          previous,
          calibration,
          "signal-lost",
          "point-not-on-known-surface",
        );
  const location = {
    ...rawFix,
    point,
    rawPoint: rawFix.point.slice(0, 2),
    accuracyMeters,
    accuracyRadiusMap,
    floorId: assignedFloor?.floorId || null,
    building: assignedFloor?.building || null,
    physicalLevel: assignedFloor?.physicalLevel ?? null,
    floorEvidence: assignedFloor ? "manual" : "unknown",
    correction,
    trackingStatus: "tracking",
  };
  return {
    location,
    status: "tracking",
    reason: null,
    calibration: calibration
      ? {
          ...calibration,
          lastRawPoint: rawFix.point.slice(0, 2),
          lastRawTimestamp: rawFix.timestamp,
        }
      : null,
  };
}
