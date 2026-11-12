import { loadRouting } from "./routing.js";
import { findNavigationRoute } from "./entrance-route.js";
import { getJSON } from "./client.js";
import { indexedRoomGroup } from "./indexed-room-neighbors.js";
self.onmessage = async ({ data }) => {
  try {
    const graph = await loadRouting(data.from.campusId);
    const ids = [
      ...new Set(
        [data.from, data.to]
          .filter((endpoint) => endpoint?.kind === "user-location")
          .map((endpoint) => endpoint.floorId),
      ),
    ];
    const floors = await Promise.all(
      ids.map((id) => {
        if (!graph.floors?.[id])
          throw new Error("План выбранного этажа отсутствует.");
        return getJSON(`/data/campuses/${graph.campusId}/${id}.json`);
      }),
    );
    let result = findNavigationRoute(graph, data.from, data.to, { floors });
    const target = graph.rooms[data.to?.roomId || data.to?.id || data.to];
    if (
      !result.ok &&
      result.code === "no-path" &&
      indexedRoomGroup(target?.label)?.index &&
      graph.floors?.[target.floorId] &&
      !floors.some((floor) => floor.id === target.floorId)
    ) {
      try {
        floors.push(
          await getJSON(
            `/data/campuses/${graph.campusId}/${target.floorId}.json`,
          ),
        );
        result = findNavigationRoute(graph, data.from, data.to, { floors });
      } catch {
        // A missing plan cannot establish adjacency. Preserve the original
        // honest no-path result instead of guessing a same-number neighbour.
      }
    }
    self.postMessage({
      id: data.id,
      result,
    });
  } catch (error) {
    self.postMessage({
      id: data.id,
      result: {
        ok: false,
        message: `Не удалось загрузить граф проходов. ${error.message}`,
      },
    });
  }
};
