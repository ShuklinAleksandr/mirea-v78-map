/** Rendering-only treatment of the current floor; never touches walls or routes. */
export function styleNavigationWalls(objects, active) {
  for (const object of objects || []) {
    for (const material of [].concat(object.material || [])) {
      material.userData ??= {};
      const original = (material.userData.navigationOriginal ??= {
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
      });
      const transparent = active || original.transparent;
      if (material.transparent !== transparent) material.needsUpdate = true;
      material.transparent = transparent;
      material.opacity = active
        ? object.isLineSegments
          ? 0.35
          : 0.24
        : original.opacity;
      material.depthWrite = active ? false : original.depthWrite;
    }
  }
}

/** Compass-derived camera lead, not a replacement user coordinate or route. */
export function navigationLookAhead({
  enabled,
  bearing,
  headingTimestamp,
  now,
  maxAge,
  distance = 4,
}) {
  if (
    !enabled ||
    !Number.isFinite(bearing) ||
    !Number.isFinite(headingTimestamp) ||
    now - headingTimestamp < 0 ||
    now - headingTimestamp > maxAge
  )
    return [0, 0];
  const lead = Math.max(0, Math.min(5, distance));
  return [-Math.sin(bearing) * lead, -Math.cos(bearing) * lead];
}
