import { escape } from "./dom.js";

/** A choice is required only when two different, successfully computed paths
 * exist. Cancellation never picks a route or starts guidance implicitly. */
export function createRouteOptionPicker() {
  let cancelPending = null;
  return {
    cancel() {
      cancelPending?.();
    },
    choose(result) {
      cancelPending?.();
      const options = result.routeOptions?.filter((option) => option.route?.ok);
      if (!options || options.length < 2) return Promise.resolve(result);
      const dialog = document.querySelector("#route-choice-dialog");
      const list = document.querySelector("#route-choice-list");
      return new Promise((resolve) => {
        let settled = false;
        const finish = (option) => {
          if (settled) return;
          settled = true;
          cancelPending = null;
          dialog.close();
          resolve(option ? { ...option.route, routeOptions: options } : null);
        };
        cancelPending = () => finish(null);
        list.innerHTML = options
          .map(
            (option, index) =>
              `<button type="button" class="route-choice" data-route-choice="${index}"><span><b>${escape(option.label)}</b><small>${escape(option.description)}</small></span><strong>${Number.isFinite(option.route.durationMinutes) ? `≈ ${option.route.durationMinutes} мин` : "Показать"}</strong></button>`,
          )
          .join("");
        for (const button of list.querySelectorAll("button"))
          button.onclick = () =>
            finish(options[Number(button.dataset.routeChoice)]);
        document.querySelector("#route-choice-close").onclick = () =>
          finish(null);
        // close is queued by the browser. An older close event must not cancel
        // a new choice that has already reopened this same dialog element.
        dialog.onclose = () => {
          if (!dialog.open) finish(null);
        };
        dialog.showModal();
        list.querySelector("button")?.focus({ preventScroll: true });
      });
    },
  };
}
