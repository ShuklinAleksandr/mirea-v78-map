#!/usr/bin/env python3
"""Export the original Pulse navigation graph, with conservative geometry QA.

Every original node and edge survives the export. Rejected edges are retained
with eligible=false, never silently repaired or replaced with nearest neighbours.
Run with the existing scripts/requirements-data.txt environment.
"""
from collections import Counter, defaultdict
from hashlib import sha256
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
TOLERANCE = 0.003  # rounding of source-plan coordinates, not a doorway width


def read(path):
    return json.loads(path.read_text())


def area_id(node_id):
    campus, layer, area, *_ = node_id.split(":")
    return f"{campus}--{layer}--{area}"


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def build(campus):
    cid = campus["id"]
    original_path = ROOT / f"source/maps/original/pulse/campus_{cid}.json"
    original = read(original_path)
    floors = {
        meta["id"]: read(ROOT / f'public/data/campuses/{cid}/{meta["id"]}.json')
        for meta in campus["floors"]
    }
    areas = defaultdict(list)
    area_metadata = {}
    for floor in floors.values():
        for polygon in floor["polygons"]:
            aid = polygon.get("roomId") or polygon["id"]
            geom = Polygon(polygon["points"], polygon.get("holes", []))
            if not geom.is_valid:
                geom = geom.buffer(0)
            areas[aid].append(geom)
            area_metadata[aid] = polygon
    areas = {aid: unary_union(parts).buffer(TOLERANCE) for aid, parts in areas.items()}
    stair_buildings = defaultdict(set)
    for layout in read(ROOT / "public/data/stair-layouts.json")["layouts"]:
        if layout["campusId"] == cid:
            for aid in layout["sourcePolygonIds"]:
                stair_buildings[aid].add(layout["building"])
    door_lines = {
        fid: [LineString([d["a"], d["b"]]) for d in floor["doors"]]
        for fid, floor in floors.items()
    }
    door_trees = {fid: STRtree(lines) for fid, lines in door_lines.items()}
    # source_room_id is the native graph area key; exported catalogue IDs can
    # differ (notably V-78 upper floors). Unnamed SVG areas have no native ID,
    # so recover association only when one polygon contains every graph node.
    named_area_ids = {
        f'{cid}--{room["source_layer_id"]}--{room["source_room_id"]}': room["id"]
        for room in original["rooms"]
        if room.get("source_layer_id") and room.get("source_room_id")
    }
    raw_positions = {}
    groups = defaultdict(list)
    for node in original["graph"]["nodes"]:
        floor = floors[node["floor_id"]]
        scale = floor["sourceScale"]
        raw_positions[node["id"]] = [
            round((value - origin) * scale["displayUnitsPerSvgUnit"], 5)
            for value, origin in zip((node["x"], node["y"]), scale["originSvg"])
        ]
        if not all(math.isfinite(value) for value in raw_positions[node["id"]]):
            raise ValueError(f'Non-finite source coordinates: {node["id"]}')
        groups[(node["floor_id"], area_id(node["id"]))].append(node)
    mappings = {}
    mapping_stats = Counter()
    for (fid, native_id), group in groups.items():
        if native_id in named_area_ids:
            mappings[native_id] = named_area_ids[native_id]
            mapping_stats["source-room-id"] += 1
            continue
        candidates = []
        for polygon in floors[fid]["polygons"]:
            aid = polygon.get("roomId") or polygon["id"]
            if aid in candidates:
                continue
            if all(areas[aid].covers(Point(raw_positions[node["id"]])) for node in group):
                candidates.append(aid)
        if len(candidates) == 1:
            mappings[native_id] = candidates[0]
            mapping_stats["unique-geometric-containment"] += 1
        else:
            mapping_stats["ambiguous-or-missing"] += 1
    nodes = []
    source_rooms = {room["id"]: room for room in original["rooms"]}
    for node in original["graph"]["nodes"]:
        floor = floors[node["floor_id"]]
        x, z = raw_positions[node["id"]]
        aid = mappings.get(area_id(node["id"]), area_id(node["id"]))
        polygon = area_metadata.get(aid, {})
        building = polygon.get("building")
        if not building and len(stair_buildings[aid]) == 1:
            building = next(iter(stair_buildings[aid]))
        nodes.append({
            "id": node["id"],
            "floorId": floor["id"],
            "position": [x, z],
            "areaId": aid,
            "roomId": node.get("room_id"),
            "kind": node.get("kind", "waypoint"),
            "building": building,
            "physicalLevel": floor["buildingLevels"].get(building),
            "sourceLevel": floor["level"],
        })
    by_id = {node["id"]: node for node in nodes}
    edges = []
    reasons = Counter()
    for edge in original["graph"]["edges"]:
        a = by_id[edge["from_node_id"]]
        b = by_id[edge["to_node_id"]]
        line = LineString([a["position"], b["position"]])
        kind = edge["kind"]
        reason = None
        if kind == "corridor":
            if a["areaId"] != b["areaId"] or a["floorId"] != b["floorId"]:
                reason = "corridor-crosses-source-area"
            elif a["areaId"] not in areas:
                reason = "missing-area-geometry"
            elif not areas[a["areaId"]].covers(line):
                reason = "outside-source-area"
        elif kind == "door":
            if a["floorId"] != b["floorId"]:
                reason = "door-between-floors"
            elif not edge.get("source_id"):
                reason = "missing-source-door"
            elif a["areaId"] not in areas or b["areaId"] not in areas:
                reason = "missing-door-area"
            elif not areas[a["areaId"]].covers(Point(a["position"])) or not areas[b["areaId"]].covers(Point(b["position"])):
                reason = "door-endpoint-outside-area"
            else:
                # Opening must meet the actual source door segment. The only
                # permitted gap is the narrow strip occupied by that doorway.
                candidates = door_trees[a["floorId"]].query(line.buffer(0.03))
                valid = False
                for index in candidates:
                    opening = door_lines[a["floorId"]][int(index)]
                    if opening.distance(line) > 0.03:
                        continue
                    passage = unary_union([
                        areas[a["areaId"]], areas[b["areaId"]],
                        opening.buffer(0.03, cap_style="square"),
                    ])
                    if passage.covers(line):
                        valid = True
                        break
                if not valid:
                    reason = "door-opening-not-matched"
        elif kind in ("stairs", "elevator", "lift"):
            # Vertical line shape is unknown. Only the original portal relation
            # is retained; no geometry is invented between source floors.
            if not edge.get("source_id"):
                reason = "invalid-source-transition"
            elif any(n["areaId"] not in areas or not areas[n["areaId"]].covers(Point(n["position"])) for n in (a, b)):
                reason = "transition-outside-area"
        else:
            reason = "unsupported-edge-kind"
        # A source traversal cost is a routing penalty, never metres or seconds.
        distance = edge.get("distance_meters")
        cost = distance if distance is not None else edge.get("traversal_cost")
        if cost is None or not math.isfinite(cost) or cost < 0:
            reason = reason or "invalid-source-cost"
            cost = None
        if reason:
            reasons[reason] += 1
        edges.append({
            "id": edge["id"], "from": a["id"], "to": b["id"],
            "kind": kind, "bidirectional": edge.get("bidirectional", False),
            "distanceMeters": distance,
            "cost": cost,
            "sourceId": edge.get("source_id"),
            "eligible": reason is None,
            **({"rejectionReason": reason} if reason else {}),
        })
    rooms = {}
    neighbours = defaultdict(set)
    for edge in edges:
        if edge["eligible"]:
            neighbours[edge["from"]].add(edge["to"])
            neighbours[edge["to"]].add(edge["from"])
    for node in nodes:
        if not node["roomId"]:
            continue
        source = source_rooms[node["roomId"]]
        rooms[node["roomId"]] = {
            "nodeId": node["id"], "label": source["label"],
            "kind": source["kind"], "floorId": node["floorId"],
            "building": node["building"], "physicalLevel": node["physicalLevel"],
            "connected": bool(neighbours[node["id"]]),
        }
    # Named rooms are destinations, not corridor shortcuts. The runtime allows
    # traversing the chosen source/destination rooms only.
    stats = {
        "sourceNodes": len(nodes), "sourceEdges": len(edges),
        "eligibleEdges": sum(e["eligible"] for e in edges),
        "rejectedEdges": dict(reasons),
        "roomAnchors": len(rooms),
        "sourceImportStats": original.get("graph_import_stats", {}),
        "areaMappings": dict(mapping_stats),
    }
    result = {
        "schemaVersion": 1, "campusId": cid, "units": campus["units"],
        "status": "source-graph" if nodes else "unavailable",
        "source": {
            "file": str(original_path.relative_to(ROOT)),
            "sha256": sha256(original_path.read_bytes()).hexdigest(),
            "url": original.get("source_url"),
            "physicallySurveyed": False,
            "geometrySha256": {
                fid: sha256((ROOT / f"public/data/campuses/{cid}/{fid}.json").read_bytes()).hexdigest()
                for fid in floors
            },
            "stairLayoutsSha256": sha256((ROOT / "public/data/stair-layouts.json").read_bytes()).hexdigest(),
        },
        "validation": {
            "coordinateTolerance": TOLERANCE,
            "doorMatchingTolerance": 0.03,
            "policy": "Original edges only; corridors contained in their source area; doors matched to a source opening; original vertical portals.",
            "accessibility": "unknown",
            "liveRestrictions": "unknown",
        },
        "floors": {fid: {"level": f["level"], "buildingLevels": f["buildingLevels"]} for fid, f in floors.items()},
        "nodes": nodes, "edges": edges, "rooms": rooms, "stats": stats,
    }
    write(ROOT / f"public/data/routing/{cid}.json", result)
    return stats


if __name__ == "__main__":
    manifest = read(ROOT / "public/data/manifest.json")
    report = {campus["id"]: build(campus) for campus in manifest["campuses"]}
    write(ROOT / "analysis/routing-qa.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
