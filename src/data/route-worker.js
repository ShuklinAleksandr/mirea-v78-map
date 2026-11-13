import { loadRouting } from "./routing.js";
import { findNavigationRoute } from "./entrance-route.js";
import { findIRouteOptions } from "./i-route-options.js";
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
    if (!result.ok && result.code === "no-path") {
      for (const endpoint of [data.to, data.from]) {
        const room = graph.rooms[endpoint?.roomId || endpoint?.id || endpoint];
        if (
          !indexedRoomGroup(room?.label)?.index ||
          !graph.floors?.[room.floorId] ||
          floors.some((floor) => floor.id === room.floorId)
        )
          continue;
        try {
          floors.push(
            await getJSON(
              `/data/campuses/${graph.campusId}/${room.floorId}.json`,
            ),
          );
        } catch {
          // A missing plan cannot establish adjacency. Never replace it
          // with a nearest room number or an invented connector.
        }
      }
      result = findNavigationRoute(graph, data.from, data.to, { floors });
    }
    if (result.ok)
      result = findIRouteOptions(graph, data.from, data.to, { floors });
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
