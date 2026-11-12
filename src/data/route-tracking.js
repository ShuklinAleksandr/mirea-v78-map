import {
  createRouteGuidance,
  guidanceAnchorForStep,
} from "../map/route-guidance.js";

// This estimates progress and an optional display point on the existing path.
// The observation itself and its floor evidence are never changed.
export const ROUTE_TRACKING_MAX_ACCURACY_METERS = 12;
export const ROUTE_TRACKING_MAX_AGE_MS = 10_000;
export const routeTrackingMatchRadius = (location) =>
  Math.min(
    4,
    Math.max(
      1.5,
      (location.accuracyRadiusMap || location.accuracyMeters) * 0.6,
    ),
  );
const EPSILON = 1e-7;
const MAX_AMBIGUOUS_ROUTE_AGE_MS = 30_000;
const MAX_AMBIGUOUS_FIX_GAP_MS = 4_000;
const pointValid = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const blobKey = (location) => location?.correction?.createdAt ?? null;

function matchingLegs(section) {
  const legs = [];
  let baseDirection;
  for (let i = 1; i < section.points.length; i++) {
    const a = section.points[i - 1],
      b = section.points[i];
    const length = distance(a, b);
    if (length < EPSILON) continue;
    const direction = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    // Keep the original source edges; only group nearly collinear neighbours
    // for matching. Comparing with the leg's first heading cannot merge a loop.
    if (
      !legs.length ||
      direction[0] * baseDirection[0] + direction[1] * baseDirection[1] <
        Math.cos(Math.PI / 9)
    ) {
      legs.push({
        first: i - 1,
        last: i - 1,
        start: section.distances[i - 1],
        end: section.distances[i],
      });
      baseDirection = direction;
    } else {
      legs.at(-1).last = i - 1;
      legs.at(-1).end = section.distances[i];
    }
  }
  return legs;
}

function sourceContexts(route, section) {
  const source = route.segments?.[section.sourceSegmentIndex];
  if (
    !Array.isArray(source?.nodes) ||
    source.nodes.length !== source.points.length
  )
    return null;
  const vertices = [];
  for (let i = 0; i < source.points.length; i++) {
    const point = source.points[i];
    const node = source.nodes[i];
    if (
      !pointValid(node?.position) ||
      distance(point, node.position) > EPSILON ||
      (node.floorId && node.floorId !== section.floorId)
    )
      return null;
    if (!i || distance(source.points[i - 1], point) > EPSILON)
      vertices.push([]);
    vertices.at(-1).push({
      floorId: node.floorId,
      kind: node.kind,
      building:
        typeof node.building === "string" && node.building.trim()
          ? node.building.trim()
          : null,
      physicalLevel: Number.isFinite(node.physicalLevel)
        ? node.physicalLevel
        : null,
    });
  }
  if (vertices.length !== section.points.length) return null;
  return { vertices, all: vertices.flat() };
}

function matchesManualContext(location, source, section, candidate, levels) {
  if (location.floorEvidence !== "manual") return true;
  const building =
    typeof location.building === "string" && location.building.trim()
      ? location.building.trim()
      : null;
  const level = Number.isFinite(location.physicalLevel)
    ? location.physicalLevel
    : null;
  if (!building && level == null) return true;
  if (!source) return false;
  const first = candidate.edgeIndex;
  const last = Math.min(first + 1, section.points.length - 1);
  const edge = [...source.vertices[first], ...source.vertices[last]];
  // A confirmed source plan can use different floor numbers in adjacent
  // wings. Accept only its mapped horizontal edge, never a staircase.
  if (
    first !== last &&
    level != null &&
    location.floorId === section.floorId &&
    levels?.[building] === level &&
    edge.every(
      (node) =>
        node.floorId === section.floorId &&
        !["stairs", "elevator", "lift"].includes(node.kind) &&
        node.building &&
        Number.isFinite(node.physicalLevel) &&
        levels[node.building] === node.physicalLevel,
    )
  )
    return true;
  // A manual A1 anchor cannot authorize another wing's level1 when this
  // section only contains A2. The known anchor context must exist on the path.
  if (
    building &&
    !source.all.some(
      (node) =>
        node.building === building &&
        (level == null || node.physicalLevel === level),
    )
  )
    return false;
  const contexts =
    distance(candidate.point, section.points[first]) <= EPSILON
      ? source.vertices[first]
      : distance(candidate.point, section.points[last]) <= EPSILON
        ? source.vertices[last]
        : edge;
  if (level != null) {
    // Different wings can share a physical floor. Match the actual edge's
    // levels rather than forcing its building to equal an old manual anchor.
    // Unknown or contradictory endpoint levels do not prove that match.
    return (
      contexts.length > 0 &&
      contexts.every((node) => node.physicalLevel === level)
    );
  }
  return contexts.some((node) => node.building === building);
}

