import { $ } from "./dom.js";
import {
  getInterfaceVariant,
  INTERFACE_NAMES,
  switchInterface,
} from "./variant.js";

export function bindInterfaceControls() {
  const current = getInterfaceVariant();
  const badge = $("#interface-badge");
  if (!badge) return;
  badge.textContent = INTERFACE_NAMES[current];
  badge.setAttribute(
    "aria-label",
    `Версия ${INTERFACE_NAMES[current]}. Сравнить интерфейсы`,
  );
  badge.onclick = () => {
    $("#settings-dialog").showModal();
    $("#interface-" + current).focus();
  };
  for (const variant of ["classic", "next"]) {
    const button = $("#interface-" + variant);
    button.setAttribute("aria-pressed", String(variant === current));
    button.onclick = () => switchInterface(variant);
  }
  $("#interface-current").textContent =
    `В78 · ${INTERFACE_NAMES[current]} · сборка для сравнения`;
}
