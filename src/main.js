import "./styles.css";
import { startApp } from "./app.js";
import { initMobileShell } from "./mobile.js";
// Internal selections use history.replaceState. A browser hashchange comes
// from opening another shared view in this tab or navigating its history.
window.addEventListener("hashchange", () => location.reload());
initMobileShell().catch(console.warn).finally(startApp);
