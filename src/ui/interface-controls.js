import { $ } from "./dom.js";
import {
  getInterfaceVariant,
  INTERFACE_NAMES,
  switchInterface,
} from "./variant.js";

export function bindInterfaceControls() {
  const current = getInterfaceVariant();
  for (const variant of ["classic", "next"]) {
    const button = $("#interface-" + variant);
    button.setAttribute("aria-pressed", String(variant === current));
    button.onclick = () => switchInterface(variant);
  }
  $("#interface-current").textContent =
    `В78 · ${INTERFACE_NAMES[current]} · сборка для сравнения`;
}
