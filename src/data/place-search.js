export const PLACE_CATEGORIES = [
  {
    id: "cafeteria",
    label: "Еда",
    terms: "столовая столовые кафе еда буфет буфеты поесть",
  },
  { id: "toilet", label: "Туалеты", terms: "туалет туалеты санузел уборная" },
  { id: "cloakroom", label: "Гардероб", terms: "гардероб гардеробы одежда" },
  { id: "medical", label: "Медпункт", terms: "медпункт врач помощь" },
  { id: "entrance", label: "Входы", terms: "вход выход" },
];

export const normalizePlaceQuery = (value) =>
  String(value || "")
    .toLocaleLowerCase("ru")
    .replace(/[\s−–—._-]/g, "")
    .replace(
      /[abceghkmoptxy]/g,
      (letter) =>
        ({
          a: "а",
          b: "в",
          c: "с",
          e: "е",
          g: "г",
          h: "н",
          k: "к",
          m: "м",
          o: "о",
          p: "р",
          t: "т",
          x: "х",
          y: "у",
        })[letter],
    );

const foodBrand = (value) =>
  /(?:unifood|унифуд|юнифуд)/iu.test(String(value || ""));
const nearbyWords = new Set([
  "рядом",
  "поблизости",
  "ближайший",
  "ближайшая",
  "ближайшее",
  "ближайшие",
  "где",
  "найти",
  "найди",
  "покажи",
  "мне",
  "к",
  "ко",
  "со",
  "мной",
  "сейчас",
]);

/** A named food kiosk may be a point or a room in the source. Its existing
 * record is grouped with food; this never invents a kiosk or changes the map. */
export function placeCategory(room) {
  return room?.kind === "cafeteria" || foodBrand(room?.label)
    ? "cafeteria"
    : room?.kind;
}

export function categoryForPlaceQuery(query) {
  if (foodBrand(query)) return "cafeteria";
  const words = String(query || "")
    .toLocaleLowerCase("ru")
    .split(/[\s!?.,:;]+/u)
    .filter((word) => word && !nearbyWords.has(word));
  if (words.length !== 1) return null;
  const q = normalizePlaceQuery(words[0]);
  if (!q) return null;
  return (
    PLACE_CATEGORIES.find((item) =>
      item.terms.split(" ").some((term) => {
        const normalized = normalizePlaceQuery(term);
        return normalized === q || (q.length >= 3 && normalized.startsWith(q));
      }),
    )?.id || null
  );
}

export function findPlaces(
  records,
  { query = "", category = null, floorId } = {},
) {
  const q = normalizePlaceQuery(query);
  const queryCategory = categoryForPlaceQuery(query);
  return records
    .filter((room) => {
      const kind = placeCategory(room);
      if (category && kind !== category) return false;
      if (!q) return Boolean(category);
      // Brand searches must not relabel every cafeteria as Unifood.
      if (foodBrand(query)) return foodBrand(room.label);
      if (queryCategory) return kind === queryCategory;
      const terms = PLACE_CATEGORIES.find((item) => item.id === kind)?.terms;
      return (
        normalizePlaceQuery(room.label).includes(q) ||
        terms?.split(" ").some((term) => normalizePlaceQuery(term).includes(q))
      );
    })
    .sort(
      (a, b) =>
        (normalizePlaceQuery(b.label) === q) -
          (normalizePlaceQuery(a.label) === q) ||
        (b.floorId === floorId) - (a.floorId === floorId) ||
        String(a.label).localeCompare(String(b.label), "ru", { numeric: true }),
    );
}
