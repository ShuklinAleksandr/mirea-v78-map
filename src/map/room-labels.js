import { pointInLocationPolygon } from "../location.js";

const squareCorners = [
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

export function roomLabelAnchor(center, polygon, triangles) {
  if (pointInLocationPolygon(center, polygon)) {
    let clearance = Infinity;
    for (const ring of [polygon.points, ...(polygon.holes || [])]) {
      for (let i = 0; i < ring.length; i++) {
        const [x, z] = ring[i];
        const [nextX, nextZ] = ring[(i + 1) % ring.length];
        const dx = nextX - x,
          dz = nextZ - z;
        const length = dx * dx + dz * dz;
        const t = length
          ? Math.max(
              0,
              Math.min(
                1,
                ((center[0] - x) * dx + (center[1] - z) * dz) / length,
              ),
            )
          : 0;
        clearance = Math.min(
          clearance,
          (center[0] - x - t * dx) ** 2 + (center[1] - z - t * dz) ** 2,
        );
      }
    }
    if (clearance > 0.15 ** 2)
      return { point: center, radius: Math.sqrt(clearance) };
  }

  // A source centroid can land outside a concave room or inside a stair cutout.
  // An inscribed circle in a triangle of the rendered floor stays inside it.
  let anchor = null;
  for (let i = 0; i + 2 < triangles.count; i += 3) {
    const ax = triangles.getX(i),
      az = triangles.getZ(i);
    const bx = triangles.getX(i + 1),
      bz = triangles.getZ(i + 1);
    const cx = triangles.getX(i + 2),
      cz = triangles.getZ(i + 2);
    const a = Math.hypot(bx - cx, bz - cz),
      b = Math.hypot(ax - cx, az - cz),
      c = Math.hypot(ax - bx, az - bz);
    const perimeter = a + b + c;
    if (!perimeter) continue;
    const radius =
      Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / perimeter;
    if (radius > (anchor?.radius ?? 0))
      anchor = {
        point: [
          (a * ax + b * bx + c * cx) / perimeter,
          (a * az + b * bz + c * cz) / perimeter,
        ],
        radius,
      };
  }
  return anchor;
}

/** Fit an upright badge inside the projected square inscribed in the room. */
export function roomLabelScale(
  label,
  projected,
  camera,
  width,
  height,
  w,
  h,
  scratch,
) {
  let halfSide = label.roomRadius * 0.65;
  const { x, y, z } = label.position;
  if (camera.isPerspectiveCamera) {
    const inverse = camera.matrixWorldInverse.elements;
    const depth = -(
      inverse[2] * x +
      inverse[6] * y +
      inverse[10] * z +
      inverse[14]
    );
    // Keep every corner in front of the camera, even in a low oblique view.
    halfSide = Math.min(halfSide, depth * 0.35);
  }
  let scale = 1;
  let firstX, firstY, lastX, lastY;
  for (const [dx, dz] of squareCorners) {
    scratch.set(x + dx * halfSide, y, z + dz * halfSide).project(camera);
    const screenX = (scratch.x - projected.x) * width,
      screenY = (scratch.y - projected.y) * height;
    if (firstX === undefined) {
      firstX = screenX;
      firstY = screenY;
    } else {
      scale = Math.min(scale, edgeScale(lastX, lastY, screenX, screenY, w, h));
    }
    lastX = screenX;
    lastY = screenY;
  }
  return Math.min(scale, edgeScale(lastX, lastY, firstX, firstY, w, h));
}

function edgeScale(ax, ay, bx, by, width, height) {
  const dx = bx - ax,
    dy = by - ay;
  const extent = Math.abs(dy) * width + Math.abs(dx) * height;
  return extent ? Math.abs(dx * ay - dy * ax) / extent : 1;
}
