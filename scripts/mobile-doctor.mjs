import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isSupportedJava(result) {
  if (result.status !== 0 || result.error) return false;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const version = output.match(
    /\b(?:java|openjdk)\s+(?:version\s+)?["']?(\d+)(?:\.(\d+))?/i,
  );
  if (!version) return false;
  // Java 8 reports 1.8.x; current JDKs use their major directly (21.x).
  const major =
    Number(version[1]) === 1 ? Number(version[2]) : Number(version[1]);
  return major >= 21;
}

export function androidJavaCommand(
  env = process.env,
  platform = process.platform,
) {
  return env.JAVA_HOME
    ? path.join(
        env.JAVA_HOME,
        "bin",
        platform === "win32" ? "java.exe" : "java",
      )
    : "java";
}

export function androidSdkCandidates(
  project,
  { env = process.env, platform = process.platform, home = os.homedir() } = {},
) {
  for (const source of ["ANDROID_HOME", "ANDROID_SDK_ROOT"])
    if (env[source])
      return [{ sdk: path.resolve(env[source]), source, explicit: true }];
  const standard =
    platform === "win32"
      ? path.join(
          env.LOCALAPPDATA || path.join(home, "AppData/Local"),
          "Android/Sdk",
        )
      : platform === "darwin"
        ? path.join(home, "Library/Android/sdk")
        : path.join(home, "Android/Sdk");
  return [
    { sdk: path.join(project, ".native-tools/android"), source: "project" },
    { sdk: standard, source: "Android Studio" },
    {
      sdk: path.join(project, ".native-tools/audit-android"),
      source: "local audit",
    },
  ];
}

export function selectAndroidSdk(candidates, inspectSdk) {
  const rejected = [];
  for (const candidate of candidates) {
    const result = { ...inspectSdk(candidate.sdk), ...candidate };
    if (result.ok) return { ...result, rejected };
    rejected.push(result);
    if (candidate.explicit) break;
  }
  return { ok: false, rejected };
}

export function readAndroidRequirements(project) {
  const variables = readFileSync(
    path.join(project, "android/variables.gradle"),
    "utf8",
  );
  const app = readFileSync(
    path.join(project, "android/app/build.gradle"),
    "utf8",
  );
  const build = readFileSync(
    path.join(project, "android/build.gradle"),
    "utf8",
  );
  const compileSdk = Number(
    app.match(/\bcompileSdk\s*=?\s*(\d+)/)?.[1] ||
      variables.match(/\bcompileSdkVersion\s*=\s*(\d+)/)?.[1],
  );
  const agp = build.match(/com\.android\.tools\.build:gradle:([^'"\s]+)/)?.[1];
  // AGP supplies this default when app/build.gradle does not override it.
  // https://developer.android.com/build/releases/agp-8-13-0-release-notes
  const agpDefaults = { "8.13.0": "35.0.0" };
  const buildTools =
    app.match(/\bbuildToolsVersion\s*=?\s*['"]([^'"]+)['"]/)?.[1] ||
    agpDefaults[agp];
  if (!Number.isInteger(compileSdk) || compileSdk <= 0 || !buildTools)
    throw new Error(
      "Не удалось определить compileSdk/buildTools из Android Gradle. Проверьте настройки проекта и требования AGP.",
    );
  return { compileSdk, buildTools, agp };
}

export function inspectAndroidSdk(
  sdk,
  requirements,
  { platform = process.platform, runCommand = spawnSync } = {},
) {
  const checks = [];
  const present = (file) => {
    try {
      return statSync(file).isFile() && statSync(file).size > 0;
    } catch {
      return false;
    }
  };
  function file(label, relative) {
    const location = path.join(sdk, relative);
    const ok = present(location);
    checks.push({
      label,
      ok,
      detail: ok ? location : `Не найден: ${location}`,
    });
    return ok;
  }
  function tool(label, relative, args, expected) {
    const location = path.join(sdk, relative);
    if (!present(location)) {
      checks.push({
        label,
        ok: false,
        detail: `Нет инструмента для ${platform}: ${location}`,
      });
      return;
    }
    const result = runCommand(location, args, {
      encoding: "utf8",
      timeout: 20000,
    });
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const ok = result.status === 0 && !result.error && expected.test(output);
    checks.push({
      label,
      ok,
      detail:
        result.error?.message ||
        output ||
        `Инструмент не запустился: ${location}`,
    });
  }
  const executable = platform === "win32" ? ".exe" : "";
  const script = platform === "win32" ? ".bat" : "";
  const tools = path.join("build-tools", requirements.buildTools);
  const metadata = path.join(sdk, tools, "source.properties");
  const revision = present(metadata)
    ? readFileSync(metadata, "utf8").match(/^Pkg\.Revision\s*=\s*(\S+)/m)?.[1]
    : null;
  checks.push({
    label: `Build Tools ${requirements.buildTools}: revision`,
    ok: revision === requirements.buildTools,
    detail: revision
      ? `${revision} (${metadata})`
      : `Не найдена версия пакета: ${metadata}`,
  });
  for (const name of ["android.jar", "core-for-system-modules.jar"])
    file(
      `Android API ${requirements.compileSdk}: ${name}`,
      path.join("platforms", `android-${requirements.compileSdk}`, name),
    );
  for (const name of [
    `aidl${executable}`,
    `zipalign${executable}`,
    `d8${script}`,
    `apksigner${script}`,
  ])
    file(
      `Build Tools ${requirements.buildTools}: ${name}`,
      path.join(tools, name),
    );
  tool(
    "adb",
    path.join("platform-tools", `adb${executable}`),
    ["version"],
    /Android Debug Bridge version/i,
  );
  tool(
    `aapt2 (Build Tools ${requirements.buildTools})`,
    path.join(tools, `aapt2${executable}`),
    ["version"],
    /Android Asset Packaging Tool/i,
  );
  return { sdk, ok: checks.every((check) => check.ok), checks };
}

function reportSdk(label, result) {
  console.log(`${result.ok ? "✓" : "!"} ${label}: ${result.sdk}`);
  for (const check of result.checks)
    console.log(`  ${check.ok ? "✓" : "!"} ${check.label}: ${check.detail}`);
}

function inspect(label, command, args, supported = () => true) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20000 });
  const ok = result.status === 0 && supported(result);
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  console.log(
    `${ok ? "✓" : "!"} ${label}: ${result.error?.message || output || "not available"}`,
  );
  return ok;
}

function run() {
  inspect("Node (requires 22.12+)", process.execPath, ["--version"]);
  const java = androidJavaCommand();
  inspect("Java (requires 21+)", java, ["-version"], isSupportedJava);
  if (process.platform === "darwin")
    inspect("Xcode (requires 26+)", "xcodebuild", ["-version"]);
  else console.log("! iOS builds require macOS and Xcode 26+");
  const project = path.resolve(import.meta.dirname, "..");
  let requirements;
  try {
    requirements = readAndroidRequirements(project);
  } catch (error) {
    console.log(`! Android SDK: ${error.message}`);
    return;
  }
  console.log(
    `Android: API ${requirements.compileSdk}, Build Tools ${requirements.buildTools} (AGP ${requirements.agp}).`,
  );
  const selected = selectAndroidSdk(androidSdkCandidates(project), (sdk) =>
    inspectAndroidSdk(sdk, requirements),
  );
  if (selected.ok) reportSdk(`Android SDK (${selected.source})`, selected);
  else
    for (const rejected of selected.rejected)
      reportSdk(`Android SDK (${rejected.source})`, rejected);
  console.log(
    "Для явного выбора SDK задайте ANDROID_HOME. Конфигурация сборки не изменялась.",
  );
  console.log(
    "Лицензии SDK и полную готовность сборки окончательно проверяет Gradle. Run npm run mobile:sync before opening native projects.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run();
