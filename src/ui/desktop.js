import { $ } from "./dom.js";
import { isCompactLandscape } from "./map-viewport.js";
import "./desktop.css";

export function bindDesktopNavigation({ experience, dismissRoom }) {
  const help = $("#desktop-help-dialog");
  $("#desktop-help-open").onclick = () => help.showModal();
  $("#desktop-help-close").onclick = () => help.close();
  help.addEventListener("click", (event) => {
    if (event.target === help) help.close();
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      document.body.dataset.cleanMap === "true" ||
      $("dialog[open]")
    )
      return;
    const active = document.activeElement;
    const editing = active?.matches(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    );
    const desktop =
      innerWidth > 700 && !isCompactLandscape(innerWidth, innerHeight);
    const searchShortcut =
      !event.altKey &&
      ((desktop &&
        (event.ctrlKey || event.metaKey) &&
        (event.code === "KeyK" || event.key.toLowerCase() === "k")) ||
        (!editing && !event.ctrlKey && !event.metaKey && event.key === "/"));
    if (searchShortcut) {
      event.preventDefault();
      experience.openSearch();
      return;
    }
    if (event.key === "Escape") {
      if (!editing) dismissRoom();
      return;
    }
    if (!desktop || editing || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const control =
      event.key === "+" || event.key === "="
        ? "#zoom-in"
        : event.key === "-"
          ? "#zoom-out"
          : event.key === "0"
            ? "#fit"
            : null;
    if (control) {
      event.preventDefault();
      $(control).click();
    }
  });
}
