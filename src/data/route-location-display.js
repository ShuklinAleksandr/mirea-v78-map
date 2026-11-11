import { ROUTE_TRACKING_MAX_AGE_MS } from "./route-tracking.js";

// A short visual grace period, not a new estimate of progress or position.
export const ROUTE_LOCATION_HOLD_MS = 12_000;

const confirmedStatuses = new Set([
  "tracking",
  "wrong-way",
  "floor-change",
  "arrived",
]);
const holdStatuses = new Set([
  "stale",
  "low-accuracy",
  "off-route",
  "acquiring",
  "uncertain",
]);
const clearReasons = new Set([
  "outside-route-campus",
  "confirm-route-floor",
  "confirm-route-physical-floor",
  "manual-step",
  "missing-route-geometry",
  "gps-required",
]);
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);

/** Present tracker evidence without changing its point, steps or progress.
 * The controller resets this state on route replacement, manual navigation,
 * backgrounding, preview and viewed-floor changes. No map matching happens here.
 */
export function createRouteLocationDisplay() {
  let current = null;
  let confirmed = null;
  let context = null;
  let observedTimestamp = -Infinity;

  function reset() {
    current = confirmed = context = null;
    observedTimestamp = -Infinity;
  }

  function read(now = Date.now()) {
    if (!current || !Number.isFinite(now)) return null;
    if (
      current.held
        ? now >= current.expiresAt
        : now - current.locationTimestamp > ROUTE_TRACKING_MAX_AGE_MS
    )
      return null;
    return { ...current, point: current.point.slice() };
  }

  function update({
    progress,
    location,
    sourceSegmentIndex,
    enabled = true,
    now = Date.now(),
  } = {}) {
    if (
      !enabled ||
      !Number.isFinite(now) ||
      location?.source !== "gps" ||
      !location.campusId ||
      (location.status && location.status !== "inside") ||
      !progress?.floorId ||
      !Number.isInteger(sourceSegmentIndex) ||
      sourceSegmentIndex < 0 ||
      clearReasons.has(progress.reason) ||
      progress.status === "floor-mismatch" ||
      (Number.isFinite(location.correction?.expiresAt) &&
        now >= location.correction.expiresAt) ||
      (location.floorEvidence === "manual" &&
        (!location.floorId || location.floorId !== progress.floorId))
    ) {
      reset();
      return null;
    }
    const key = JSON.stringify([
      location.campusId,
      progress.floorId,
      sourceSegmentIndex,
      location.correction?.createdAt ?? null,
      location.floorEvidence === "manual"
        ? [location.building ?? null, location.physicalLevel ?? null]
        : null,
    ]);
    if (context !== key) {
      reset();
      context = key;
    }
    const timestamp = location.timestamp;
    if (Number.isFinite(timestamp) && timestamp < observedTimestamp)
      return read(now);
    if (Number.isFinite(timestamp) && timestamp <= now + 2_000)
      observedTimestamp = timestamp;
    const fresh =
      finitePoint(location.point) &&
      Number.isFinite(timestamp) &&
      timestamp <= now + 2_000 &&
      now - timestamp <= ROUTE_TRACKING_MAX_AGE_MS &&
      (!Number.isFinite(location.expiresAt) || now < location.expiresAt) &&
      (!Number.isFinite(location.correction?.expiresAt) ||
        now < location.correction.expiresAt) &&
      (!location.trackingStatus ||
        ["live", "tracking"].includes(location.trackingStatus));
    if (
      fresh &&
      timestamp === progress.locationTimestamp &&
      finitePoint(progress.matchedPoint) &&
      (confirmedStatuses.has(progress.status) ||
        progress.status === "uncertain")
    ) {
      current = {
        point: progress.matchedPoint.slice(0, 2),
        status: progress.status,
        sourceSegmentIndex,
        locationTimestamp: timestamp,
        held: false,
      };
      // Existing tentative motion can be shown, but it cannot extend a hold.
      if (confirmedStatuses.has(progress.status))
        confirmed = { ...current, confirmedAt: timestamp };
      return read(now);
    }
    if (
      confirmed &&
      now < confirmed.confirmedAt + ROUTE_LOCATION_HOLD_MS &&
      (holdStatuses.has(progress.status) ||
        (!fresh && confirmedStatuses.has(progress.status)))
    ) {
      current = {
        ...confirmed,
        point: confirmed.point.slice(),
        status: "uncertain",
        held: true,
        heldSince: current?.held ? current.heldSince : now,
        expiresAt: confirmed.confirmedAt + ROUTE_LOCATION_HOLD_MS,
      };
      return read(now);
    }
    current = confirmed = null;
    return null;
  }

  return {
    update,
    read,
    reset,
    get expiresAt() {
      return current?.held ? current.expiresAt : null;
    },
  };
}
