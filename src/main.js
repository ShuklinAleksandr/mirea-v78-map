import "./styles.css";
import { startApp } from "./app.js";
import { initMobileShell } from "./mobile.js";
initMobileShell().catch(console.warn).finally(startApp);
