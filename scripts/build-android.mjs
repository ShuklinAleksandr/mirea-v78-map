import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  androidJavaCommand,
  androidSdkCandidates,
  inspectAndroidSdk,
  isSupportedJava,
  readAndroidRequirements,
  selectAndroidSdk,
} from "./mobile-doctor.mjs";

/** Encode a value for java.util.Properties.load(InputStream), including UTF-16. */
export function escapeJavaProperty(value) {
  let escaped = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const code = value.charCodeAt(index);
    if (char === "\\") escaped += "\\\\";
    else if (char === "\t") escaped += "\\t";
    else if (char === "\n") escaped += "\\n";
    else if (char === "\r") escaped += "\\r";
    else if (char === "\f") escaped += "\\f";
    else if (" =:#!".includes(char)) escaped += `\\${char}`;
    else if (code < 0x20 || code > 0x7e)
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += char;
  }
  return escaped;
}

export function sdkLocalProperties(existing, sdk) {
  const lines = [];
  let continuedSdk = false;
  for (const line of existing.split(/\r?\n/)) {
    const isSdk = /^\s*sdk\.dir(?:\s*[=:]|\s+)/.test(line);
    if (isSdk || continuedSdk) {
      const trailing = line.match(/\\+$/)?.[0].length || 0;
      continuedSdk = trailing % 2 === 1;
      continue;
    }
    lines.push(line);
  }
  while (lines.at(-1) === "") lines.pop();
  lines.push(`sdk.dir=${escapeJavaProperty(sdk)}`, "");
  return lines.join("\n");
}

function run() {
  const project = path.resolve(import.meta.dirname, "..");
  const requirements = readAndroidRequirements(project);
  const java = spawnSync(androidJavaCommand(), ["-version"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (!isSupportedJava(java)) {
    const details =
      java.error?.message || java.stderr || java.stdout || "Java не найдена";
    throw new Error(
      `Для Android требуется JDK 21+. Задайте JAVA_HOME на JDK 21 или новее. ${details.trim()}`,
    );
  }
  const selected = selectAndroidSdk(androidSdkCandidates(project), (sdk) =>
    inspectAndroidSdk(sdk, requirements),
  );
  if (!selected.ok) {
    const details = selected.rejected
      .map((candidate) => {
        const missing = candidate.checks
          .filter((check) => !check.ok)
          .map((check) => `  ${check.label}: ${check.detail}`)
          .join("\n");
        return `${candidate.source}: ${candidate.sdk}\n${missing}`;
      })
      .join("\n");
    throw new Error(
      `Нужен SDK текущей ОС: Android API ${requirements.compileSdk}, Build Tools ${requirements.buildTools}, platform-tools. Задайте ANDROID_HOME.\n${details}`,
    );
  }
  const propertiesPath = path.join(project, "android/local.properties");
  let existing = "";
  try {
    existing = readFileSync(propertiesPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(
    propertiesPath,
    sdkLocalProperties(existing, selected.sdk),
    "utf8",
  );
  console.log(
    `Android SDK: ${selected.sdk} (${selected.source}); android/local.properties обновлён.`,
  );
  const child = spawn(
    process.platform === "win32" ? "gradlew.bat" : "./gradlew",
    ["assembleDebug"],
    {
      cwd: path.join(project, "android"),
      env: {
        ...process.env,
        ANDROID_HOME: selected.sdk,
        ANDROID_SDK_ROOT: selected.sdk,
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
