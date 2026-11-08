import { $ } from "./dom.js";

// Keep these limits aligned with the compact landscape media query.
export function isCompactLandscape(width, height) {
  return width >= 520 && width <= 1100 && height <= 520 && width > height;
}

export function landscapeMapPadding() {
  const sidebar = $(".sidebar").getBoundingClientRect();
  const top = $(".map-top").getBoundingClientRect();
  const status = $(".focus-floor-status").getBoundingClientRect();
  const floors = $("#floor-rail").getBoundingClientRect();
  const tools = $(".map-tools").getBoundingClientRect();
  const location = $("#location-pick-banner").getBoundingClientRect();
  return {
    left: sidebar.right + 12,
    top: Math.max(top.bottom, status.bottom, floors.bottom) + 12,
    right: tools.width ? innerWidth - tools.left + 12 : 16,
    bottom: location.height ? innerHeight - location.top + 12 : 16,
  };
}
