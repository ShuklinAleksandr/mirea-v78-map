import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function shape(p) {
  const s = new THREE.Shape(p.points.map(([x, y]) => new THREE.Vector2(x, -y)));
  for (const h of p.holes || [])
    s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, -y))));
  return s;
}
function solid(p, height, base = 0) {
  const g = new THREE.ExtrudeGeometry(shape(p), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 2,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, base, 0);
  return g;
}
// ExtrudeGeometry includes both caps. The exterior roof owns the top surface,
// so keep only wall triangles instead of placing a second cap 2.5 cm above it.
function wallGeometry(p) {
  const source = solid(p, p.height, p.base || 0),
    g = new THREE.BufferGeometry();
  const wallGroups = source.groups.filter((group) => group.materialIndex === 1);
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = new Float32Array(
      wallGroups.reduce(
        (sum, group) => sum + group.count * attribute.itemSize,
        0,
      ),
    );
    let offset = 0;
    for (const group of wallGroups) {
      const part = attribute.array.subarray(
        group.start * attribute.itemSize,
        (group.start + group.count) * attribute.itemSize,
      );
      values.set(part, offset);
      offset += part.length;
    }
    g.setAttribute(
      name,
      new THREE.Float32BufferAttribute(values, attribute.itemSize),
    );
  }
  source.dispose();
  return g;
}
function inPolygon(point, p) {
  return (
    pointInRing(point, p.points) &&
    !(p.holes || []).some((h) => pointInRing(point, h))
  );
}
function outwardNormal(ring, isHole, dx, dz, len) {
  const area = ring.reduce((s, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0);
  const sign = (area > 0 ? 1 : -1) * (isHole ? -1 : 1);
  return [(sign * dz) / len, (-sign * dx) / len];
}
function roofBoundarySegments(shells) {
  const regions = shells.map((p) => ({
    p,
    top: (p.base || 0) + p.height,
    bounds: [
      Math.min(...p.points.map((q) => q[0])),
      Math.min(...p.points.map((q) => q[1])),
      Math.max(...p.points.map((q) => q[0])),
      Math.max(...p.points.map((q) => q[1])),
    ],
  }));
  const segments = [],
    seen = new Set();
  for (const region of regions) {
    const { p, top } = region;
    for (const ring of [p.points, ...(p.holes || [])])
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length],
          dx = b[0] - a[0],
          dz = b[1] - a[1],
          len = Math.hypot(dx, dz);
        if (len < 2) continue;
        const bounds = [
          Math.min(a[0], b[0]) - 0.06,
          Math.min(a[1], b[1]) - 0.06,
          Math.max(a[0], b[0]) + 0.06,
          Math.max(a[1], b[1]) + 0.06,
        ];
        const neighbors = regions.filter(
          (q) =>
            q.top >= top - 0.001 &&
            q.bounds[0] <= bounds[2] &&
            q.bounds[2] >= bounds[0] &&
            q.bounds[1] <= bounds[3] &&
            q.bounds[3] >= bounds[1],
        );
        const breaks = [0, 1];
        // Adjacent polygons can split the same line at different vertices.
        for (const q of neighbors)
          for (const other of [q.p.points, ...(q.p.holes || [])])
            for (const v of other) {
              const t = ((v[0] - a[0]) * dx + (v[1] - a[1]) * dz) / (len * len);
              if (
                t > 1e-5 &&
                t < 1 - 1e-5 &&
                Math.abs((v[0] - a[0]) * dz - (v[1] - a[1]) * dx) / len < 0.005
              )
                breaks.push(t);
            }
        breaks.sort((x, y) => x - y);
        for (let j = 1; j < breaks.length; j++) {
          const start = breaks[j - 1],
            end = breaks[j];
          if ((end - start) * len < 0.15) continue;
          const t = (start + end) / 2,
            x = a[0] + dx * t,
            z = a[1] + dz * t,
            nx = (-dz / len) * 0.04,
            nz = (dx / len) * 0.04;
          const covered = (x, z) =>
            neighbors.some((q) => inPolygon([x, z], q.p));
          if (covered(x + nx, z + nz) && covered(x - nx, z - nz)) continue;
          const from = [a[0] + dx * start, a[1] + dz * start],
            to = [a[0] + dx * end, a[1] + dz * end];
          const key =
            [from, to]
              .map((q) => q.map((v) => v.toFixed(3)).join(","))
              .sort()
              .join("|") +
            "|" +
            top;
          if (!seen.has(key)) {
            seen.add(key);
            segments.push({ a: from, b: to, top });
          }
        }
      }
  }
  return segments;
}
const material = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts });
function merged(geos, mat, group, { shadow = true } = {}) {
  if (!geos.length) {
    mat.dispose();
    return null;
  }
  const g = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function roundedHall(feature, photoDetail) {
  const group = new THREE.Group();
  group.name = feature.label;
  const [cx, cz] = feature.center,
    radius = feature.radius;
  const base = feature.base || 0,
    top = base + feature.height;
  const roofBase = feature.roof.base ?? top,
    rise = feature.roof.height;
  const outerRadius = radius + (feature.roof.eaveOverhang || 0);
  const topRadius = feature.roof.topRadius;
  const segments = 96,
    stone = [],
    glass = [],
    roofs = [],
    trim = [];
  const side = (r, bottom, upper) => {
    const geometry = new THREE.CylinderGeometry(
      r,
      r,
      upper - bottom,
      segments,
      1,
      true,
    );
    geometry.translate(cx, (bottom + upper) / 2, cz);
    return geometry;
  };
  if (photoDetail) {
    // These vertical subdivisions and mullions are visual approximations. The
    // glass replaces the wall band instead of overlaying a second close surface.
    const glassBottom = top - 1.15,
      glassTop = top - 0.2;
    stone.push(side(radius, base, glassBottom), side(radius, glassTop, top));
    glass.push(side(radius, glassBottom, glassTop));
    for (let i = 0; i < 64; i++) {
      const angle = (i * Math.PI * 2) / 64;
      const frame = new THREE.BoxGeometry(0.045, glassTop - glassBottom, 0.09);
      frame.rotateY(Math.PI / 2 - angle);
      frame.translate(
        cx + Math.cos(angle) * radius,
        (glassBottom + glassTop) / 2,
        cz + Math.sin(angle) * radius,
      );
      trim.push(frame);
    }
    // Repeated V supports convey the photographed rhythm; their count is not an
    // architectural measurement. All supports share one geometry/material batch.
    for (let i = 0; i < 12; i++)
      for (const direction of [-1, 1]) {
        const angle = (i * Math.PI) / 6;
        const bottom = new THREE.Vector3(
          cx + Math.cos(angle) * (radius + 1.3),
          base + 0.25,
          cz + Math.sin(angle) * (radius + 1.3),
        );
        const upperAngle = angle + (direction * Math.PI) / 12;
        const upper = new THREE.Vector3(
          cx + Math.cos(upperAngle) * (radius + 0.2),
          roofBase - 0.12,
          cz + Math.sin(upperAngle) * (radius + 0.2),
        );
        const delta = upper.clone().sub(bottom);
        const beam = new THREE.CylinderGeometry(0.13, 0.13, delta.length(), 6);
        beam.applyQuaternion(
          new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            delta.normalize(),
          ),
        );
        beam.translate(...bottom.add(upper).multiplyScalar(0.5).toArray());
        trim.push(beam);
      }
  } else stone.push(side(radius, base, top));
  // Open-ended frustum plus a single flat crown: no hidden body cap, bottom cap,
  // or old apex cone exists underneath the new roof.
  const slope = new THREE.CylinderGeometry(
    topRadius,
    outerRadius,
    rise,
    segments,
    1,
    true,
  );
  slope.translate(cx, roofBase + rise / 2, cz);
  const crown = new THREE.CircleGeometry(topRadius, segments);
  crown.rotateX(-Math.PI / 2);
  crown.translate(cx, roofBase + rise, cz);
  roofs.push(slope, crown);
  stone.push(side(outerRadius, roofBase - 0.16, roofBase));
  const pickables = [];
  for (const [role, geometries, mat, shadow] of [
    ["body", stone, material(0xe5e6dc), true],
    ["roof", roofs, material(photoDetail ? 0x7a9097 : 0xb8c6b6), true],
    [
      "glazing",
      glass,
      material(0x668995, { metalness: 0.15, roughness: 0.32 }),
      false,
    ],
    ["supports-and-mullions", trim, material(0xe5e6dc), true],
  ]) {
    const mesh = merged(geometries, mat, group, { shadow });
    if (!mesh) continue;
    mesh.name = `${feature.label} · ${role}`;
    mesh.userData = {
      exteriorFeature: feature.id,
      role,
      approximate: true,
      geometryStatus: feature.geometryStatus,
    };
    pickables.push(mesh);
  }
  return { group, pickables };
}

