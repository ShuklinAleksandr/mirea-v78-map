import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";

/** Closed stair prism. Explicit side panels avoid Earcut's nearly collinear
 * cap triangles along regularly spaced step corners. Heights ascend locally;
 * callers rotate the solid to the accepted flight direction. */
export function stairFlightSolid({ run, width, lower, upper, count, slab }) {
  const positions = [];
  const ab = new Vector3(),
    ac = new Vector3();
  function triangle(a, b, c, outward) {
    ab.set(...b).sub(new Vector3(...a));
    ac.set(...c).sub(new Vector3(...a));
    const vertices =
      ab.cross(ac).dot(new Vector3(...outward)) < 0 ? [a, c, b] : [a, b, c];
    for (const vertex of vertices) positions.push(...vertex);
  }
  function quad(a, b, c, d, outward) {
    triangle(a, b, c, outward);
    triangle(a, c, d, outward);
  }
  const z0 = -width / 2,
    z1 = width / 2;
  for (let i = 0; i < count; i++) {
    const x0 = (run * i) / count,
      x1 = (run * (i + 1)) / count;
    const before = lower + ((upper - lower) * i) / count;
    const top = lower + ((upper - lower) * (i + 1)) / count;
    const bottom0 = before - slab,
      bottom1 = top - slab;
    quad([x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1], [0, 1, 0]);
    quad(
      [x0, before, z0],
      [x0, top, z0],
      [x0, top, z1],
      [x0, before, z1],
      [-1, 0, 0],
    );
    quad(
      [x0, bottom0, z0],
      [x1, bottom1, z0],
      [x1, bottom1, z1],
      [x0, bottom0, z1],
      [(upper - lower) / run, -1, 0],
    );
    for (const [z, sign] of [
      [z0, -1],
      [z1, 1],
    ]) {
      const a = [x0, bottom0, z],
        b = [x1, bottom1, z],
        c = [x1, top, z],
        d = [x0, top, z],
        e = [x0, before, z];
      triangle(b, c, d, [0, 0, sign]);
      triangle(b, d, e, [0, 0, sign]);
      triangle(b, e, a, [0, 0, sign]);
    }
  }
  quad(
    [0, lower - slab, z0],
    [0, lower, z0],
    [0, lower, z1],
    [0, lower - slab, z1],
    [-1, 0, 0],
  );
  quad(
    [run, upper - slab, z0],
    [run, upper, z0],
    [run, upper, z1],
    [run, upper - slab, z1],
    [1, 0, 0],
  );
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