function project(
  section,
  legs,
  point,
  reference,
  budget,
  allowRetreat,
  onlyLeg = null,
) {
  if (section.points.length === 1)
    return {
      distance: 0,
      error: distance(point, section.points[0]),
      point: [...section.points[0]],
      edgeIndex: 0,
    };
  const legIndex = Math.max(
    0,
    legs.findIndex((leg) => reference <= leg.end + EPSILON),
  );
  const allowed = [legs[legIndex]];
  if (legs[legIndex + 1] && reference >= legs[legIndex].end - 2.5)
    allowed.push(legs[legIndex + 1]);
  if (
    allowRetreat &&
    legs[legIndex - 1] &&
    reference <= legs[legIndex].start + 2.5
  )
    allowed.push(legs[legIndex - 1]);
  let best = null;
  for (const leg of onlyLeg ? [onlyLeg] : allowed) {
    if (!leg) continue;
    for (let i = leg.first; i <= leg.last; i++) {
      const a = section.points[i],
        b = section.points[i + 1];
      const length = section.distances[i + 1] - section.distances[i];
      const min = Math.max(
        0,
        reference - (allowRetreat ? budget : 3),
        section.distances[i],
      );
      const max = Math.min(
        section.length,
        reference + budget,
        section.distances[i + 1],
      );
      if (min > max + EPSILON || length < EPSILON) continue;
      const unboundedT = clamp(
        ((point[0] - a[0]) * (b[0] - a[0]) +
          (point[1] - a[1]) * (b[1] - a[1])) /
          length ** 2,
        0,
        1,
      );
      const t = clamp(
        unboundedT,
        Math.max(0, (min - section.distances[i]) / length),
        Math.min(1, (max - section.distances[i]) / length),
      );
      const projected = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const along = section.distances[i] + t * length;
      const error = distance(projected, point);
      const score =
        error +
        Math.abs(along - reference) * 0.05 +
        (along < reference - 0.5 ? 0.25 : 0);
      if (!best || score < best.score - EPSILON)
        best = {
          distance: along,
          unboundedDistance: section.distances[i] + unboundedT * length,
          error,
          point: projected,
          edgeIndex: i,
          leg,
          score,
        };
    }
  }
  return best;
}