/** Outer skins are separate from room data. Photo-based repeating features are approximate. */
export function createExterior(
  data,
  { photoDetail = false, style = {}, hall = null, special = null } = {},
) {
  const group = new THREE.Group();
  const shells = [];
  const roofGeos = [];
  const undersideGeos = [];
  const roundedFeatures = (special?.features || []).filter(
    (feature) =>
      feature.type === "rounded-hall" &&
      feature.radius > 0 &&
      feature.roof?.type === "shallow-frustum",
  );
  const replaced = new Set([
    ...(hall?.replaceShellOverrideIds || []),
    ...roundedFeatures.flatMap(
      (feature) => feature.replaceShellOverrideIds || [],
    ),
  ]);
  const shellData = (data.displayShells || data.shells).filter(
    (p) =>
      !replaced.has(p.overrideRoomId || p.overrideSourceId || p.sourceRoomId),
  );
  const facadeBands = data.displayFacadeBands || data.facadeBands;
  const hallFacades = [
    ...(hall?.frontGlazingSegments || []).map((s) => ({
      ...s,
      base: 0,
      top: hall.height,
    })),
    ...(hall?.visibleTopWallSegments || hall?.topWallSegments || []).map(
      (s) => ({ ...s, tolerance: hall?.visibleTopWallSegments ? 0.45 : 4 }),
    ),
  ];
  const customFacade = (x, z, y, dx, dz) =>
    roundedFeatures.some(
      (feature) =>
        y <= (feature.base || 0) + feature.height &&
        Math.hypot(x - feature.center[0], z - feature.center[1]) <
          feature.radius + 0.75,
    ) ||
    hallFacades.some((s) => {
      if (y < s.base - 0.1 || y > s.top + 0.1) return false;
      const sx = s.b[0] - s.a[0],
        sz = s.b[1] - s.a[1],
        length2 = sx * sx + sz * sz;
      if (
        !length2 ||
        Math.abs(dx * sz - dz * sx) / Math.sqrt((dx * dx + dz * dz) * length2) >
          0.1
      )
        return false;
      const t = Math.max(
        0,
        Math.min(1, ((x - s.a[0]) * sx + (z - s.a[1]) * sz) / length2),
      );
      return (
        Math.hypot(x - s.a[0] - t * sx, z - s.a[1] - t * sz) <
        (s.tolerance || 0.45)
      );
    });
  for (const p of shellData) {
    if (p.points.length < 3) continue;
    shells.push(wallGeometry(p));
    const roof = new THREE.ShapeGeometry(shape(p));
    roof.rotateX(-Math.PI / 2);
    roof.translate(0, (p.base || 0) + p.height, 0);
    roofGeos.push(roof);
    if (p.base > 0) {
      const underside = new THREE.ShapeGeometry(shape(p));
      underside.rotateX(-Math.PI / 2);
      underside.translate(0, p.base, 0);
      undersideGeos.push(underside);
    }
  }
  const shellMesh = merged(shells, material(0xe5e4da), group);
  const roof = merged(
    roofGeos,
    material(photoDetail ? 0x84979c : 0xb8c6b6),
    group,
  );
  const underside = merged(
    undersideGeos,
    material(0xc5c8bf, { side: THREE.BackSide }),
    group,
  );
  if (underside) {
    underside.name = "Elevated connections · underside";
    underside.userData.exteriorRole = "underside";
  }
  const windows = [],
    sills = [],
    parapets = [];
  if (photoDetail) {
    for (const band of facadeBands) {
      const low = band.base,
        high = band.top;
      for (const polygon of band.rings) {
        for (const [ringIndex, ring] of [
          polygon.points,
          ...(polygon.holes || []),
        ].entries()) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i],
              b = ring[(i + 1) % ring.length],
              dx = b[0] - a[0],
              dz = b[1] - a[1],
              len = Math.hypot(dx, dz);
            if (len < 1.1) continue;
            const angle = -Math.atan2(dz, dx);
            // Standard window bands are a photo-based approximation, never a source opening.
            const rowY = low + (high - low) * 0.56,
              [nx, nz] = outwardNormal(ring, ringIndex > 0, dx, dz, len);
            if (len > 4) {
              const count = Math.floor(
                  (len - 1.3) / (style.windowPitch || 1.55),
                ),
                step = (len - 1.3) / Math.max(count, 1);
              for (let j = 0; j < count; j++) {
                const t = (0.65 + (j + 0.5) * step) / len;
                if (customFacade(a[0] + dx * t, a[1] + dz * t, rowY, dx, dz))
                  continue;
                const g = new THREE.PlaneGeometry(
                  Math.max(0.5, step - (style.windowGap || 0.12)),
                  Math.min(style.windowHeight || 1.38, (high - low) * 0.42),
                );
                g.rotateY(angle);
                g.translate(
                  a[0] + dx * t + nx * 0.07,
                  rowY,
                  a[1] + dz * t + nz * 0.07,
                );
                windows.push(g);
              }
              if (
                !customFacade(
                  (a[0] + b[0]) / 2,
                  (a[1] + b[1]) / 2,
                  rowY,
                  dx,
                  dz,
                )
              ) {
                const g = new THREE.BoxGeometry(len - 1.1, 0.1, 0.13);
                g.rotateY(angle);
                g.translate(
                  (a[0] + b[0]) / 2 + nx * 0.04,
                  rowY - 0.76,
                  (a[1] + b[1]) / 2 + nz * 0.04,
                );
                sills.push(g);
              }
            }
          }
        }
      }
    }
    for (const { a, b, top } of roofBoundarySegments(shellData)) {
      const dx = b[0] - a[0],
        dz = b[1] - a[1],
        len = Math.hypot(dx, dz),
        height = style.parapetHeight || 0.28;
      const g = new THREE.BoxGeometry(len, height, 0.18);
      g.rotateY(-Math.atan2(dz, dx));
      g.translate((a[0] + b[0]) / 2, top + height / 2, (a[1] + b[1]) / 2);
      parapets.push(g);
    }
  }
  merged(
    windows,
    material(0x668995, {
      metalness: 0.15,
      roughness: 0.32,
      side: THREE.DoubleSide,
    }),
    group,
    { shadow: false },
  );
  merged(sills, material(0xf3f1e7), group, { shadow: false });
  merged(parapets, material(0xcdd3ca), group);
  if (photoDetail) {
    const details = new THREE.Group();
    details.name = "Photo-based architectural details — approximate";
    group.add(details);
    const coneRoofs = [],
      struts = [],
      shedRoofs = [],
      shedGlass = [];
    for (const feature of data.specialFeatures || []) {
      if (replaced.has(feature.roomId)) continue;
      if (feature.roof?.type !== "shallow-cone") continue;
      for (const p of feature.polygons) {
        const xs = p.points.map((q) => q[0]),
          zs = p.points.map((q) => q[1]),
          cx = (Math.min(...xs) + Math.max(...xs)) / 2,
          cz = (Math.min(...zs) + Math.max(...zs)) / 2,
          y = feature.height,
          rise = feature.roof.height;
        const v = [];
        for (let i = 0; i < p.points.length; i++) {
          const a = p.points[i],
            b = p.points[(i + 1) % p.points.length];
          v.push(cx, y + rise, cz, a[0], y + 0.1, a[1], b[0], y + 0.1, b[1]);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
        g.computeVertexNormals();
        coneRoofs.push(g);
        // Visible diagonal struts from photographs; sizes/count are explicitly approximate.
        const rx = (Math.max(...xs) - Math.min(...xs)) / 2,
          rz = (Math.max(...zs) - Math.min(...zs)) / 2;
        for (let j = 0; j < 12; j++) {
          const a = (j * Math.PI) / 6;
          const bottom = new THREE.Vector3(
            cx + Math.cos(a) * (rx + 1.3),
            0.4,
            cz + Math.sin(a) * (rz + 1.3),
          );
          const top = new THREE.Vector3(
            cx + Math.cos(a + 0.19) * rx,
            y,
            cz + Math.sin(a + 0.19) * rz,
          );
          const delta = top.clone().sub(bottom),
            g = new THREE.CylinderGeometry(0.15, 0.15, delta.length(), 6);
          g.applyQuaternion(
            new THREE.Quaternion().setFromUnitVectors(
              new THREE.Vector3(0, 1, 0),
              delta.normalize(),
            ),
          );
          g.translate(...top.clone().add(bottom).multiplyScalar(0.5).toArray());
          struts.push(g);
        }
      }
    }
    for (const f of style.roofFeatures || []) {
      const shell = shellData
        .filter((p) => inPolygon(f.center, p))
        .sort((a, b) => (b.base || 0) + b.height - (a.base || 0) - a.height)[0];
      if (!shell) continue;
      const w = f.width / 2,
        d = f.depth / 2,
        r = f.rise;
      const vertices = [
        [-w, 0, -d],
        [w, 0, -d],
        [w, r, -d],
        [-w, r, -d],
        [-w, 0, d],
        [w, 0, d],
      ];
      const faces = [
        0, 2, 1, 0, 3, 2, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5, 0, 1, 5, 0, 5, 4,
      ];
      const pos = [];
      for (const i of faces) pos.push(...vertices[i]);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      g.rotateY(f.rotation);
      g.translate(
        f.center[0],
        (shell.base || 0) + shell.height + 0.15,
        f.center[1],
      );
      shedRoofs.push(g);
      const glass = new THREE.PlaneGeometry(f.width - 0.25, r - 0.2);
      glass.translate(0, r / 2, -d - 0.035);
      glass.rotateY(f.rotation);
      glass.translate(
        f.center[0],
        (shell.base || 0) + shell.height + 0.15,
        f.center[1],
      );
      shedGlass.push(glass);
    }
    merged(coneRoofs, material(0x7a9097, { side: THREE.DoubleSide }), details);
    merged(struts, material(0xe5e6dc), details);
    merged(shedRoofs, material(0xb9c8c7, { side: THREE.DoubleSide }), details);
    merged(
      shedGlass,
      material(0x71949b, {
        metalness: 0.15,
        roughness: 0.35,
        side: THREE.DoubleSide,
      }),
      details,
      { shadow: false },
    );
  }
  // Delineate the complete outer profile without showing artificial gaps between floors.
  if (shellMesh) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(shellMesh.geometry, 30),
      new THREE.LineBasicMaterial({
        color: 0x748779,
        transparent: true,
        opacity: 0.24,
      }),
    );
    group.add(edges);
  }
  const pickables = [shellMesh, roof, underside].filter(Boolean);
  for (const feature of roundedFeatures) {
    const rounded = roundedHall(feature, photoDetail);
    group.add(rounded.group);
    pickables.push(...rounded.pickables);
  }
  return { group, pickables };
}

