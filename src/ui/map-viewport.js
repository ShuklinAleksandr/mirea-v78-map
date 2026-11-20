import { $ } from "./dom.js";

// Tab zoom can produce fractional CSS dimensions while innerWidth and
// innerHeight report rounded integers. Use the same live queries as the CSS.
export function viewportLayout(view = globalThis.window) {
  if (view.matchMedia) {
    // During WebKit's resize event an existing MediaQueryList can still
    // report the old layout until its change event. Query the current view.
    if (
      view.matchMedia(
        "(min-width: 520px) and (max-width: 1100px) and (max-height: 520px) and (orientation: landscape)",
      ).matches
    )
      return "landscape";
    return view.matchMedia("(max-width: 700px)").matches
      ? "portrait"
      : "desktop";
  }
  const { innerWidth: width, innerHeight: height } = view;
  if (width >= 520 && width <= 1100 && height <= 520 && width > height)
    return "landscape";
  return width <= 700 ? "portrait" : "desktop";
}

export function measuredLandscapePadding(width, height, rectangles) {
  const visible = (name) => {
    const rect = rectangles[name];
    return rect?.width > 0 && rect?.height > 0 ? rect : null;
  };
  const left = ["sidebar", "dock"].map(visible).filter(Boolean);
  const top = ["top", "status", "floorPicker"].map(visible).filter(Boolean);
  const right = ["tools", "floors", "route"].map(visible).filter(Boolean);
  const location = visible("location");
  return {
    left: Math.max(16, ...left.map((rect) => rect.right + 12)),
    top: Math.max(16, ...top.map((rect) => rect.bottom + 12)),
    right: Math.max(16, ...right.map((rect) => width - rect.left + 12)),
    bottom: location ? Math.max(16, height - location.top + 12) : 16,
  };
}

export function measuredPortraitPadding(width, height, rectangles) {
  const visible = (name) => {
    const rect = rectangles[name];
    return rect?.width > 0 &&
      rect?.height > 0 &&
      rect.right > 0 &&
      rect.left < width &&
      rect.bottom > 0 &&
      rect.top < height
      ? rect
      : null;
  };
  const firstRow = ["top", "back", "settings"].map(visible).filter(Boolean);
  const tools = visible("tools");
  const floorPicker = visible("floorPicker");
  const toolsOnLeft = tools && tools.left < width / 2;
  // In route mode the tools move from the right rail to a row at the upper
  // left. The floor picker beside that row already fits within its padding.
  const top = toolsOnLeft ? [...firstRow, tools] : firstRow;
  const topPadding = Math.max(64, ...top.map((rect) => rect.bottom + 12));
  const right = [floorPicker, tools].filter(
    (rect) => rect && rect.bottom + 12 > topPadding,
  );
  const bottom = ["sidebar", "dock", "location", "route"]
    .map(visible)
    .filter(Boolean);
  const padding = {
    left: 16,
    top: topPadding,
    right: Math.min(
      84,
      Math.max(16, ...right.map((rect) => width - rect.left + 12)),
    ),
    bottom: Math.max(16, ...bottom.map((rect) => height - rect.top + 12)),
  };
  if (toolsOnLeft && visible("dock")) {
    // At high zoom in a low window the dock can reach the second row. Fit
    // between the left and right controls if that leaves more visible map.
    const controls = [...top, floorPicker].filter(Boolean);
    const left = Math.max(
      16,
      ...controls
        .filter((rect) => rect.left < width / 2)
        .map((rect) => rect.right + 12),
    );
    const right = Math.max(
      16,
      ...controls
        .filter((rect) => rect.left >= width / 2)
        .map((rect) => width - rect.left + 12),
    );
    const inset = Math.max(
      16,
      Math.min(...firstRow.map((rect) => rect.top + 8), padding.top),
    );
    const gapWidth = width - left - right;
    const area = (w, top) =>
      Math.max(0, w) * Math.max(0, height - padding.bottom - top);
    if (
      gapWidth >= width / 4 &&
      area(gapWidth, inset) >
        area(width - padding.left - padding.right, padding.top)
    )
      return { ...padding, left, right, top: inset };
  }
  return padding;
}

function visibleMapRectangles(selectors) {
  return Object.fromEntries(
    Object.entries(selectors).map(([name, selector]) => {
      const element = $(selector);
      const visible =
        element &&
        !element.hidden &&
        getComputedStyle(element).visibility !== "hidden" &&
        getComputedStyle(element).display !== "none";
      return [name, visible ? element.getBoundingClientRect() : null];
    }),
  );
}

export function portraitMapPadding() {
  const rectangles = visibleMapRectangles({
    top: ".map-top",
    back: "#campus-overview",
    settings: "#settings-open",
    floorPicker: "#next-floor-open",
    tools: ".map-tools",
    sidebar: ".sidebar",
    dock: "#route-guidance-dock",
    location: "#location-pick-banner",
    route: "#route-open",
  });
  return measuredPortraitPadding(innerWidth, innerHeight, rectangles);
}

export function landscapeMapPadding() {
  const rectangles = visibleMapRectangles({
    sidebar: ".sidebar",
    dock: "#route-guidance-dock",
    top: ".map-top",
    status: ".focus-floor-status",
    floorPicker: "#next-floor-open",
    floors: "#floor-rail",
    tools: ".map-tools",
    location: "#location-pick-banner",
    route: "#route-open",
  });
  return measuredLandscapePadding(innerWidth, innerHeight, rectangles);
}

export function desktopMapPadding() {
  // Both navigation panels share the left column. They reserve width only;
  // a long route card must not squeeze the map into a narrow horizontal strip.
  const rectangles = visibleMapRectangles({
    sidebar: ".sidebar",
    dock: "#route-guidance-dock",
    top: ".map-top",
    floorPicker: "#next-floor-open",
    tools: ".map-tools",
    location: "#location-pick-banner",
    route: "#route-open",
  });
  return measuredLandscapePadding(innerWidth, innerHeight, rectangles);
}
