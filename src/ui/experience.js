import { $, escape } from "./dom.js";
import { icon } from "./icons.js";
import { getBundledMapPackage, nativeShareLink } from "../mobile.js";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
export const readSaved = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(`atlas:${key}`));
    if (value == null) return fallback;
    if (Array.isArray(fallback))
      return Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string")
        : fallback;
    if (typeof fallback === "object") {
      if (typeof value !== "object" || Array.isArray(value)) return fallback;
      return Object.fromEntries(
        Object.entries(fallback).map(([name, defaultValue]) => [
          name,
          typeof value[name] === typeof defaultValue
            ? value[name]
            : defaultValue,
        ]),
      );
    }
    return typeof value === typeof fallback ? value : fallback;
  } catch {
    return fallback;
  }
};
export const writeSaved = (key, value) => {
  try {
    localStorage.setItem(`atlas:${key}`, JSON.stringify(value));
  } catch {
    /* Storage is optional. */
  }
};
export async function shareView(hash, toast) {
  const native = Capacitor.isNativePlatform();
  const url = native
    ? nativeShareLink(hash)
    : `${location.origin}${location.pathname}${hash}`;
  const title = "МИРЭА · Вернадского, 78";
  try {
    if (native) {
      // The native plugin's url field supports http(s)/file, not our custom scheme.
      await Share.share({ title, text: url, dialogTitle: "Поделиться картой" });
    } else if (navigator.share) await navigator.share({ title, url });
    else {
      await navigator.clipboard.writeText(url);
      toast("Ссылка скопирована");
    }
  } catch (e) {
    if (
      e?.name !== "AbortError" &&
      !(native && e?.message === "Share canceled")
    )
      toast("Не удалось отправить ссылку. Попробуйте ещё раз.");
  }
}
export function bindExperience({ state, scene, navigateRoom, toast }) {
  const sidebar = $(".sidebar"),
    handle = $("#sheet-toggle"),
    content = $(".sidebar-scroll");
  let sheetState = "peek",
    drag = null,
    suppressDragClick = false;
  const mobile = () => innerWidth <= 700;
  const clearDrag = () => {
    sidebar.classList.toggle("dragging", false);
    sidebar.style.removeProperty("--sheet-drag");
  };
  const setSheetState = (next) => {
    sheetState = next;
    clearDrag();
    const minimized = next === "minimized" && mobile();
    sidebar.classList.toggle("expanded", next === "expanded");
    sidebar.classList.toggle("minimized", minimized);
    if (minimized && content.contains(document.activeElement))
      document.activeElement.blur();
    content.inert = minimized;
    content.setAttribute("aria-hidden", minimized);
    handle.setAttribute("aria-expanded", next === "expanded");
    handle.setAttribute(
      "aria-label",
      minimized
        ? "Открыть поиск и маршрут"
        : next === "expanded"
          ? "Свернуть панель"
          : "Развернуть панель",
    );
  };
  const expand = (value) => setSheetState(value ? "expanded" : "peek");
  handle.onclick = (event) => {
    // A captured drag can produce a click afterwards; keyboard clicks have detail=0.
    if (suppressDragClick && event.detail !== 0) {
      suppressDragClick = false;
      return;
    }
    suppressDragClick = false;
    setSheetState(
      sheetState === "minimized"
        ? "peek"
        : sheetState === "expanded"
          ? "peek"
          : "expanded",
    );
  };
  handle.addEventListener("pointerdown", (e) => {
    if (
      !mobile() ||
      e.isPrimary === false ||
      (e.button != null && e.button !== 0)
    )
      return;
    drag = {
      id: e.pointerId,
      x: e.clientX ?? 0,
      y: e.clientY,
      height: sidebar.getBoundingClientRect().height,
      state: sheetState,
    };
    suppressDragClick = false;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) < 8) return;
    const limit = Math.max(
      0,
      drag.height - handle.getBoundingClientRect().height,
    );
    sidebar.classList.toggle("dragging", true);
    sidebar.style.setProperty(
      "--sheet-drag",
      `${Math.max(-80, Math.min(limit, dy))}px`,
    );
  });
  const finishDrag = (e, canceled = false) => {
    if (!drag || e.pointerId !== drag.id) return;
    const start = drag;
    drag = null;
    clearDrag();
    if (handle.hasPointerCapture(e.pointerId))
      handle.releasePointerCapture(e.pointerId);
    if (canceled) {
      suppressDragClick = true;
      return;
    }
    const dy = e.clientY - start.y,
      dx = (e.clientX ?? start.x) - start.x;
    if (Math.abs(dy) <= 25 || Math.abs(dy) <= Math.abs(dx)) return;
    suppressDragClick = true;
    if (dy > 0)
      setSheetState(
        start.state === "expanded" && dy < Math.min(180, start.height * 0.4)
          ? "peek"
          : "minimized",
      );
    else
      setSheetState(
        start.state === "minimized" && -dy < 120 ? "peek" : "expanded",
      );
  };
  handle.addEventListener("pointerup", (e) => finishDrag(e));
  handle.addEventListener("pointercancel", (e) => finishDrag(e, true));
  handle.addEventListener("lostpointercapture", (e) => finishDrag(e, true));
  handle.addEventListener("keydown", (e) => {
    if (!mobile() || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    setSheetState(
      e.key === "ArrowDown"
        ? sheetState === "expanded"
          ? "peek"
          : "minimized"
        : sheetState === "minimized"
          ? "peek"
          : "expanded",
    );
  });
  window.addEventListener("resize", () => {
    drag = null;
    clearDrag();
    if (!mobile() && sheetState === "minimized") setSheetState("peek");
  });
  setSheetState("peek");
  const themeQuery = matchMedia("(prefers-color-scheme: dark)");
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const settings = readSaved("settings", {
    theme: "system",
    quality: "auto",
    motion: motionQuery.matches,
  });
  if (!["system", "light", "dark"].includes(settings.theme))
    settings.theme = "system";
  if (!["auto", "low", "high"].includes(settings.quality))
    settings.quality = "auto";
  function applySettings() {
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "system" && themeQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.reducedMotion = String(settings.motion);
    scene.setTheme(dark ? "dark" : "light");
    scene.setReducedMotion(settings.motion);
    scene.setQuality(settings.quality);
    writeSaved("settings", settings);
  }
  $("#theme-setting").value = settings.theme;
  $("#quality-setting").value = settings.quality;
  $("#motion-setting").checked = settings.motion;
  $("#theme-setting").onchange = (e) => {
    settings.theme = e.target.value;
    applySettings();
  };
  $("#quality-setting").onchange = (e) => {
    settings.quality = e.target.value;
    applySettings();
  };
  $("#motion-setting").onchange = (e) => {
    settings.motion = e.target.checked;
    applySettings();
  };
  themeQuery.addEventListener("change", applySettings);
  applySettings();
  $("#settings-open").onclick = () => $("#settings-dialog").showModal();
  $("#settings-close").onclick = () => $("#settings-dialog").close();
  $("#settings-dialog").addEventListener("click", (e) => {
    if (e.target === $("#settings-dialog")) e.target.close();
  });
  $("#clear-history").onclick = () => {
    writeSaved("recent", []);
    renderSaved();
    toast("История поиска очищена");
  };
  getBundledMapPackage()
    .then((pkg) => {
      if (pkg)
        $("#offline-status").textContent =
          `Карта Вернадского, 78 сохранена на устройстве · ${Math.round(pkg.bytes / 1024 / 1024)} МБ. Поиск и маршруты работают без сети. Данные обновляются вместе с приложением.`;
    })
    .catch(() => {});
  function renderSaved() {
    const favorites = readSaved("favorites", []),
      recent = readSaved("recent", []);
    $("#saved-places").innerHTML = [
      ["Избранное", favorites],
      ["Недавно", recent.filter((id) => !favorites.includes(id))],
    ]
      .map(([label, ids]) => {
        const rooms = ids
          .map((id) => state.search.find((r) => r.id === id))
          .filter(Boolean)
          .slice(0, 5);
        return rooms.length
          ? `<div class="saved-heading">${icon(label === "Избранное" ? "star" : "pin", 13)}${label}</div><div class="saved-chips">${rooms.map((r) => `<button data-saved="${escape(r.id)}">${escape(r.label)}</button>`).join("")}</div>`
          : "";
      })
      .join("");
    for (const b of $("#saved-places").querySelectorAll("button"))
      b.onclick = () =>
        navigateRoom(state.search.find((r) => r.id === b.dataset.saved));
  }
  function remember(room) {
    writeSaved(
      "recent",
      [
        room.id,
        ...readSaved("recent", []).filter((id) => id !== room.id),
      ].slice(0, 12),
    );
    renderSaved();
  }
  function favorite(room) {
    const saved = readSaved("favorites", []);
    const next = saved.includes(room.id)
      ? saved.filter((id) => id !== room.id)
      : [room.id, ...saved];
    writeSaved("favorites", next);
    renderSaved();
    return next.includes(room.id);
  }
  window.addEventListener("atlas:back", (e) => {
    if (!$("#results").hidden) {
      $("#results").hidden = true;
      $("#search").setAttribute("aria-expanded", "false");
      expand(false);
      e.preventDefault();
      return;
    }
    if (!$("#route-results").hidden) {
      $("#route-results").hidden = true;
      for (const key of ["from", "to"])
        $("#route-" + key).setAttribute("aria-expanded", "false");
      e.preventDefault();
      return;
    }
    if (sidebar.classList.contains("expanded")) {
      expand(false);
      e.preventDefault();
    }
  });
  return {
    expand,
    minimize: () => setSheetState("minimized"),
    getSheetState: () => sheetState,
    renderSaved,
    remember,
    favorite,
  };
}
