import { $, escape } from "./dom.js";
import { icon } from "./icons.js";
import { isCompactLandscape } from "./map-viewport.js";
import { getBundledMapPackage, nativeShareLink } from "../mobile.js";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { variantStorageKey } from "./variant.js";
import { bindInterfaceControls } from "./interface-controls.js";
import "./focused-input.css";
export const readSaved = (key, fallback) => {
  try {
    const value = JSON.parse(
      localStorage.getItem(variantStorageKey(`atlas:${key}`)),
    );
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
    localStorage.setItem(
      variantStorageKey(`atlas:${key}`),
      JSON.stringify(value),
    );
  } catch {
    /* Storage is optional. */
  }
};
export async function shareView(hash, toast) {
  const native = Capacitor.isNativePlatform();
  const desktop = globalThis.window?.mireaDesktop;
  const url =
    native || desktop
      ? nativeShareLink(hash)
      : `${location.origin}${location.pathname}${location.search || ""}${hash}`;
  const title = "МИРЭА · Вернадского, 78";
  try {
    if (desktop?.shareLink) {
      await desktop.shareLink(url);
    } else if (native) {
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
export function bindExperience({
  state,
  scene,
  navigateRoom,
  toast,
  onRouteSnapChange,
  onOpenSearch,
}) {
  const sidebar = $(".sidebar"),
    handle = $("#sheet-toggle"),
    content = $(".sidebar-scroll");
  let sheetState = "peek",
    drag = null,
    suppressDragClick = false;
  let desktopCollapsed = false;
  const landscape = () => isCompactLandscape(innerWidth, innerHeight);
  const mobile = () => innerWidth <= 700 || landscape();
  const searchOnly = () =>
    !$("#explore-panel").hidden &&
    $("#route-panel").hidden &&
    $("#room-card").hidden;
  const clearDrag = () => {
    sidebar.classList.toggle("dragging", false);
    sidebar.style.removeProperty("--sheet-drag");
  };
  const visualViewport = window.visualViewport;
  let editingInput = null;
  let editingField = "";
  let editingPointer = null;
  let editingReleaseTimer = null;
  const clearEditingPointer = () => {
    editingPointer = null;
    if (editingReleaseTimer != null) clearTimeout(editingReleaseTimer);
    editingReleaseTimer = null;
  };
  const editingResults = () =>
    $(editingField === "search" ? "#results" : "#route-results");
  const searchSuggestions = [$("#place-categories"), $("#saved-places")];
  const staysInEditor = (target) =>
    target === editingInput ||
    target === handle ||
    (editingField === "search" &&
      (target === $("#search-clear") ||
        searchSuggestions.some((section) => section.contains(target)))) ||
    editingResults().contains(target);
  function holdEditingPointer(event) {
    if (
      !editingInput ||
      !mobile() ||
      event.isPrimary === false ||
      (event.button != null && event.button !== 0)
    )
      return;
    clearEditingPointer();
    editingPointer = { id: event.pointerId, input: editingInput };
  }
  let restingWidth = innerWidth;
  let restingHeight = Math.max(
    innerHeight,
    document.documentElement.clientHeight || 0,
  );
  const updateVisibleBounds = () => {
    // Safari can blur an input with relatedTarget=null and dismiss its keyboard
    // between pointerdown and click. Keep the hit target in place until click;
    // this also holds the short-viewport grid during the keyboard animation.
    if (editingPointer && sheetState === "expanded") return;
    const layoutHeight = Math.max(
      innerHeight,
      document.documentElement.clientHeight || 0,
    );
    // Android adjustResize shrinks the layout viewport as well as the visual
    // viewport. Keep the pre-keyboard height, but never compare portrait and
    // landscape heights. Input editing itself remains a reliable CSS signal
    // even when an orientation change happens with the keyboard already open.
    if (Math.abs(innerWidth - restingWidth) > 80) {
      restingWidth = innerWidth;
      restingHeight = layoutHeight;
    } else if (!editingInput) {
      restingHeight = Math.max(restingHeight, layoutHeight);
    }
    const editing = Boolean(editingInput) && mobile();
    const collapsed = desktopCollapsed && !mobile();
    sidebar.dataset.desktopCollapsed = String(collapsed);
    if (!mobile()) {
      content.inert = collapsed;
      content.setAttribute("aria-hidden", String(collapsed));
    }
    $("#desktop-search").setAttribute("aria-expanded", String(!collapsed));
    sidebar.dataset.inputEditing = String(editing);
    sidebar.dataset.editingField = editing ? editingField : "";
    if (document.body.dataset.inputEditing !== String(editing))
      document.body.dataset.inputEditing = String(editing);
    handle.setAttribute(
      "aria-label",
      editing
        ? "Завершить ввод"
        : sheetState === "minimized" && mobile()
          ? "Открыть поиск помещения"
          : sheetState === "expanded" || landscape()
            ? "Свернуть панель"
            : "Развернуть панель",
    );
    const unzoomed = !visualViewport || visualViewport.scale === 1;
    const visibleHeight = visualViewport?.height ?? layoutHeight;
    sidebar.dataset.shortViewport = String(
      editing && unzoomed && visibleHeight < 180,
    );
    sidebar.dataset.keyboardOpen = String(
      editing && unzoomed && restingHeight - visibleHeight > 80,
    );
    // Safari's overlay keyboard leaves fixed elements in the layout viewport.
    // Apply visual bounds in BOTH orientations; native adjustResize naturally
    // gives a zero bottom inset with the smaller available height.
    if (sheetState !== "expanded" || !mobile() || !unzoomed) {
      sidebar.style.removeProperty("--sheet-viewport-top");
      sidebar.style.removeProperty("--sheet-viewport-bottom");
      sidebar.style.removeProperty("--sheet-viewport-height");
      return;
    }
    const top = Math.max(0, visualViewport?.offsetTop ?? 0);
    const bottom = Math.max(0, layoutHeight - visibleHeight - top);
    sidebar.style.setProperty("--sheet-viewport-top", `${Math.round(top)}px`);
    sidebar.style.setProperty(
      "--sheet-viewport-bottom",
      `${Math.round(bottom)}px`,
    );
    sidebar.style.setProperty(
      "--sheet-viewport-height",
      `${Math.round(visibleHeight)}px`,
    );
  };
  const setSheetState = (next) => {
    // Search has a compact entry and a full editor. The middle position is
    // reserved for a place card or route, which have useful content to show.
    if (next === "peek" && mobile() && searchOnly()) next = "minimized";
    if (next !== "minimized") desktopCollapsed = false;
    sheetState = next;
    if (next !== "expanded") {
      clearEditingPointer();
      editingInput = null;
      editingField = "";
    }
    clearDrag();
    const minimized = next === "minimized" && mobile();
    sidebar.classList.toggle("expanded", next === "expanded");
    sidebar.classList.toggle("minimized", minimized);
    const active = document.activeElement;
    if (
      content.contains(active) &&
      (minimized ||
        (mobile() && next !== "expanded" && active?.matches("input, textarea")))
    )
      active.blur();
    content.inert = minimized;
    content.setAttribute("aria-hidden", minimized);
    handle.setAttribute(
      "aria-expanded",
      next === "expanded" || (landscape() && !minimized),
    );
    updateVisibleBounds();
  };
  // Closing a place card can reveal search without requesting a new sheet
  // position. Normalize that transition as well, after the DOM update settles.
  if (typeof MutationObserver === "function") {
    const contentObserver = new MutationObserver(() => {
      if (sheetState === "peek" && mobile() && searchOnly())
        setSheetState("minimized");
    });
    for (const selector of ["#explore-panel", "#route-panel", "#room-card"])
      contentObserver.observe($(selector), {
        attributes: true,
        attributeFilter: ["hidden"],
      });
  }
  const expand = (value) => setSheetState(value ? "expanded" : "peek");
  function openSearch() {
    onOpenSearch?.();
    setSheetState("expanded");
    // iOS only opens the keyboard if focus happens in the same tap handler.
    $("#search").focus({ preventScroll: true });
  }
  $("#desktop-search").onclick = openSearch;
  $("#desktop-collapse").onclick = () => {
    desktopCollapsed = true;
    updateVisibleBounds();
    $("#desktop-search").focus({ preventScroll: true });
  };
  function finishInputEditing({ focusHandle = true } = {}) {
    if (!editingInput || !mobile()) return false;
    const input = editingInput;
    editingResults().hidden = true;
    input.setAttribute("aria-expanded", "false");
    if (editingField === "search") {
      // Invalidates a nearby-search worker result still pending when we exit.
      input.dispatchEvent(new Event("atlas:input-editing-end"));
    }
    setSheetState("peek");
    input.blur();
    if (focusHandle) handle.focus({ preventScroll: true });
    return true;
  }
  handle.onclick = (event) => {
    // A captured drag can produce a click afterwards; keyboard clicks have detail=0.
    if (suppressDragClick && event.detail !== 0) {
      suppressDragClick = false;
      return;
    }
    suppressDragClick = false;
    if (finishInputEditing()) return;
    if (sheetState === "minimized") {
      openSearch();
      return;
    }
    if (landscape()) {
      setSheetState("minimized");
      return;
    }
    setSheetState(sheetState === "expanded" ? "peek" : "expanded");
  };
  handle.addEventListener("pointerdown", (e) => {
    if (editingInput && mobile()) {
      holdEditingPointer(e);
      return;
    }
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
    else setSheetState("expanded");
  };
  handle.addEventListener("pointerup", (e) => finishDrag(e));
  handle.addEventListener("pointercancel", (e) => finishDrag(e, true));
  handle.addEventListener("lostpointercapture", (e) => finishDrag(e, true));
  handle.addEventListener("keydown", (e) => {
    if (editingInput || !mobile() || !["ArrowUp", "ArrowDown"].includes(e.key))
      return;
    e.preventDefault();
    setSheetState(
      e.key === "ArrowDown"
        ? sheetState === "expanded"
          ? "peek"
          : "minimized"
        : sheetState === "minimized" && !searchOnly()
          ? "peek"
          : "expanded",
    );
  });
  window.addEventListener("resize", () => {
    drag = null;
    setSheetState(
      !mobile() && sheetState === "minimized" ? "peek" : sheetState,
    );
  });
  sidebar.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.isComposing || !finishInputEditing())
        return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  function leaveEditingFocus(event) {
    if (
      editingInput &&
      !editingPointer &&
      !staysInEditor(event.relatedTarget)
    ) {
      editingInput = null;
      editingField = "";
    }
    updateVisibleBounds();
  }
  for (const selector of ["#search", "#route-from", "#route-to"]) {
    const input = $(selector);
    input.addEventListener("focus", () => {
      clearEditingPointer();
      editingInput = input;
      editingField = selector.slice(1);
      if (mobile()) {
        // A previously scrolled sheet must not leave its input/results above
        // the keyboard. This scrolls only the sheet, never the map or page.
        content.scrollTop = 0;
        setSheetState("expanded");
      } else updateVisibleBounds();
    });
    input.addEventListener("blur", (event) => {
      if (editingInput === input) leaveEditingFocus(event);
    });
  }
  for (const control of [handle, $("#search-clear")]) {
    control.addEventListener("focusout", leaveEditingFocus);
    control.addEventListener("mousedown", (event) => {
      if (editingInput && mobile() && event.button === 0)
        event.preventDefault();
    });
  }
  $("#search-clear").addEventListener("pointerdown", holdEditingPointer);
  for (const results of [
    $("#results"),
    $("#route-results"),
    ...searchSuggestions,
  ]) {
    results.addEventListener("mousedown", (event) => {
      const button = event.target?.closest?.("button");
      if (event.button === 0 && button && results.contains(button))
        // A completed touch tap can generate this compatibility mouse event
        // in Safari. Keep the input focused until the result's real click.
        // Do not cancel pointerdown/touchstart: native list scrolling must work.
        event.preventDefault();
    });
    results.addEventListener(
      "pointerdown",
      (event) => {
        if (
          results === editingResults() ||
          (editingField === "search" && searchSuggestions.includes(results))
        )
          holdEditingPointer(event);
      },
      { passive: true },
    );
    results.addEventListener("focusout", leaveEditingFocus);
  }
  const releaseEditingPointer = (event) => {
    if (!editingPointer || event.pointerId !== editingPointer.id) return;
    const pending = editingPointer;
    if (editingReleaseTimer != null) clearTimeout(editingReleaseTimer);
    // Native click follows pointerup in the same event task. No preventDefault,
    // pointer capture or synthetic click: vertical result scrolling stays native.
    editingReleaseTimer = setTimeout(() => {
      if (editingPointer !== pending) return;
      editingPointer = null;
      editingReleaseTimer = null;
      const active = document.activeElement;
      if (editingInput === pending.input)
        leaveEditingFocus({ relatedTarget: active });
    }, 0);
  };
  window.addEventListener("pointerup", releaseEditingPointer, true);
  window.addEventListener("pointercancel", releaseEditingPointer, true);
  visualViewport?.addEventListener("resize", updateVisibleBounds);
  visualViewport?.addEventListener("scroll", updateVisibleBounds);
  setSheetState(mobile() ? "minimized" : "peek");
  const themeQuery = matchMedia("(prefers-color-scheme: dark)");
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const settings = readSaved("settings", {
    theme: "system",
    quality: "balanced",
    frameRate: "auto",
    motion: motionQuery.matches,
    headingFollow: true,
    routeSnap: false,
  });
  state.routeSnapEnabled = settings.routeSnap;
  if (!["system", "light", "dark"].includes(settings.theme))
    settings.theme = "system";
  if (!["auto", "low", "balanced", "high"].includes(settings.quality))
    settings.quality = "balanced";
  if (!["auto", "30", "60"].includes(settings.frameRate))
    settings.frameRate = "auto";
  const migrateQualityDefault = readSaved("quality-default-version", 0) < 1;
  // The old startup saved "auto" even when nobody chose it. Reset that legacy
  // value once per interface profile; subsequent explicit "auto" is retained.
  if (migrateQualityDefault && settings.quality === "auto")
    settings.quality = "balanced";
  let autoFrameRate = 60;
  function applyFrameRate() {
    scene.setFrameRate?.(
      settings.frameRate === "auto"
        ? (scene.qualityProfile?.autoFrameRate ?? autoFrameRate)
        : Number(settings.frameRate),
      { automatic: settings.frameRate === "auto" },
    );
  }
  function applyGraphics() {
    autoFrameRate = scene.setQuality(settings.quality)?.autoFrameRate ?? 60;
    applyFrameRate();
  }
  function applySettings() {
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "system" && themeQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.reducedMotion = String(settings.motion);
    scene.setTheme(dark ? "dark" : "light");
    scene.setReducedMotion(settings.motion);
    scene.setHeadingFollow?.(settings.headingFollow);
    writeSaved("settings", settings);
  }
  $("#theme-setting").value = settings.theme;
  $("#quality-setting").value = settings.quality;
  $("#frame-rate-setting").value = settings.frameRate;
  $("#motion-setting").checked = settings.motion;
  $("#heading-follow-setting").checked = settings.headingFollow;
  $("#route-snap-setting").checked = settings.routeSnap;
  $("#theme-setting").onchange = (e) => {
    settings.theme = e.target.value;
    applySettings();
  };
  $("#quality-setting").onchange = (e) => {
    settings.quality = e.target.value;
    applyGraphics();
    writeSaved("settings", settings);
  };
  $("#frame-rate-setting").onchange = (e) => {
    settings.frameRate = e.target.value;
    applyFrameRate();
    writeSaved("settings", settings);
  };
  $("#motion-setting").onchange = (e) => {
    settings.motion = e.target.checked;
    applySettings();
  };
  $("#heading-follow-setting").onchange = (e) => {
    settings.headingFollow = e.target.checked;
    scene.setHeadingFollow?.(settings.headingFollow);
    writeSaved("settings", settings);
  };
  $("#route-snap-setting").onchange = (e) => {
    state.routeSnapEnabled = settings.routeSnap = e.target.checked;
    writeSaved("settings", settings);
    onRouteSnapChange?.();
  };
  themeQuery.addEventListener("change", applySettings);
  applyGraphics();
  applySettings();
  if (migrateQualityDefault) writeSaved("quality-default-version", 1);
  $("#settings-open").onclick = () => $("#settings-dialog").showModal();
  $("#settings-close").onclick = () => $("#settings-dialog").close();
  bindInterfaceControls();
  $("#settings-dialog").addEventListener("click", (e) => {
    if (e.target === $("#settings-dialog")) e.target.close();
  });
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
      b.onclick = () => {
        finishInputEditing({ focusHandle: false });
        navigateRoom(state.search.find((r) => r.id === b.dataset.saved));
      };
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
    if (e.defaultPrevented) return;
    if (finishInputEditing()) {
      e.preventDefault();
      return;
    }
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
    openSearch,
    finishInputEditing,
    minimize: () => setSheetState("minimized"),
    getSheetState: () => sheetState,
    renderSaved,
    remember,
    favorite,
  };
}
