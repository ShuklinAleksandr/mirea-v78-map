"""Reconstruct cleaner observed stair surfaces, with bounded plane regularization.

Requires original PLY files, NumPy, SciPy and Open3D 0.19. No source colours,
hole filling or route changes. Ordinary app builds use the prepared JSON assets.
An output directory is mandatory; existing output files are not overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

import numpy as np
import open3d as o3d
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("scan_source", ROOT / "scripts/build-stair-scan-surfaces.py")
source_pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_pipeline)


def normal_regularization(points, normals):
    start = points.copy()
    current = points.copy()
    iterations = []
    for iteration in range(2):
        tree = cKDTree(current)
        result = current.copy()
        offsets = []
        for left in range(0, len(points), 20000):
            right = min(len(points), left + 20000)
            p, n = current[left:right], normals[left:right]
            distance, indices = tree.query(p, k=24, workers=2)
            neighbour, neighbour_normals = current[indices], normals[indices]
            angular = np.einsum("ijk,ik->ij", neighbour_normals, n)
            support = (distance < .16) & (angular > np.cos(np.deg2rad(25)))
            weight = np.exp(-.5 * (distance / .075) ** 2) * np.maximum(angular, 0) ** 8 * support
            signed = np.einsum("ijk,ik->ij", neighbour - p[:, None, :], n)
            shift = (weight * signed).sum(1) / np.maximum(weight.sum(1), 1e-10)
            shift = np.clip(shift, -.025, .025)
            shift[support.sum(1) < 5] = 0
            accumulated = np.einsum("ij,ij->i", current[left:right] - start[left:right], n)
            shift = np.clip(accumulated + shift, -.04, .04) - accumulated
            result[left:right] = p + n * shift[:, None]
            offsets.extend(shift.tolist())
        current = result
        iterations.append({"iteration": iteration + 1, "medianNormalMove": float(np.median(np.abs(offsets))), "p95NormalMove": float(np.quantile(np.abs(offsets), .95))})
    return current, iterations


def supported_planes(original, points, normals):
    p, n = points.copy(), normals.copy()
    horizontal = n[:, 2] > .90
    step = .01
    bins = np.arange(np.floor(p[:, 2].min() / step) * step, np.ceil(p[:, 2].max() / step) * step + step, step)
    hist, edges = np.histogram(p[horizontal, 2], bins=bins)
    smoothed = gaussian_filter1d(hist.astype(float), 1.1)
    peaks, _ = find_peaks(smoothed, height=12, prominence=5, distance=11)
    heights = []
    for peak in peaks:
        z = (edges[peak] + edges[peak + 1]) / 2
        band = horizontal & (np.abs(p[:, 2] - z) < .045)
        if band.sum() >= 60:
            heights.append(float(np.median(p[band, 2])))
    heights = np.array(heights)
    difference = np.abs(p[:, 2, None] - heights[None, :])
    nearest = np.argmin(difference, axis=1)
    snap = horizontal & (difference[np.arange(len(p)), nearest] < .04)
    p[snap, 2] = heights[nearest[snap]]
    n[snap] = [0, 0, 1]
    remaining = np.flatnonzero(np.abs(n[:, 2]) < .18)
    assigned = np.zeros(len(p), dtype=bool)
    wall_planes = []
    rng = np.random.default_rng(371)
    o3d.utility.random.seed(371)
    for _ in range(6):
        if len(remaining) < 500:
            break
        sample = remaining if len(remaining) < 15000 else rng.choice(remaining, 15000, replace=False)
        cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(p[sample]))
        model, inliers = cloud.segment_plane(distance_threshold=.025, ransac_n=3, num_iterations=250, probability=.995)
        normal = np.array(model[:3])
        normal[2] = 0
        normal /= np.linalg.norm(normal)
        offset = -float(np.median(p[sample[np.array(inliers)]] @ normal))
        distance = p @ normal + offset
        agree = np.abs(n @ normal) > np.cos(np.deg2rad(20))
        support = (np.abs(distance) < .035) & agree & (np.abs(n[:, 2]) < .18) & ~assigned
        if support.sum() < 250:
            break
        p[support] -= distance[support, None] * normal
        sign = np.sign(n[support] @ normal)
        n[support] = normal[None, :] * sign[:, None]
        assigned |= support
        wall_planes.append({"normal": normal.tolist(), "offset": offset, "observedPoints": int(support.sum())})
        remaining = remaining[~support[remaining]]
    displacement = p - original
    length = np.linalg.norm(displacement, axis=1)
    capped = length > .06
    p[capped] = original[capped] + displacement[capped] * (.06 / length[capped])[:, None]
    final = np.linalg.norm(p - original, axis=1)
    metrics = {"method": "bounded-supported-tread-band-and-vertical-plane-regularization", "horizontalBandHeights": heights.tolist(), "horizontalBandStatus": "observed-treads-and-ledges-not-numbered-floor-labels", "horizontalSnappedPoints": int(snap.sum()), "verticalPlanes": wall_planes, "maxMove": float(final.max()), "medianMove": float(np.median(final)), "p95Move": float(np.quantile(final, .95)), "cappedPoints": int(capped.sum()), "maximumPermittedMove": .06, "normalGateDegrees": 25, "noHoleFilling": True}
    return p, n, metrics


def reconstruct(points, normals):
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points))
    cloud.normals = o3d.utility.Vector3dVector(normals)
    mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(cloud, o3d.utility.DoubleVector([.0825, .1265, .1705]))
    mesh.remove_degenerate_triangles(); mesh.remove_duplicated_triangles(); mesh.remove_duplicated_vertices(); mesh.remove_non_manifold_edges()
    labels, counts, _ = mesh.cluster_connected_triangles()
    labels, counts = np.asarray(labels), np.asarray(counts)
    if len(labels):
        mesh.remove_triangles_by_mask(counts[labels] < 100)
    mesh.remove_unreferenced_vertices()
    pre_simplification_triangles = len(mesh.triangles)
    if len(mesh.triangles) > 24000:
        mesh = mesh.simplify_quadric_decimation(24000, boundary_weight=20)
    mesh.remove_degenerate_triangles(); mesh.remove_duplicated_triangles(); mesh.remove_duplicated_vertices(); mesh.remove_non_manifold_edges()
    vertices = np.asarray(mesh.vertices)
    faces = vertices[np.asarray(mesh.triangles)]
    samples = np.stack([faces.mean(1), (faces[:, 0] + faces[:, 1]) / 2, (faces[:, 1] + faces[:, 2]) / 2, (faces[:, 2] + faces[:, 0]) / 2], axis=1)
    distances, _ = cKDTree(points).query(samples.reshape(-1, 3), workers=2)
    distances = distances.reshape(-1, 4)
    unsupported = (distances[:, 0] > .10) | (distances[:, 1:].max(1) > .125)
    mesh.remove_triangles_by_mask(unsupported)
    labels, counts, areas = mesh.cluster_connected_triangles()
    labels, counts, areas = np.asarray(labels), np.asarray(counts), np.asarray(areas)
    if len(labels):
        mesh.remove_triangles_by_mask((counts[labels] < 15) & (areas[labels] < .3))
    mesh.remove_unreferenced_vertices(); mesh.compute_vertex_normals()
    return mesh, int(unsupported.sum()), pre_simplification_triangles


def build(index, output):
    start = time.time()
    cfg = source_pipeline.CONFIG[index]
    template = json.loads((ROOT / f"src/data/stair-scan-meshes/{cfg['id']}.json").read_text())
    source = ROOT / f"source/lidar/2026-10-26/scan-{index}.ply"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != template["sourceSha256"]:
        raise RuntimeError(f"Original source hash mismatch: {source}")
    source_pipeline.OUT.mkdir(parents=True, exist_ok=True)
    points, normals, count = source_pipeline.get_cloud(index, .055)
    uv = points[:, :2] @ np.array([cfg["axes"]["u"], cfg["axes"]["v"]]).T
    limits = cfg["fitBounds"]
    keep = (points[:, 2] <= cfg["zmax"]) & (normals[:, 2] >= -.70)
    keep &= (uv[:, 0] >= limits["min"][0]) & (uv[:, 0] <= limits["max"][0]) & (uv[:, 1] >= limits["min"][1]) & (uv[:, 1] <= limits["max"][1])
    if index == 2:
        keep &= ~((np.abs(points[:, 2] - 1.425) < .065) & (points[:, 0] > 1.3) & (np.abs(normals[:, 2]) > .85))
    original, normals = points[keep], normals[keep]
    regularized, iterations = normal_regularization(original, normals)
    regularized, normals, metrics = supported_planes(original, regularized, normals)
    mesh, unsupported, pre_simplification_triangles = reconstruct(regularized, normals)
    vertices = np.round(np.asarray(mesh.vertices), 5)
    indices = np.asarray(mesh.triangles)
    if not np.isfinite(vertices).all() or not 0 < len(indices) <= 24000 or indices.min() < 0 or indices.max() >= len(vertices):
        raise RuntimeError("Invalid reconstructed surface buffers")
    faces = vertices[indices]
    if np.any(np.linalg.norm(np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0]), axis=1) <= 1e-10):
        raise RuntimeError("Degenerate triangle after coordinate rounding")
    nearest, _ = cKDTree(original).query(vertices, workers=2)
    metrics.update(normalRegularizationIterations=iterations, retainedSourcePoints=len(original), nearestOriginalPointMax=float(nearest.max()), nearestOriginalPointP95=float(np.quantile(nearest, .95)))
    template.update(positions=vertices.ravel().tolist(), indices=indices.ravel().tolist(), bounds={"min": vertices.min(0).tolist(), "max": vertices.max(0).tolist()}, vertexCount=len(vertices), triangleCount=len(indices), surfaceRegularization=metrics)
    template["reconstruction"].update(method="observed-surface-ball-pivoting-with-bounded-planar-regularization", targetTriangles=24000, decimationBoundaryWeight=20, minimumComponentTriangles=100, postSimplificationMinimumComponentTriangles=15, postSimplificationSmallComponentArea=.3, preSimplificationTriangles=pre_simplification_triangles, faceSupportMaxDistance=.10, edgeSupportMaxDistance=.125, unsupportedFacesRemoved=unsupported, fillHoles=False)
    template["crop"].update(registrationWindowAppliedBeforeMeshing=True, retainedSourcePoints=len(original), notes="Captured upper ceilings removed by explicit Z cut and globally oriented downward surface normals (<-0.70 Z), validated against ceiling/floor bands. Standard-cell neighbouring corridor protrusions cropped at X[-4.3,4.5],Y[-4.5,4.5]. Semantic UV registration window applied before reconstruction. Supported points regularized within 0.06 source units; no absent surface areas completed. Raw PLY unchanged.")
    path = output / f"{cfg['id']}.json"
    path.write_text(json.dumps(template, separators=(",", ":")) + "\n")
    o3d.io.write_triangle_mesh(str(output / f"{cfg['id']}.ply"), mesh, write_vertex_colors=False, write_triangle_uvs=False)
    report = {"id": cfg["id"], "vertices": len(vertices), "triangles": len(indices), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "sourceSha256": source_hash, "sourcePoints": count, "regularization": metrics, "unsupportedFacesRemoved": unsupported, "seconds": time.time() - start}
    (output / f"{cfg['id']}-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--scan", type=int, action="append", choices=[1, 2, 3])
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    for index in args.scan or [1, 2, 3]:
        target = output / f"{source_pipeline.CONFIG[index]['id']}.json"
        if target.exists():
            raise SystemExit(f"Output already exists: {target}")
    for index in args.scan or [1, 2, 3]:
        build(index, output)
