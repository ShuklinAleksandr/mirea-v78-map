import { loadRouting } from "./routing.js";
import { rankNearbyPlaces } from "./nearby-places.js";

self.onmessage = async ({ data }) => {
  try {
    const graph = await loadRouting(data.position.campusId);
    self.postMessage({
      id: data.id,
      result: rankNearbyPlaces(data.records, {
        position: data.position,
        manifest: data.manifest,
        graph,
      }),
    });
  } catch {
    self.postMessage({ id: data.id, error: true });
  }
};
