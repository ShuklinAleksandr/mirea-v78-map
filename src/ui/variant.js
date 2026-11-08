const SELECTION_KEY = "atlas:interface";
export const INTERFACE_NAMES = { classic: "Классика", next: "Новая" };

export function resolveInterfaceVariant(search = "", saved = null) {
  const requested = new URLSearchParams(search).get("interface");
  return Object.hasOwn(INTERFACE_NAMES, requested)
    ? requested
    : Object.hasOwn(INTERFACE_NAMES, saved)
      ? saved
      : "classic";
}

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
let saved = null;
try {
  saved = browserStorage()?.getItem(SELECTION_KEY);
} catch {
  // A restricted store must not prevent opening either interface by URL.
}
const active = resolveInterfaceVariant(globalThis.location?.search, saved);
export const getInterfaceVariant = () => active;
export const isNextInterface = () => active === "next";
export function variantStorageKey(key, variant = active) {
  // Preserve every existing Classic key, including installed-app preferences.
  return variant === "next" ? `atlas:next:${key}` : key;
}
export function getInterfaceStorage(
  storage = browserStorage(),
  variant = active,
) {
  if (!storage) return null;
  return {
    getItem: (key) => storage.getItem(variantStorageKey(key, variant)),
    setItem: (key, value) =>
      storage.setItem(variantStorageKey(key, variant), value),
    removeItem: (key) => storage.removeItem(variantStorageKey(key, variant)),
  };
}
export function interfaceUrl(value, href) {
  if (!Object.hasOwn(INTERFACE_NAMES, value)) return null;
  const url = new URL(href);
  url.searchParams.set("interface", value);
  return url.href;
}
export function switchInterface(value) {
  const url = interfaceUrl(value, location.href);
  if (!url || value === active) return;
  try {
    browserStorage()?.setItem(SELECTION_KEY, value);
  } catch {
    // Query parameter keeps the choice usable even without persistent storage.
  }
  location.replace(url);
}
export function initializeInterface() {
  document.documentElement.dataset.interface = active;
  document.title = `В78 · ${INTERFACE_NAMES[active]}`;
}
