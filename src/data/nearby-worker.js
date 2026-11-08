import { loadRouting } from "./routing.js";
import { rankNearbyPlaces } from "./nearby-places.js";
import { getJSON } from "./client.js";

self.onmessage = async ({ data }) => {
  try {
    const graph = await loadRouting(data.position.campusId);
    const sourceFloor =
      data.interfaceMode === "next" &&
      (data.position.source !== "manual" ||
        !graph.rooms?.[data.position.placeId]) &&
      graph.floors?.[data.position.floorId]
        ? await getJSON(
            `/data/campuses/${graph.campusId}/${data.position.floorId}.json`,
          )
        : null;
    self.postMessage({
      id: data.id,
      result: rankNearbyPlaces(data.records, {
        position: data.position,
        manifest: data.manifest,
        graph,
        sourceFloor,
        interfaceMode: data.interfaceMode,
      }),
    });
  } catch {
    self.postMessage({ id: data.id, error: true });
  }
};
