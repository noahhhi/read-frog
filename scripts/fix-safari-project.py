"""Configure converter-generated Safari identifiers and native account transport."""
import pathlib
import json
import re
import sys
import shutil

project, bundle_id = pathlib.Path(sys.argv[1]), sys.argv[2]
if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle_id):
    raise SystemExit("Invalid Safari bundle identifier")
project_bundle, = project.glob("*.xcodeproj")
manifest = next(project.glob("* Extension/Resources/manifest.json"))
version = json.loads(manifest.read_text())["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit(f"Unsupported Safari version: {version}")

def target_id(old):
    old = old.strip('"')
    return bundle_id + (".Extension" if old.endswith(".Extension") else "")

# Xcode 27.2 emits a JSON-like project with trailing commas. Older
# converters emit a pbxproj with separate settings for Debug and Release.
settings = project_bundle / "project.xcproj"
if settings.is_file():
    text = settings.read_text()
    text, count = re.subn(r'("PRODUCT_BUNDLE_IDENTIFIER": )"([^"]+)"',
                          lambda m: m[1] + json.dumps(target_id(m[2])), text)
    expected = 2
    text = re.sub(r'("MARKETING_VERSION": )"[^"]+"', lambda m: m[1] + json.dumps(version), text)
    text = re.sub(r'^ *"ENABLE_OUTGOING_NETWORK_CONNECTIONS": "YES",\n', "", text, flags=re.M)
    text = text.replace('"ENABLE_APP_SANDBOX": "YES",',
                        '"ENABLE_APP_SANDBOX": "YES",\n        "ENABLE_OUTGOING_NETWORK_CONNECTIONS": "YES",')
else:
    settings = project_bundle / "project.pbxproj"
    text = settings.read_text()
    text, count = re.subn(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);",
                          lambda m: f'PRODUCT_BUNDLE_IDENTIFIER = "{target_id(m[1])}";', text)
    expected = 4
    text = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {version};", text)
    text = re.sub(r"\s*ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;", "", text)
    text = text.replace("ENABLE_APP_SANDBOX = YES;", "ENABLE_APP_SANDBOX = YES;\n\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;")
if count != expected:
    raise SystemExit(f"Unexpected converter target layout: {count} bundle identifiers")
settings.write_text(text)

# Replace the converter echo handler (which logs payloads) with the narrowly
# scoped account transport. Credentials must never enter unified logging.
handler = next(project.glob("* Extension/SafariWebExtensionHandler.swift"))
shutil.copyfile(pathlib.Path(__file__).resolve().parent.parent / "native/safari/SafariWebExtensionHandler.swift", handler)
