import * as THREE from "three";

/** Architectural hatching over existing plan openings, with no floor surface. */
export function createStairOpeningPlan(cutouts) {
  const vertices = [];
  const height = 0.14;
  const spacing = 1.1;
  const line = (a, b) => vertices.push(a[0], height, a[1], b[0], height, b[1]);
  for (const { points } of cutouts) {
    const diagonals = points.map(([x, z]) => x + z);
    const min = Math.min(...diagonals);
    const max = Math.max(...diagonals);
    points.forEach((p, i) => line(p, points[(i + 1) % points.length]));
    for (
      let d = Math.floor(min / spacing) * spacing + spacing;
      d < max;
      d += spacing
    ) {
      const intersections = [];
      for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const a = diagonals[i],
          b = diagonals[j];
        // Count a vertex only once when a hatch line passes directly through it.
        if (a <= d === b <= d) continue;
        const x = THREE.MathUtils.lerp(
          points[i][0],
          points[j][0],
          (d - a) / (b - a),
        );
        intersections.push(x);
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const a = intersections[i],
          b = intersections[i + 1];
        if (b - a > 1e-4) line([a, d - a], [b, d - b]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  const material = new THREE.LineBasicMaterial({
    color: 0x8296aa,
    transparent: true,
    opacity: 0.7,
  });
  material.userData.darkColor = 0x8ba2be;
  const object = new THREE.LineSegments(geometry, material);
  object.name = "Stair openings · plan hatching";
  return object;
}
