import { presentPlaceIdentity } from "../../src/data/place-location.js";
import { withLibraryPassageFloor } from "../../src/data/library-passage.js";
import { getHallAdjacencyView } from "../../src/map/hall-adjacency.js";
import { outdoorPassageFloorView } from "../../src/map/outdoor-passage.js";
import {
  getMapStairMarkers,
  presentStairIdentity,
  withConfirmedStairSearch,
} from "../../src/map/stairs.js";

// Enumerate the objects actually offered by the endpoint picker and room
// cards. Labels, grouped graph anchors, polygons and landmark aliases can
// all refer to one selectable endpoint. Preserve the worker's full payload
// for stairs (the label or ID alone does not locate every source portal).
export function auditRouteEndpoints(graph, searchIndex, floors) {
  const campusFloors = floors.filter(
    (floor) => floor.campusId === graph.campusId,
  );
  const search = withConfirmedStairSearch(
    searchIndex
      .filter((p) => p.campusId === graph.campusId)
      .map((p) => presentPlaceIdentity(presentStairIdentity(p))),
    campusFloors,
  );
  const byId = new Map();
  const indexById = new Map(search.map((place) => [place.id, place]));
  const add = (place, source) => {
    const key = place.roomId || place.id;
    if (!key) throw Error("Selectable map object without an endpoint id");
    const found = byId.get(key);
    if (found) {
      if (!found.auditSources.includes(source)) found.auditSources.push(source);
      return;
    }
    byId.set(key, { ...place, id: key, auditSources: [source] });
  };
  for (const place of search) if (place.label) add(place, "search");
  for (const floor of campusFloors) {
    const view = outdoorPassageFloorView(
      withLibraryPassageFloor(getHallAdjacencyView(floor)),
    );
    for (const [objects, source] of [
      [view.polygons, "polygon"],
      [getMapStairMarkers(floor), "marker"],
    ]) {
      for (const object of objects) {
        const place = presentPlaceIdentity(
          presentStairIdentity(object, floor),
          floor,
        );
        if (place.routingStatus === "display-only-no-source-transition")
          continue;
        const indexed = indexById.get(place.roomId) || indexById.get(place.id);
        add(
          indexed || { ...place, campusId: graph.campusId, floorId: floor.id },
          source,
        );
      }
    }
  }
  return [...byId.values()];
}