export function createRouteTracker(route) {
  const guide = createRouteGuidance(route);
  const legs = guide.sections.map(matchingLegs);
  const contexts = guide.sections.map((section) =>
    sourceContexts(route, section),
  );
  const metric = Number.isFinite(route?.distanceMeters);
  const metricPlan = metric || Number.isFinite(route?.horizontalDistanceMeters);
  let state = {
    status: "waiting",
    reason: "waiting-for-gps",
    sectionIndex: 0,
    distance: 0,
    stepIndex: 0,
    arrived: false,
    atEnd: false,
    locationTimestamp: null,
  };
  let probe = null,
    continuity = null,
    ambiguousProbe = null,
    observedTimestamp = -Infinity,
    correction = null,
    endCount = 0,
    reverse = null,
    recoveringFromReverse = false,
    matchedPoint = null;

  function snapshot() {
    const section = guide.sections[state.sectionIndex];
    const anchor = guidanceAnchorForStep(guide, state.stepIndex);
    return {
      ...state,
      nextStepIndex: state.stepIndex,
      floorId: section?.floorId || null,
      transition: section?.transition || null,
      matchedPoint: matchedPoint?.slice() ?? null,
      distanceToNextMeters:
        metric && anchor?.sectionIndex === state.sectionIndex
          ? Math.max(0, anchor.distance - state.distance)
          : null,
      remainingMeters: metric
        ? guide.sections
            .slice(state.sectionIndex)
            .reduce(
              (sum, item, i) =>
                sum + Math.max(0, item.length - (i ? 0 : state.distance)),
              0,
            )
        : null,
      distanceModel: metric ? "horizontal" : null,
    };
  }

  function hold(
    status,
    reason,
    point = null,
    locationTimestamp = state.locationTimestamp,
  ) {
    probe = null;
    ambiguousProbe = null;
    endCount = 0;
    reverse = null;
    matchedPoint = point;
    state = { ...state, status, reason, locationTimestamp };
    return snapshot();
  }

  function seekStep(index) {
    const anchor = guidanceAnchorForStep(guide, index);
    if (!anchor) return null;
    state = {
      ...state,
      status: "waiting",
      reason: "manual-step",
      sectionIndex: anchor.sectionIndex,
      distance: anchor.distance,
      stepIndex: index,
      arrived: false,
      atEnd: false,
      locationTimestamp: null,
    };
    probe = null;
    continuity = null;
    ambiguousProbe = null;
    endCount = 0;
    reverse = null;
    recoveringFromReverse = false;
    matchedPoint = null;
    return snapshot();
  }

  function update(
    location,
    {
      now = Date.now(),
      floorId = null,
      floorBuildingLevels,
      allowPoint,
      pauseOnReverse = false,
    } = {},
  ) {
    if (state.arrived) return snapshot();
    const section = guide.sections[state.sectionIndex];
    if (!section) return hold("waiting", "missing-route-geometry");
    if (location?.source !== "gps") return hold("waiting", "gps-required");
    if (!Number.isFinite(location.timestamp))
      return hold("stale", "missing-timestamp");
    if (blobKey(location) !== correction) {
      correction = blobKey(location);
      probe = null;
      continuity = null;
      ambiguousProbe = null;
      endCount = 0;
      reverse = null;
      observedTimestamp = -Infinity;
    }
    // UI refreshes, repeated sensor deliveries and out-of-order callbacks are
    // not independent observations and must not clear pending good evidence.
    if (location.timestamp < observedTimestamp) return snapshot();
    const duplicate = location.timestamp === observedTimestamp;
    observedTimestamp = location.timestamp;
    if (
      location.timestamp > now + 2_000 ||
      now - location.timestamp > ROUTE_TRACKING_MAX_AGE_MS ||
      (Number.isFinite(location.expiresAt) && now >= location.expiresAt) ||
      (Number.isFinite(location.correction?.expiresAt) &&
        now >= location.correction.expiresAt) ||
      (location.trackingStatus &&
        !["live", "tracking"].includes(location.trackingStatus))
    )
      return hold("stale", "no-fresh-position");
    if (
      !pointValid(location.point) ||
      location.campusId !== route.campusId ||
      (location.status && location.status !== "inside")
    )
      return hold("off-route", "outside-route-campus");
    const knownFloor =
      location.floorEvidence === "manual" ? location.floorId : null;
    if (
      (knownFloor && knownFloor !== section.floorId) ||
      (floorId && floorId !== section.floorId) ||
      (!knownFloor && !floorId)
    )
      return hold("floor-mismatch", "confirm-route-floor");
    if (
      !Number.isFinite(location.accuracyMeters) ||
      location.accuracyMeters <= 0 ||
      location.accuracyMeters > ROUTE_TRACKING_MAX_ACCURACY_METERS
    )
      return hold("low-accuracy", "position-too-uncertain");

    let priorFix = ambiguousProbe || continuity;
    const gap = priorFix ? location.timestamp - priorFix.timestamp : null;
    if (gap != null && gap > 15_000) {
      probe = null;
      continuity = null;
      ambiguousProbe = priorFix = null;
      endCount = 0;
      reverse = null;
    }
    const elapsed = priorFix
      ? (location.timestamp - priorFix.timestamp) / 1000
      : null;
    const budget =
      elapsed == null ? 18 : Math.max(4, Math.min(18, elapsed * 3 + 3));
    const rawJump =
      priorFix && distance(priorFix.point, location.point) > budget;
    const reference =
      pauseOnReverse && priorFix
        ? priorFix.distance
        : Math.max(state.distance, continuity?.distance || 0);
    const candidate = project(
      section,
      legs[state.sectionIndex],
      location.point,
      reference,
      budget,
      pauseOnReverse,
    );
    // Line following uses the already verified route, including its doors
    // and corners. GPS may drift sideways into a room or outside its slab;
    // that observation is not a new walking connection through that wall.
    const lineFollowing =
      pauseOnReverse && metricPlan && typeof allowPoint === "function";
    const progressDeadband = lineFollowing
      ? Math.min(
          2,
          Math.max(
            1,
            (location.accuracyRadiusMap || location.accuracyMeters) * 0.2,
          ),
        )
      : 0;
    const crossTrackLimit = lineFollowing
      ? Math.min(
          8,
          Math.max(
            1.5,
            (location.accuracyRadiusMap || location.accuracyMeters) * 0.85,
          ),
        )
      : routeTrackingMatchRadius(location);
    const allowedContext = (match) =>
      matchesManualContext(
        location,
        contexts[state.sectionIndex],
        section,
        match,
        typeof allowPoint === "function" ? floorBuildingLevels : null,
      );
    if (candidate?.error <= crossTrackLimit && !allowedContext(candidate))
      return hold("floor-mismatch", "confirm-route-physical-floor");
    const connectorClear = (from, to, match) => {
      if (typeof allowPoint !== "function") return true;
      try {
        return Boolean(
          allowPoint([...from], [...to], section, match.edgeIndex),
        );
      } catch {
        // A missing/invalid source footprint cannot authorize progress.
        return false;
      }
    };
    const closeMatch = candidate?.error <= crossTrackLimit;
    if (duplicate && closeMatch) return snapshot();
    const progressJump =
      candidate &&
      priorFix &&
      Math.abs(
        (lineFollowing ? candidate.unboundedDistance : candidate.distance) -
          priorFix.distance,
      ) >
        budget + EPSILON;
    const safeMatch =
      closeMatch &&
      (!rawJump || lineFollowing) &&
      !progressJump &&
      connectorClear(
        lineFollowing ? candidate.point : location.point,
        candidate.point,
        candidate,
      );
    if (!safeMatch) {
      // A GPS accuracy disc can still cover the same corridor even when its
      // reported centre drifts across a wall. This permits only a tentative
      // marker on that already verified straight leg, never route progress.
      const leg = continuity?.leg;
      if (
        pauseOnReverse &&
        metricPlan &&
        leg &&
        matchedPoint &&
        !state.atEnd &&
        ["tracking", "uncertain"].includes(state.status) &&
        gap <= MAX_AMBIGUOUS_FIX_GAP_MS &&
        location.timestamp - continuity.timestamp <=
          MAX_AMBIGUOUS_ROUTE_AGE_MS &&
        typeof allowPoint === "function"
      ) {
        const nearby =
          candidate?.leg === leg
            ? candidate
            : project(
                section,
                legs[state.sectionIndex],
                location.point,
                reference,
                budget,
                true,
                leg,
              );
        const radius = Math.min(
          ROUTE_TRACKING_MAX_ACCURACY_METERS,
          location.accuracyRadiusMap || location.accuracyMeters,
        );
        if (
          nearby?.error <= radius &&
          allowedContext(nearby) &&
          connectorClear(nearby.point, nearby.point, nearby)
        ) {
          if (duplicate) return snapshot();
          const travel = nearby.distance - priorFix.distance;
          if (Math.abs(travel) <= 1.25 + elapsed * 2.7) {
            if (
              ambiguousProbe &&
              travel >= -0.5 &&
              nearby.distance >= continuity.distance &&
              connectorClear(matchedPoint, nearby.point, nearby)
            )
              matchedPoint = nearby.point;
            ambiguousProbe = {
              timestamp: location.timestamp,
              point: location.point.slice(0, 2),
              distance: nearby.distance,
            };
            probe = null;
            endCount = 0;
            reverse = null;
            state = {
              ...state,
              status: "uncertain",
              reason: "ambiguous-route-position",
              locationTimestamp: location.timestamp,
            };
            return snapshot();
          }
        }
      }
      const reason =
        rawJump && !lineFollowing
          ? "position-jump"
          : progressJump
            ? "route-progress-jump"
            : closeMatch
              ? "unverified-map-connector"
              : "away-from-current-path";
      return hold("off-route", reason);
    }

    const wasAmbiguous = Boolean(ambiguousProbe);
    ambiguousProbe = null;
    const previous = probe;
    const lastMatch =
      previous || (state.status === "wrong-way" ? continuity : null);
    probe = {
      timestamp: location.timestamp,
      point: location.point.slice(0, 2),
      distance: candidate.distance,
      leg: candidate.leg,
    };
    continuity = probe;
    if (pauseOnReverse && lastMatch) {
      const delta = candidate.distance - lastMatch.distance;
      if (delta < -0.5)
        reverse = {
          count: (reverse?.count || 0) + 1,
          distance: (reverse?.distance || 0) - delta,
        };
      else if (delta > 0.5) reverse = null;
      if (
        (state.status === "wrong-way" && delta <= 0.5) ||
        (recoveringFromReverse && delta < -0.5) ||
        (reverse?.count >= 2 &&
          reverse.distance >= Math.max(3, routeTrackingMatchRadius(location)) &&
          // A noisy peak followed by a noisy trough is not a confirmed
          // retreat while both remain around the stable progress anchor.
          (!lineFollowing ||
            candidate.distance < state.distance - progressDeadband - EPSILON))
      ) {
        recoveringFromReverse = true;
        return hold(
          "wrong-way",
          "moving-away-from-destination",
          candidate.point,
          location.timestamp,
        );
      }
    }
    const endTolerance = Math.min(2, section.length * 0.2);
    const nearEnd =
      candidate.distance >= section.length - endTolerance - EPSILON &&
      distance(location.point, section.points.at(-1)) <= 2 &&
      location.accuracyMeters <= 6;
    endCount = nearEnd ? endCount + 1 : 0;
    if (!previous) {
      matchedPoint = wasAmbiguous ? candidate.point : null;
      state = {
        ...state,
        status: wasAmbiguous ? "uncertain" : "acquiring",
        reason: wasAmbiguous
          ? "ambiguous-route-position"
          : "confirming-position",
        locationTimestamp: location.timestamp,
      };
      return snapshot();
    }
    if (
      !pauseOnReverse ||
      !matchedPoint ||
      previous.leg !== candidate.leg ||
      candidate.distance >= previous.distance - 0.5
    )
      matchedPoint = candidate.point;
    const confirmedDistance = Math.min(previous.distance, candidate.distance);
    const resumeBehind = pauseOnReverse && recoveringFromReverse;
    const advancing =
      confirmedDistance > state.distance + progressDeadband + EPSILON ||
      (nearEnd && endCount >= 2);
    state = {
      ...state,
      status: "tracking",
      reason: null,
      distance: resumeBehind
        ? Math.abs(confirmedDistance - state.distance) >
          progressDeadband + EPSILON
          ? confirmedDistance
          : state.distance
        : advancing
          ? Math.max(state.distance, confirmedDistance)
          : state.distance,
      locationTimestamp: location.timestamp,
      atEnd: resumeBehind ? false : state.atEnd,
    };
    recoveringFromReverse = false;
    const upcoming = guide.anchors.find(
      (anchor) =>
        anchor.sectionIndex === state.sectionIndex &&
        (resumeBehind || anchor.stepIndex >= state.stepIndex) &&
        !["start", "walk"].includes(route.steps[anchor.stepIndex]?.kind) &&
        anchor.distance + 1.5 >= state.distance,
    );
    if (upcoming) state.stepIndex = upcoming.stepIndex;
    if (
      endCount >= 2 &&
      state.distance >= section.length - endTolerance - EPSILON
    ) {
      state.atEnd = true;
      if (state.sectionIndex < guide.sections.length - 1) {
        state.status = "floor-change";
        state.reason = "confirm-floor-transition";
      } else {
        state.status = "arrived";
        state.arrived = true;
        state.reason = null;
        state.distance = section.length;
        const arrival = guide.anchors.find(
          (anchor) => route.steps[anchor.stepIndex]?.kind === "arrive",
        );
        if (arrival) state.stepIndex = arrival.stepIndex;
      }
    }
    return snapshot();
  }

  return { update, seekStep, snapshot };
}
