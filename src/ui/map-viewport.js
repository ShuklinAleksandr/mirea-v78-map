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
  const right = ["tools", "floors"].map(visible).filter(Boolean);
  const location = visible("location");
  return {
    left: Math.max(16, ...left.map((rect) => rect.right + 12)),
    top: Math.max(16, ...top.map((rect) => rect.bottom + 12)),
    right: Math.max(16, ...right.map((rect) => width - rect.left + 12)),
    bottom: location ? Math.max(16, height - location.top + 12) : 16,
  };
}

export function landscapeMapPadding() {
  const selectors = {
    sidebar: ".sidebar",
    dock: "#route-guidance-dock",
    top: ".map-top",
    status: ".focus-floor-status",
    floorPicker: "#next-floor-open",
    floors: "#floor-rail",
    tools: ".map-tools",
    location: "#location-pick-banner",
  };
  const rectangles = Object.fromEntries(
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
  return measuredLandscapePadding(innerWidth, innerHeight, rectangles);
}
