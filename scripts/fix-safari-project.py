"""Normalize only converter-generated Safari bundle identifiers."""
import pathlib
import json
import re
import sys

project, bundle_id = pathlib.Path(sys.argv[1]), sys.argv[2]
if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle_id):
    raise SystemExit("Invalid Safari bundle identifier")
pbxproj = next(project.glob("*.xcodeproj/project.pbxproj"))
text = pbxproj.read_text()

def replace_id(match):
    old = match.group(1).strip('"')
    suffix = ".Extension" if old.endswith(".Extension") else ""
    return f'PRODUCT_BUNDLE_IDENTIFIER = "{bundle_id}{suffix}";'

text, count = re.subn(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", replace_id, text)
if count != 4:
    raise SystemExit(f"Unexpected converter target layout: {count} bundle identifiers")
manifest = next(project.glob("* Extension/Resources/manifest.json"))
version = json.loads(manifest.read_text())["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit(f"Unsupported Safari version: {version}")
text = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {version};", text)
pbxproj.write_text(text)
