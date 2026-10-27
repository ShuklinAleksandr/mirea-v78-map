import path from "node:path";
import { writeMobilePackage } from "./lib/mobile-package.mjs";

const project = path.resolve(import.meta.dirname, "..");
const descriptor = await writeMobilePackage(
  project,
  path.join(project, "dist"),
);
console.log(
  `Bundled V78 map ${descriptor.version}: ${descriptor.files.length} files, ${(descriptor.bytes / 1048576).toFixed(1)} MiB, ${descriptor.campuses.length} campus.`,
);
