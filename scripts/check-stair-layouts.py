#!/usr/bin/env python3
"""Check photo stair placement independently of the Three.js renderer."""
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public/data"


def finite_point(point):
    return len(point) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in point)


def main():
    manifest = json.loads((DATA / "manifest.json").read_text())
    floors = {
        floor["id"]: json.loads((ROOT / "public" / floor["url"].lstrip("/")).read_text())
        for campus in manifest["campuses"] for floor in campus["floors"]
    }
    registry = json.loads((DATA / "stair-layouts.json").read_text())
    rows = []
    unacknowledged = []
    seen = set()
    for layout in registry["layouts"]:
        label = layout["id"]
        assert label not in seen, f"Duplicate stair layout: {label}"
        seen.add(label)
        floor = floors[layout["floorId"]]
        by_id = {polygon["id"]: polygon for polygon in floor["polygons"]}
        source_polygons = [by_id[key] for key in layout["sourcePolygonIds"]]
        assert source_polygons, f"No source polygon: {label}"
        container = unary_union([Polygon(p["points"], p.get("holes", [])) for p in source_polygons])
        frame = layout["frame"]
        origin, u, v, size = [frame[key] for key in ["origin", "axisU", "axisV", "size"]]
        assert all(finite_point(p) for p in [origin, u, v, size]), f"Invalid frame: {label}"
        assert all(x > 0 for x in size), f"Empty frame: {label}"
        assert abs(math.hypot(*u) - 1) < 1e-4 and abs(math.hypot(*v) - 1) < 1e-4, label
        assert abs(sum(a * b for a, b in zip(u, v))) < 1e-4, f"Nonorthogonal frame: {label}"

        def world(point):
            assert finite_point(point), f"Invalid normalized point: {label}"
            return [origin[i] + u[i] * point[0] * size[0] + v[i] * point[1] * size[1] for i in range(2)]

        pieces = []
        details = []
        for index, flight in enumerate(layout["flights"]):
            along_u = abs(flight["to"][0] - flight["from"][0]) > abs(flight["to"][1] - flight["from"][1])
            width = flight.get("width", flight.get("widthFraction", 0) * size[1 if along_u else 0])
            assert math.isfinite(width) and width > 0, f"Invalid flight width: {label}"
            line = LineString([world(flight["from"]), world(flight["to"])])
            assert line.length > 1e-6, f"Zero-length flight: {label}"
            pieces.append(line.buffer(width / 2, cap_style=2))
            details.append({"kind": "flight", "index": index})
        for index, landing in enumerate(layout["landings"]):
            polygon = Polygon([world(point) for point in landing["points"]])
            assert polygon.is_valid and polygon.area > 1e-6, f"Invalid landing: {label}"
            pieces.append(polygon)
            details.append({"kind": "landing", "index": index})
        assert pieces, f"No stair geometry: {label}"
        geometry = unary_union(pieces)
        outside = geometry.difference(container)
        for detail, piece in zip(details, pieces):
            detail.update(area=round(piece.area, 4), outsideArea=round(piece.difference(container).area, 4))
        exception = layout.get("nativeCoverageException")
        documented = bool(exception and exception.get("reason") and
                          exception.get("status") == "documented-photo-native-discrepancy" and
                          set(exception.get("sourcePhotoIds", [])) <= set(layout["sourcePhotoIds"]) and
                          exception.get("sourcePhotoIds"))
        # Tiny corners of concave source cells are not field measurements. Large
        # departures need explicit photo evidence rather than silent reshaping.
        significant = outside.area > .5 or outside.area / geometry.area > .01
        if significant and not documented:
            unacknowledged.append(label)
        rows.append({
            "id": label, "sourcePolygonIds": layout["sourcePolygonIds"],
            "renderedArea": round(geometry.area, 4), "outsideArea": round(outside.area, 4),
            "outsideFraction": round(outside.area / geometry.area, 4),
            "outsideBounds": list(outside.bounds) if not outside.is_empty else None,
            "status": "documented-photo-native-discrepancy" if significant and documented
                      else "unacknowledged-departure" if significant else "within-qa-tolerance",
            "nativeCoverageException": exception, "pieces": details,
        })
    report = {
        "layoutCount": len(rows), "status": "pass" if not unacknowledged else "fail",
        "method": "World-space flight rectangles and landing polygons against union of native sourcePolygonIds; rail thickness excluded.",
        "significantDeparture": "outside area >0.5 source square units OR >1% of rendered stair area",
        "note": "Placement check only: does not establish physical dimensions or architectural correctness.",
        "documentedDiscrepancyCount": sum(r["status"] == "documented-photo-native-discrepancy" for r in rows),
        "unacknowledged": unacknowledged, "layouts": rows,
    }
    destination = ROOT / "analysis/stair-coverage-qa.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Stair coverage: {len(rows)} layouts; {report['documentedDiscrepancyCount']} documented photo/native differences; {len(unacknowledged)} unexplained departures.")
    assert not unacknowledged, "Unexplained stair placement departures: " + ", ".join(unacknowledged)


if __name__ == "__main__":
    main()
