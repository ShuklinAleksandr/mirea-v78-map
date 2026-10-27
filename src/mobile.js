import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { App } from "@capacitor/app";

const VIEW_KEY = "mirea:last-native-view:v1";
const LINK_KEYS = new Set([
  "campus",
  "building",
  "floor",
  "view",
  "projection",
  "room",
  "from",
  "to",
]);

/** Accept only our custom scheme and known view parameters, never a remote page. */
export function nativeLinkHash(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "mireamap:" || url.hostname !== "map") return null;
    const input = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
    const output = new URLSearchParams();
    for (const [key, entry] of input) {
      if (LINK_KEYS.has(key) && entry.length <= 200) output.set(key, entry);
    }
    return output.size ? `#${output}` : null;
  } catch {
    return null;
  }
}

export function nativeShareLink(hash = location.hash) {
  return `mireamap://map${hash.startsWith("#") ? hash : `#${hash}`}`;
}

function rememberView() {
  try {
    localStorage.setItem(VIEW_KEY, location.hash);
  } catch {
    // A full or unavailable local store must never prevent map navigation.
  }
}

/** Call before startApp so launch links are restored before the first data load. */
export async function initMobileShell() {
  const platform = Capacitor.getPlatform();
  document.documentElement.dataset.platform = platform;
  if (!Capacitor.isNativePlatform()) return;

  const launch = await App.getLaunchUrl();
  const initialHash = nativeLinkHash(launch?.url);
  if (initialHash) history.replaceState(null, "", initialHash);
  else if (!location.hash) {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved) {
        const safeHash = nativeLinkHash(`mireamap://map${saved}`);
        if (safeHash) history.replaceState(null, "", safeHash);
      }
    } catch {
      // The app remains usable without persistence.
    }
  }

  await App.addListener("appUrlOpen", ({ url }) => {
    const hash = nativeLinkHash(url);
    if (!hash || hash === location.hash) return;
    history.replaceState(null, "", hash);
    // Reload local bundled assets so the normal validated boot path handles links.
    location.reload();
  });
  await App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) rememberView();
    document.documentElement.dataset.appActive = String(isActive);
    window.dispatchEvent(
      new CustomEvent("atlas:app-state", { detail: { isActive } }),
    );
    if (isActive) window.dispatchEvent(new Event("resize"));
  });
  window.addEventListener("pagehide", rememberView);

  const updateBars = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    SystemBars.setStyle({
      style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    }).catch(() => {});
  };
  new MutationObserver(updateBars).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  updateBars();

  if (platform === "android") {
    await App.addListener("backButton", async () => {
      const dialog = document.querySelector("dialog[open]");
      if (dialog) {
        dialog.close();
        return;
      }
      const active = document.activeElement;
      if (active?.matches("input, textarea")) {
        active.blur();
        return;
      }
      // UI can preventDefault to close a route/search panel before leaving the app.
      const back = new CustomEvent("atlas:back", { cancelable: true });
      if (!window.dispatchEvent(back)) return;
      const close = document.querySelector(
        "#room-card:not([hidden]) .card-close",
      );
      if (close) {
        close.click();
        return;
      }
      rememberView();
      await App.minimizeApp();
    });
  }
}

export async function getBundledMapPackage() {
  if (!Capacitor.isNativePlatform()) return null;
  const response = await fetch("/mobile-package.json");
  return response.ok ? response.json() : null;
}
