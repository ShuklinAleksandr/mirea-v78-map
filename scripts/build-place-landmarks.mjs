import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildPlaceLandmarks,
  placeBuilding,
} from "../src/data/place-location.js";

const root = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, root));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function derivePlaceLandmarkData() {
  const graphPath = "public/data/routing/v-78.json";
  const catalogPath = "public/data/search-index.json";
  const manifestPath = "public/data/manifest.json";
  const [graphBytes, catalogBytes, manifestBytes] = await Promise.all(
    [graphPath, catalogPath, manifestPath].map(read),
  );
  const graph = JSON.parse(graphBytes);
  const catalog = JSON.parse(catalogBytes);
  const records = (Array.isArray(catalog) ? catalog : catalog.rooms).filter(
    (room) => room.campusId === "v-78",
  );
  const campus = JSON.parse(manifestBytes).campuses.find(
    (item) => item.id === "v-78",
  );
  const floors = await Promise.all(
    campus.floors.map(async (floor) => {
      const path = `public${floor.url}`;
      const bytes = await read(path);
      if (graph.source?.geometrySha256?.[floor.id] !== digest(bytes))
        throw new Error(`Routing geometry is stale for ${floor.id}`);
      if (
        JSON.stringify(graph.floors?.[floor.id]?.buildingLevels) !==
        JSON.stringify(floor.buildingLevels)
      )
        throw new Error(`Routing physical floors are stale for ${floor.id}`);
      return [path, digest(bytes)];
    }),
  );
  const maxDistance = 25;
  const hints = Object.fromEntries(
    [...buildPlaceLandmarks(graph, records, { maxDistance })].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    ),
  );
  const missing = records.filter(
    (room) =>
      ["cafeteria", "toilet", "cloakroom", "medical", "entrance"].includes(
        room.kind,
      ) &&
      !placeBuilding(room, graph.floors[room.floorId]) &&
      !hints[room.id],
  );
  return {
    data: {
      schemaVersion: 1,
      campusId: "v-78",
      provenance: {
        generatedBy: "node scripts/build-place-landmarks.mjs",
        policy:
          "Numbered landmarks within 25 source metres along eligible horizontal graph edges. No vertical edges or traversal of other named destinations; a landmark never assigns its building or floor to the facility.",
        maxDistanceMeters: maxDistance,
        sha256: {
          [graphPath]: digest(graphBytes),
          [catalogPath]: digest(catalogBytes),
          [manifestPath]: digest(manifestBytes),
          ...Object.fromEntries(floors),
        },
      },
      hints,
    },
    missing,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { data, missing } = await derivePlaceLandmarkData();
  await writeFile(
    new URL("src/data/place-landmarks.json", root),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  const rows = missing.map(
    (room) =>
      `| ${room.id} | ${room.label} | [${room.floorId}](../public/data/plans/v-78/${room.floorId}.svg) | ${room.center.join(", ")} |`,
  );
  await writeFile(
    new URL("docs/PLACE_LOCATION_GAPS_2026-10-20.md", root),
    `# Привязки мест В78, требующие обследования\n\n` +
      `Список воспроизводится командой \`node scripts/build-place-landmarks.mjs\`. Исходные планы, каталог и граф не изменяются.\n\n` +
      `У ${missing.length} объектов категорий нет собственного корпуса в подписи и нет короткого допустимого пути к пронумерованному ориентиру в сохранённом графе. Это отсутствие данных для описания, а не доказательство отсутствия реального прохода.\n\n` +
      `Для каждого ID нужны: корпус и физический этаж, ближайшая подписанная аудитория или лестница, фото подписи помещения и участок плана с его дверью и проходом к ориентиру. Координаты ниже — [x, z] исходной модели в метрах, не GPS и не результат обмера. Номер общего уровня плана не является номером физического этажа.\n\n` +
      `| ID объекта | Подпись источника | План | Координаты [x, z] |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n` +
      `Остальные ${Object.keys(data.hints).length} объектов имеют производный ориентир по существующим горизонтальным связям графа. Интерфейс явно называет его ориентиром; его корпус и этаж не переносятся на сам объект. Медпункт «А-109» имеет корпус в собственной подписи. Даже наличие ориентира не подтверждает часы работы, текущую доступность и обследование на местности.\n`,
  );
  console.log(
    `Generated ${Object.keys(data.hints).length} landmarks; ${missing.length} facilities need field confirmation.`,
  );
}
