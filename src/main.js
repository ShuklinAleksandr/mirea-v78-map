import "./styles.css";
import { startApp } from "./app.js";
import { initMobileShell } from "./mobile.js";
// Internal selections use history.replaceState. A browser hashchange comes
// from opening another shared view in this tab or navigating its history.
//window.addEventListener("hashchange", () => location.reload());
window.addEventListener("hashchange", () => {
  // Например, updateMapFromHash();
  // Или просто ничего не делайте, если приложение само следит за хэшем
});
initMobileShell().catch(console.warn).finally(startApp);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(console.error);
  });
}
