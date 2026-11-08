// Keep the former Next namespace so installed apps retain their chosen settings.
// The interface name is now only an internal compatibility detail for callers
// and CSS; old comparison links all open the same application.
const STORAGE_PREFIX = "atlas:next:";
const MIGRATION_KEY = "atlas:single-interface-storage:v1";
const LEGACY_KEYS = [
  "atlas:settings",
  "atlas:favorites",
  "atlas:recent",
  "mirea:last-native-view:v1",
  "mirea:gps-calibration-survey:v1",
];
const MERGED_KEYS = new Set(["atlas:favorites", "atlas:recent"]);

export const resolveInterfaceVariant = () => "next";
export const getInterfaceVariant = () => "next";
export const isNextInterface = () => true;

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function variantStorageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

function stringList(raw) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Import both old profiles once, retaining their original records untouched. */
export function migrateInterfaceStorage(storage = browserStorage()) {
  if (!storage) return false;
  try {
    if (storage.getItem(MIGRATION_KEY) === "1") return true;
    for (const key of LEGACY_KEYS) {
      const legacy = storage.getItem(key);
      if (legacy == null) continue;
      const destination = variantStorageKey(key);
      const current = storage.getItem(destination);
      if (current == null) {
        if (key === "atlas:settings") {
          // This marker belongs to the imported settings, not the other profile.
          // Copy it first so a partial write can still retry the settings copy.
          const qualityKey = "atlas:quality-default-version";
          const qualityVersion = storage.getItem(qualityKey);
          if (
            qualityVersion != null &&
            storage.getItem(variantStorageKey(qualityKey)) == null
          )
            storage.setItem(variantStorageKey(qualityKey), qualityVersion);
        }
        storage.setItem(destination, legacy);
      } else if (MERGED_KEYS.has(key)) {
        const oldList = stringList(legacy);
        const currentList = stringList(current);
        // Do not replace malformed records: retain the raw data for recovery.
        if (!oldList || !currentList) continue;
        const combined = [...new Set([...currentList, ...oldList])];
        const serialized = JSON.stringify(combined);
        if (serialized !== current) storage.setItem(destination, serialized);
      }
    }
    // Only mark a fully successful pass; interrupted/quota-limited writes retry
    // safely. After success, removing a favorite must not reimport it on reload.
    storage.setItem(MIGRATION_KEY, "1");
    return true;
  } catch {
    // Restricted or full browser storage must not prevent opening the map.
    return false;
  }
}

// Experience and the native shell read their keys directly. Migrate before
// either module can restore preferences or the last saved floor/route.
migrateInterfaceStorage();

export function getInterfaceStorage(storage = browserStorage()) {
  if (!storage) return null;
  migrateInterfaceStorage(storage);
  return {
    getItem: (key) => storage.getItem(variantStorageKey(key)),
    setItem: (key, value) => storage.setItem(variantStorageKey(key), value),
    removeItem: (key) => storage.removeItem(variantStorageKey(key)),
  };
}

// Compatibility for old callers; neither function changes browser location.
export function interfaceUrl(value, href) {
  if (value !== "classic" && value !== "next") return null;
  const url = new URL(href);
  url.searchParams.delete("interface");
  return url.href;
}
export function switchInterface() {
  return false;
}
export function initializeInterface() {
  document.documentElement.dataset.interface = "next";
  document.title = "МИРЭА · Вернадского, 78";
}
