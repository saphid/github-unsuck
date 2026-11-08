"""Create a ready-to-extract, unpacked Chrome extension. No third-party packages."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "extension"
TARGET = ROOT / "dist" / "github-unsuck-extension.zip"

# Chrome's unpacked extension cannot import files outside its own folder.
# Keep URL validation identical to the service and gallery in every package.
(SOURCE / "service-runtime.js").write_bytes((ROOT / "shared" / "service-runtime.js").read_bytes())

manifest = json.loads((SOURCE / "manifest.json").read_text())
required = {
    manifest["background"]["service_worker"],
    manifest["action"]["default_popup"],
    *manifest["icons"].values(),
    *manifest["action"]["default_icon"].values(),
}
for name in required:
    if not (SOURCE / name).is_file():
        raise SystemExit(f"Missing extension file: {name}")

TARGET.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(TARGET, "w", ZIP_DEFLATED) as archive:
    for path in sorted(SOURCE.rglob("*")):
        if path.is_file() and not any(part.startswith(".") for part in path.relative_to(SOURCE).parts):
            archive.write(path, Path("github-unsuck-extension") / path.relative_to(SOURCE))
with ZipFile(TARGET) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Extension ZIP validation failed")
    print(f"Packaged {len(archive.namelist())} files: {TARGET}")
