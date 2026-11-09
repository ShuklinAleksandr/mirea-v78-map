export function wallSpans(polygons, base, top) {
  return polygons.flatMap((polygon) =>
    [polygon.points, ...(polygon.holes || [])].flatMap((ring) =>
      ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], base, top })),
    ),
  );
}

/** Remove the parts of a vertical wall already owned by a coincident face. */
export function subtractWallSpans(a, b, base, top, owners) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length < 0.0001 || top <= base) return [];
  const tolerance = 0.001;
  const offset = ([x, z]) =>
    Math.abs((x - a[0]) * dz - (z - a[1]) * dx) / length;
  const project = ([x, z]) =>
    ((x - a[0]) * dx + (z - a[1]) * dz) / (length * length);
  let strips = [{ start: 0, end: 1, base, top }];
  for (const owner of owners) {
    if (
      owner.base >= top ||
      owner.top <= base ||
      offset(owner.a) > tolerance ||
      offset(owner.b) > tolerance
    )
      continue;
    const first = project(owner.a),
      second = project(owner.b);
    const from = Math.min(first, second),
      to = Math.max(first, second);
    strips = strips.flatMap((strip) => {
      const start = Math.max(strip.start, from),
        end = Math.min(strip.end, to),
        low = Math.max(strip.base, owner.base),
        high = Math.min(strip.top, owner.top);
      if ((end - start) * length <= tolerance || high - low <= tolerance)
        return [strip];
      return [
        { ...strip, end: start },
        { ...strip, start: end },
        { start, end, base: strip.base, top: low },
        { start, end, base: high, top: strip.top },
      ].filter(
        (piece) =>
          (piece.end - piece.start) * length > tolerance &&
          piece.top - piece.base > tolerance,
      );
    });
    if (!strips.length) break;
  }
  const point = (t) => [a[0] + t * dx, a[1] + t * dz];
  return strips.map((strip) => ({
    a: point(strip.start),
    b: point(strip.end),
    base: strip.base,
    top: strip.top,
  }));
}
