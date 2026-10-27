// Route preview follows only one original horizontal segment at a time.
// A floor/stair boundary is a manual hand-off, never an interpolated shortcut.
const EPSILON = 1e-7;
const isPoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function pointAt(section, requested) {
  const value = clamp(
    Number.isFinite(requested) ? requested : 0,
    0,
    section.length,
  );
  for (let i = 1; i < section.points.length; i++) {
    const length = section.distances[i] - section.distances[i - 1];
    if (length < EPSILON || value > section.distances[i] + EPSILON) continue;
    const a = section.points[i - 1],
      b = section.points[i];
    const t = clamp((value - section.distances[i - 1]) / length, 0, 1);
    return {
      position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      heading: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
    };
  }
  return { position: [...section.points.at(-1)], heading: [1, 0] };
}

function nearestAnchor(section, point) {
  if (!isPoint(point)) return { distance: 0, error: 0 };
  let best = { distance: 0, error: distance(section.points[0], point) };
  for (let i = 1; i < section.points.length; i++) {
    const a = section.points[i - 1],
      b = section.points[i];
    const length = distance(a, b);
    if (length < EPSILON) continue;
    const t = clamp(
      ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) /
        length ** 2,
      0,
      1,
    );
    const projected = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const error = distance(projected, point);
    if (error < best.error)
      best = { distance: section.distances[i - 1] + t * length, error };
  }
  return best;
}

export function createRouteGuidance(route) {
  const sections = [];
  for (const [sourceSegmentIndex, segment] of (
    route?.segments || []
  ).entries()) {
    if (
      !segment.floorId ||
      !Array.isArray(segment.points) ||
      !segment.points.length ||
      !segment.points.every(isPoint)
    )
      continue;
    const points = segment.points
      .filter((point, i, all) => !i || distance(all[i - 1], point) > EPSILON)
      .map((point) => point.slice(0, 2));
    const distances = [0];
    for (let i = 1; i < points.length; i++)
      distances.push(distances.at(-1) + distance(points[i - 1], points[i]));
    const transition = (route.transitions || []).find(
      (item) =>
        item.fromFloorId === segment.floorId &&
        isPoint(item.point) &&
        distance(item.point, points.at(-1)) < 0.001,
    );
    sections.push({
      floorId: segment.floorId,
      sourceSegmentIndex,
      points,
      distances,
      length: distances.at(-1),
      transition: transition || null,
    });
  }
  const anchors = [];
  let cursor = 0;
  for (const [stepIndex, step] of (route?.steps || []).entries()) {
    if (stepIndex && route.steps[stepIndex - 1].targetFloorId)
      cursor = Math.min(cursor + 1, Math.max(0, sections.length - 1));
    let best = null;
    for (let i = cursor; i < sections.length; i++) {
      if (sections[i].floorId !== step.floorId) continue;
      const anchor = nearestAnchor(sections[i], step.position);
      if (!best || anchor.error < best.error - EPSILON)
        best = { ...anchor, sectionIndex: i, stepIndex };
    }
    if (best) {
      cursor = best.sectionIndex;
      anchors.push(best);
    }
  }
  return { sections, anchors };
}

export function sampleRouteGuidance(
  guide,
  sectionIndex,
  requested,
  { lookAhead = 18, lookBehind = 3 } = {},
) {
  const section = guide?.sections?.[sectionIndex];
  if (!section) return null;
  const travelled = clamp(
    Number.isFinite(requested) ? requested : 0,
    0,
    section.length,
  );
  const from = Math.max(0, travelled - Math.max(0, lookBehind));
  const to = Math.min(section.length, travelled + Math.max(1, lookAhead));
  const cameraPoints = [pointAt(section, from).position];
  for (let i = 1; i < section.points.length - 1; i++)
    if (section.distances[i] > from && section.distances[i] < to)
      cameraPoints.push([...section.points[i]]);
  const last = pointAt(section, to).position;
  if (distance(last, cameraPoints.at(-1)) > EPSILON) cameraPoints.push(last);
  const localAnchors = (guide.anchors || []).filter(
    (anchor) =>
      anchor.sectionIndex === sectionIndex &&
      anchor.distance <= travelled + 0.1,
  );
  return {
    floorId: section.floorId,
    sourceSegmentIndex: section.sourceSegmentIndex,
    sectionIndex,
    ...pointAt(section, travelled),
    cameraPoints,
    distance: travelled,
    length: section.length,
    progress: section.length > EPSILON ? travelled / section.length : 1,
    atEnd: travelled >= section.length - EPSILON,
    transition: section.transition,
    stepIndex:
      localAnchors.at(-1)?.stepIndex ??
      guide.anchors.find((anchor) => anchor.sectionIndex === sectionIndex)
        ?.stepIndex ??
      0,
  };
}

export function guidanceAnchorForStep(guide, stepIndex) {
  return (
    guide?.anchors?.find((anchor) => anchor.stepIndex === stepIndex) || null
  );
}
