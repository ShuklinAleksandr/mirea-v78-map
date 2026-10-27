import { getJSON } from "./client.js";

const OPTIONAL = [
  ["photos", "/data/photo-index.json", { images: [] }],
  ["exterior", "/data/exterior-shells.json", { campuses: {} }],
  ["context", "/data/exterior-context.json", null],
  ["facadeStyle", "/data/facade-style.json", {}],
  ["hall", "/data/exterior-hall.json", null],
  ["special", "/data/exterior-special.json", null],
];

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const point = (value) =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.slice(0, 2).every(Number.isFinite);
const ring = (value) =>
  Array.isArray(value) && value.length >= 3 && value.every(point);
const polygon = (value) =>
  record(value) &&
  ring(value.points) &&
  (value.holes == null ||
    (Array.isArray(value.holes) && value.holes.every(ring)));

function validOptional(key, value) {
  if (key === "photos")
    return (
      Array.isArray(value) ||
      (record(value) &&
        (Array.isArray(value.photos) || Array.isArray(value.images)))
    );
  if (!record(value)) return false;
  if (key === "exterior")
    return (
      record(value.campuses) &&
      Object.values(value.campuses).every(
        (campus) =>
          record(campus) &&
          Array.isArray(campus.displayShells || campus.shells) &&
          (campus.displayShells || campus.shells).every(
            (shell) =>
              polygon(shell) &&
              Number.isFinite(shell.height) &&
              shell.height > 0 &&
              (shell.base == null || Number.isFinite(shell.base)),
          ) &&
          Array.isArray(campus.displayFacadeBands || campus.facadeBands),
      )
    );
  if (key === "context")
    return (
      typeof value.campusId === "string" &&
      ["roads", "surfaces", "buildings", "trees"].every(
        (name) => value[name] == null || Array.isArray(value[name]),
      )
    );
  if (key === "hall")
    return (
      typeof value.campusId === "string" &&
      polygon(value.lowPolygon) &&
      (value.volumePolygons == null ||
        (Array.isArray(value.volumePolygons) &&
          value.volumePolygons.every(polygon)))
    );
  if (key === "special")
    return typeof value.campusId === "string" && Array.isArray(value.features);
  return value.roofFeatures == null || Array.isArray(value.roofFeatures);
}

function boundedLoad(load, url, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (settle, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      settle(value);
    };
    const cancel = () => finish(reject, new Error("Startup cancelled"));
    const timer = setTimeout(
      () => finish(reject, new Error("Optional asset timed out")),
      timeoutMs,
    );
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(() => load(url))
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

/** Optional imagery and facade details must never disable the indoor map. */
export async function loadBootstrapData(
  load = getJSON,
  { optionalTimeoutMs = 4000 } = {},
) {
  if (!Number.isFinite(optionalTimeoutMs) || optionalTimeoutMs < 0)
    throw new RangeError(
      "optionalTimeoutMs must be a nonnegative finite number",
    );
  const optionalController = new AbortController();
  try {
    const optional = Promise.all(
      OPTIONAL.map(async ([key, url, fallback]) => {
        try {
          const value = await boundedLoad(
            load,
            url,
            optionalTimeoutMs,
            optionalController.signal,
          );
          if (!validOptional(key, value))
            throw new Error("Invalid optional asset");
          return { key, value };
        } catch {
          return { key, value: fallback, unavailable: true };
        }
      }),
    );
    const [sourceManifest, sourceSearch, assumptions] = await Promise.all([
      load("/data/manifest.json"),
      load("/data/search-index.json"),
      load("/data/assumptions.json"),
    ]);
    const campus = sourceManifest.campuses?.find((c) => c.id === "v-78");
    if (!campus?.floors?.length)
      throw new Error("В данных карты отсутствует площадка Вернадского, 78.");
    if (
      !Number.isFinite(assumptions.floorHeight) ||
      assumptions.floorHeight <= 0 ||
      !Number.isFinite(assumptions.wallHeight) ||
      assumptions.wallHeight <= 0
    )
      throw new Error("Параметры модели повреждены. Повторите загрузку карты.");
    const records = Array.isArray(sourceSearch)
      ? sourceSearch
      : sourceSearch.rooms;
    if (!Array.isArray(records))
      throw new Error("Каталог помещений повреждён. Повторите загрузку карты.");
    const floors = new Set(campus.floors.map((floor) => floor.id));
    const extra = await optional;
    return {
      manifest: { ...sourceManifest, campuses: [campus] },
      search: records.filter(
        (room) => room.campusId === campus.id && floors.has(room.floorId),
      ),
      assumptions,
      ...Object.fromEntries(extra.map(({ key, value }) => [key, value])),
      unavailable: extra
        .filter((item) => item.unavailable)
        .map((item) => item.key),
    };
  } finally {
    // Also clears optional deadlines when essential data fails first.
    optionalController.abort();
  }
}
