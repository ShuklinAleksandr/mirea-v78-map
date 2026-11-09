import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { variantStorageKey } from "./ui/variant.js";
import { resolveAssetUrl } from "./data/client.js";

const VIEW_KEY = variantStorageKey("mirea:last-native-view:v1");
const NATIVE_LAUNCH_WAIT_MS = 1200;
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

// Native callbacks can stop arriving during a WebView reload. Optional shell
// services must neither hold map startup nor leave rejected promises unhandled.
function nativeAttempt(run) {
  try {
    return Promise.resolve(run()).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function openNativeLink(url) {
  const hash = nativeLinkHash(url);
  if (!hash || hash === location.hash) return;
  history.replaceState(null, "", hash);
  // Reload bundled assets so the normal validated boot path handles links.
  location.reload();
}

/** Give launch links a bounded head start before loading the offline map. */
export async function initMobileShell() {
  const platform = Capacitor.getPlatform();
  document.documentElement.dataset.platform =
    globalThis.window?.mireaDesktop?.platform || platform;
  if (!Capacitor.isNativePlatform()) return;

  if (!location.hash) {
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

  nativeAttempt(() =>
    App.addListener("appUrlOpen", ({ url }) => openNativeLink(url)),
  );
  nativeAttempt(() =>
    App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) rememberView();
      document.documentElement.dataset.appActive = String(isActive);
      window.dispatchEvent(
        new CustomEvent("atlas:app-state", { detail: { isActive } }),
      );
      if (isActive) window.dispatchEvent(new Event("resize"));
    }),
  );
  window.addEventListener("pagehide", rememberView);

  const updateBars = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    nativeAttempt(() =>
      SystemBars.setStyle({
        style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
      }),
    );
  };
  new MutationObserver(updateBars).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  updateBars();

  if (platform === "android") {
    nativeAttempt(() =>
      App.addListener("backButton", async () => {
        const dialog = document.querySelector("dialog[open]");
        if (dialog) {
          dialog.close();
          return;
        }
        const active = document.activeElement;
        if (
          active?.matches("input, textarea") &&
          document.body?.dataset.inputEditing !== "true"
        ) {
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
        await nativeAttempt(() => App.minimizeApp());
      }),
    );
  }

  const waitingHash = location.hash;
  const waitingUrl = location.href;
  const locationUnchanged = () =>
    location.hash === waitingHash && location.href === waitingUrl;
  const launch = nativeAttempt(() => App.getLaunchUrl());
  let timeout;
  let timedOut = false;
  const initial = await Promise.race([
    launch,
    new Promise((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, NATIVE_LAUNCH_WAIT_MS);
    }),
  ]);
  clearTimeout(timeout);
  if (timedOut) {
    // A delayed deep link remains usable, but never moves somebody away from
    // a view they have opened since startup (including an interface switch).
    nativeAttempt(async () => {
      const result = await launch;
      if (locationUnchanged()) openNativeLink(result?.url);
    });
  } else {
    const initialHash = nativeLinkHash(initial?.url);
    if (initialHash && locationUnchanged())
      history.replaceState(null, "", initialHash);
  }
}

export async function getBundledMapPackage() {
  if (!Capacitor.isNativePlatform() && !globalThis.window?.mireaDesktop)
    return null;
  const response = await fetch(resolveAssetUrl("/mobile-package.json"));
  return response.ok ? response.json() : null;
}
