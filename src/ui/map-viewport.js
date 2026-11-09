import { $ } from "./dom.js";

// Keep these limits aligned with the compact landscape media query.
export function isCompactLandscape(width, height) {
  return width >= 520 && width <= 1100 && height <= 520 && width > height;
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

/** The compact floor button only obstructs the right edge, not another full
 * horizontal row. Account for actual safe-area offsets on the top controls. */
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
  const top = ["top", "back", "settings"].map(visible).filter(Boolean);
  const right = ["floorPicker", "tools"].map(visible).filter(Boolean);
  const bottom = ["sidebar", "dock", "location", "route"]
    .map(visible)
    .filter(Boolean);
  return {
    left: 16,
    top: Math.max(64, ...top.map((rect) => rect.bottom + 12)),
    right: Math.min(
      84,
      Math.max(16, ...right.map((rect) => width - rect.left + 12)),
    ),
    bottom: Math.max(16, ...bottom.map((rect) => height - rect.top + 12)),
  };
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