/** Render available OSM features as context, kept independent of the measured plan. */
export function createMapContext(data) {
  const group = new THREE.Group();
  group.name = "OSM context — approximate alignment";
  if (!data) return { group, pickables: [] };
  const roadGeoms = [],
    pathGeoms = [],
    grassGeoms = [],
    sportsGeoms = [];
  for (const p of data.roads || []) {
    const target = ["footway", "path", "pedestrian", "steps"].includes(p.kind)
      ? pathGeoms
      : roadGeoms;
    for (let i = 1; i < p.points.length; i++) {
      const a = p.points[i - 1],
        b = p.points[i],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        len = Math.hypot(dx, dz);
      const g = new THREE.BoxGeometry(len, 0.025, p.width || 3);
      g.rotateY(-Math.atan2(dz, dx));
      g.translate((a[0] + b[0]) / 2, -0.16, (a[1] + b[1]) / 2);
      target.push(g);
    }
  }
  for (const p of data.surfaces || []) {
    const g = new THREE.ShapeGeometry(shape(p));
    g.rotateX(-Math.PI / 2);
    g.translate(0, -0.19, 0);
    (p.kind === "sport" ? sportsGeoms : grassGeoms).push(g);
  }
  merged(roadGeoms, material(0xc9d0c8), group, { shadow: false });
  merged(pathGeoms, material(0xe1e3d9), group, { shadow: false });
  merged(grassGeoms, material(0xd7e1c8), group, { shadow: false });
  merged(sportsGeoms, material(0xc7d8bd), group, { shadow: false });
  const pickables = [];
  for (const b of data.buildings || []) {
    const geos = b.polygons.map((p) => solid(p, b.height, b.base || 0));
    const mesh = merged(geos, material(0xd2d2c4), group);
    if (mesh) {
      mesh.userData.external = b;
      pickables.push(mesh);
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 30),
        new THREE.LineBasicMaterial({
          color: 0x999d89,
          transparent: true,
          opacity: 0.35,
        }),
      );
      group.add(line);
    }
  }
  for (const tree of data.trees || []) {
    const p = tree.position || tree.center;
    if (!p) continue;
    const crown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1, 1),
      material(0xc2d0ad),
    );
    crown.position.set(p[0], 3.1, p[1]);
    crown.castShadow = true;
    group.add(crown);
  }
  return { group, pickables };
}
