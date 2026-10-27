"""Create a portable source ZIP. No local SDKs, stale binaries or signing files."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import zipfile


ROOT_FILES = {
    ".editorconfig", ".gitattributes", ".gitignore", ".nvmrc", ".prettierignore",
    "capacitor.config.json", "index.html", "jsconfig.json",
    "package.json", "package-lock.json", "README.md", "CONTRIBUTING.md", "vite.config.js",
    "BUILD_ON_MAC.txt", "PROMPT_FOR_BUILD_PC.txt", "STAIRS_TODO_FOR_MAC.txt",
    "XCODE_IPHONE.md", "ВОПРОСЫ_ПО_КАРТЕ.md",
}
TREES = {".github", "src", "public", "scripts", "tests", "docs", "tools", "android", "ios"}
EXCLUDED_DIRS = {
    "node_modules", "build", ".gradle", ".idea", "Pods", "DerivedData",
    "xcuserdata", ".swiftpm", ".build", "__pycache__", ".git",
}
EXCLUDED_FILES = {
    ".DS_Store", "local.properties", "capacitor.config.json",
    "capacitor.plugins.json",
    "key.properties", "keystore.properties",
}
SECRET_SUFFIXES = {".jks", ".keystore", ".p12", ".p8", ".pfx", ".key", ".pem", ".mobileprovision"}


def included(relative: Path) -> bool:
    parts = relative.parts
    if len(parts) == 1:
        return relative.name in ROOT_FILES
    if parts[0] not in TREES and parts[:2] != ("source", "maps"):
        return False
    if any(part in EXCLUDED_DIRS for part in parts):
        return False
    if relative.name in EXCLUDED_FILES or relative.name.startswith(".env"):
        return False
    if relative.suffix.lower() in SECRET_SUFFIXES | {".pyc", ".apk", ".aab", ".ipa"}:
        return False
    # Capacitor sync recreates these copies from dist and installed packages.
    if parts[:6] == ("android", "app", "src", "main", "assets", "public"):
        return False
    if parts[:4] == ("ios", "App", "App", "public"):
        return False
    if parts[:2] == ("android", "capacitor-cordova-android-plugins"):
        return False
    return True


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    project = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    if output.exists():
        raise SystemExit(f"Output already exists: {output}")
    candidates = [project / name for name in ROOT_FILES]
    for root_name in [*sorted(TREES), "source/maps"]:
        for directory, folders, names in os.walk(project / root_name):
            folders[:] = sorted(folder for folder in folders if folder not in EXCLUDED_DIRS)
            candidates.extend(Path(directory) / name for name in names)
    files = sorted(
        (file for file in candidates if file.is_file() and included(file.relative_to(project))),
        key=lambda file: file.relative_to(project).as_posix(),
    )
    missing = sorted(name for name in ROOT_FILES if not (project / name).is_file())
    if missing:
        raise SystemExit(f"Missing handoff files: {missing}")
    entries = []
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file in files:
            relative = file.relative_to(project).as_posix()
            if file.is_symlink():
                raise SystemExit(f"Unexpected source symlink: {relative}")
            data = file.read_bytes()
            info = zipfile.ZipInfo(f"mirea-v78-map/{relative}")
            info.create_system = 3
            mode = 0o755 if relative == "android/gradlew" else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, data)
            entries.append({"path": relative, "bytes": len(data), "sha256": sha256(data)})
        manifest = {
            "format": 1,
            "project": "mirea-v78-map",
            "date": datetime.now(timezone.utc).date().isoformat(),
            "purpose": "GitHub repository source; browser, Android and iOS development",
            "files": entries,
        }
        bundle.writestr("mirea-v78-map/HANDOFF_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    # Verify the actual ZIP, including every decompressed file and its source hash.
    with zipfile.ZipFile(output) as bundle:
        damaged = bundle.testzip()
        if damaged:
            raise SystemExit(f"ZIP CRC failure: {damaged}")
        for entry in entries:
            data = bundle.read(f"mirea-v78-map/{entry['path']}")
            if sha256(data) != entry["sha256"]:
                raise SystemExit(f"ZIP hash failure: {entry['path']}")
    digest = sha256(output.read_bytes())
    output.with_suffix(output.suffix + ".sha256").write_text(f"{digest}  {output.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(output), "files": len(entries), "sourceBytes": sum(entry["bytes"] for entry in entries), "zipBytes": output.stat().st_size, "sha256": digest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
