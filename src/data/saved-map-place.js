import { presentPlaceIdentity } from "./place-location.js";
import { withLibraryPassageFloor } from "./library-passage.js";
import { getHallAdjacencyView } from "../map/hall-adjacency.js";
import { outdoorPassageFloorView } from "../map/outdoor-passage.js";
import { getMapStairMarkers, presentStairIdentity } from "../map/stairs.js";

const views = new WeakMap();
function floorPlaces(floor) {
  if (!views.has(floor)) {
    const view = outdoorPassageFloorView(
      withLibraryPassageFloor(getHallAdjacencyView(floor)),
    );
    const byId = new Map();
    for (const polygon of view.polygons || []) {
      byId.set(polygon.id, polygon);
      if (polygon.roomId && !byId.has(polygon.roomId))
        byId.set(polygon.roomId, polygon);
    }
    for (const marker of getMapStairMarkers(floor)) {
      byId.set(marker.id, marker);
      for (const alias of [
        ...(marker.sourceIds || []),
        ...(marker.graphAnchors || []).map((anchor) => anchor.id),
      ]) {
        if (!byId.has(alias)) byId.set(alias, marker);
      }
    }
    views.set(floor, byId);
  }
  return views.get(floor);
}

// Saved places and shared links may refer to a map card outside the search
// index. A source transition ID can identify landings on more than one floor.
export function resolveSavedMapPlace(id, search, floors, preferredFloor) {
  if (!id) return null;
  const indexed = search.find((p) => p.id === id);
  if (indexed) return indexed;
  for (const floor of [
    preferredFloor,
    ...floors.filter((f) => f !== preferredFloor),
  ]) {
    if (!floor) continue;
    const source = floorPlaces(floor).get(id);
    if (!source) continue;
    const place = presentPlaceIdentity(
      presentStairIdentity(source, floor),
      floor,
    );
    const level = floor.buildingLevels?.[place.building];
    const description = place.building
      ? `корпус ${place.building}${Number.isFinite(level) ? `, этаж ${level}` : ""}`
      : `уровень ${floor.level} плана`;
    return {
      ...place,
      campusId: floor.campusId,
      floorId: floor.id,
      label: place.label || `Точка · ${description}`,
    };
  }
  return null;
}
