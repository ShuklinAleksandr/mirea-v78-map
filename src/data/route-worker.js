import { loadRouting, findRoute } from "./routing.js";
import { getJSON } from "./client.js";
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
    self.postMessage({
      id: data.id,
      result: findRoute(graph, data.from, data.to, { floors }),
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
