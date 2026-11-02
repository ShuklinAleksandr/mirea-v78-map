import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const project = path.resolve(import.meta.dirname, "..");
const output = path.join(project, "desktop-build");
// Sign outside cloud-synced Documents: File Provider retags .app directories.
// Durable ZIP/DMG go into desktop-build; users install the app from the DMG.
const temporary = await mkdtemp(path.join(os.tmpdir(), "mirea-mac-build-"));
const app = path.join(temporary, "Карта МИРЭА.app");
const resources = path.join(app, "Contents/Resources");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: project, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message || result.status}`,
    );
};
if (process.platform !== "darwin")
  throw new Error("Для macOS .app нужен Mac с Xcode Command Line Tools.");
run("npm", ["run", "build"]);
run(process.execPath, ["scripts/mobile-package.mjs"]);
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
await rm(app, { recursive: true, force: true });
await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
await mkdir(resources, { recursive: true });
const sdk = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
  encoding: "utf8",
});
if (sdk.status !== 0) throw new Error("Не найден macOS SDK.");
const sources = [
  "desktop/mac/Sources/MapCore/AssetServer.swift",
  "desktop/mac/Sources/MapCore/MapPolicy.swift",
  "desktop/mac/NativeLocation.swift",
  "desktop/mac/MacApp.swift",
];
for (const arch of ["arm64", "x86_64"])
  run("xcrun", [
    "swiftc",
    "-O",
    "-sdk",
    sdk.stdout.trim(),
    "-target",
    `${arch}-apple-macos14.0`,
    "-module-cache-path",
    path.join(temporary, `module-cache-${arch}`),
    ...sources,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "-framework",
    "CoreLocation",
    "-framework",
    "Network",
    "-o",
    path.join(temporary, `MIREAMap-${arch}`),
  ]);
run("lipo", [
  "-create",
  path.join(temporary, "MIREAMap-arm64"),
  path.join(temporary, "MIREAMap-x86_64"),
  "-output",
  path.join(app, "Contents/MacOS/MIREAMap"),
]);
await cp(path.join(project, "dist"), path.join(resources, "public"), {
  recursive: true,
});
await cp(
  path.join(project, "desktop/mac/native-bridge.js"),
  path.join(resources, "native-bridge.js"),
);
await writeFile(
  path.join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ru.mirea.spatialatlas.mac</string>
<key>CFBundleExecutable</key><string>MIREAMap</string>
<key>CFBundleName</key><string>Карта МИРЭА</string>
<key>CFBundleDisplayName</key><string>Карта МИРЭА</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>NSLocationUsageDescription</key><string>По вашей кнопке показывать приблизительное положение на карте. Этаж и точное место можно указать вручную.</string>
<key>NSLocationWhenInUseUsageDescription</key><string>По вашей кнопке показывать приблизительное положение на карте, пока приложение открыто.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>ru.mirea.spatialatlas.mac</string><key>CFBundleURLSchemes</key><array><string>mireamap</string></array></dict></array>
</dict></plist>`,
);
const iconset = path.join(temporary, "AppIcon.iconset");
await mkdir(iconset, { recursive: true });
const icon = path.join(
  project,
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
);
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    run("sips", [
      "-z",
      String(size * scale),
      String(size * scale),
      icon,
      "--out",
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
    ]);
run("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  path.join(resources, "AppIcon.icns"),
]);
// Finder metadata copied with source images is not part of the signed app.
// Remove only these two packaging attributes; preserve quarantine and all others.
const attributes = spawnSync("xattr", ["-lr", app], { encoding: "utf8" });
if (attributes.status !== 0)
  throw new Error("Не удалось проверить метаданные приложения.");
for (const name of ["com.apple.FinderInfo", "com.apple.ResourceFork"])
  if (attributes.stdout.includes(name)) run("xattr", ["-dr", name, app]);
// File Provider can retag the bundle directory while its children are visited.
// Clear the directory's FinderInfo last, immediately before signing.
if (spawnSync("xattr", ["-p", "com.apple.FinderInfo", app]).status === 0)
  run("xattr", ["-d", "com.apple.FinderInfo", app]);
run("codesign", ["--force", "--options", "runtime", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
let count = 0;
async function verify(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      await verify(path.join(directory, entry.name), relative);
    else {
      if (
        hash(await readFile(path.join(directory, entry.name))) !==
        hash(await readFile(path.join(resources, "public", relative)))
      )
        throw new Error(`Stale Mac resource: ${relative}`);
      count++;
    }
  }
}
await verify(path.join(project, "dist"));
const zip = path.join(output, "MIREA-V78-Mac-universal.zip");
await rm(zip, { force: true });
run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", app, zip]);
const stage = path.join(temporary, "dmg");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(app, path.join(stage, "Карта МИРЭА.app"), { recursive: true });
await symlink("/Applications", path.join(stage, "Applications"));
const dmg = path.join(output, "MIREA-V78-Mac-universal.dmg");
run("hdiutil", [
  "create",
  "-volname",
  "Карта МИРЭА",
  "-srcfolder",
  stage,
  "-ov",
  "-format",
  "UDZO",
  dmg,
]);
const artifacts = [];
for (const file of [zip, dmg])
  artifacts.push({
    file: path.basename(file),
    bytes: (await readFile(file)).length,
    sha256: hash(await readFile(file)),
  });
await writeFile(
  path.join(output, "mac-build.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      app,
      architectures: ["arm64", "x86_64"],
      minimumMacOS: "14.0",
      resourcesVerified: count,
      signing: "ad-hoc; not Developer ID notarized",
      artifacts,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(output, "SHA256SUMS.txt"),
  artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
);
console.log(
  `Mac app ready: ${app}\nVerified ${count} packaged files.\nDMG: ${dmg}`,
);
