#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# DEVELOPER_DIR can select Xcode without changing the machine-wide xcode-select.
: "${DEVELOPER_DIR:=$(xcode-select -p)}"
export DEVELOPER_DIR
xcrun --find safari-web-extension-converter >/dev/null
pnpm build:safari
mkdir -p .safari
project_root=$(mktemp -d "$PWD/.safari/project.XXXXXX")
app_name="Read Frog Safari"
bundle_id="${SAFARI_BUNDLE_ID:-app.readfrog.safari.local}"
xcrun safari-web-extension-converter "$PWD/.output/safari-mv3" \
  --project-location "$project_root" --app-name "$app_name" \
  --bundle-identifier "$bundle_id" --macos-only --swift --copy-resources \
  --no-open --no-prompt

# Xcode 27's converter can rewrite the containing app ID independently of its
# extension. Pin both generated target IDs so installation preserves extension data.
# Xcode unconditionally registers the intermediate macOS app, even when
# archiving. Give that intermediate its own identity and storage namespace.
python3 scripts/fix-safari-project.py "$project_root/$app_name" "$bundle_id.buildstage"

signing=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  signing=(CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development"
    DEVELOPMENT_TEAM="$SAFARI_TEAM_ID" -allowProvisioningUpdates)
fi
archive="$project_root/Read Frog Safari.xcarchive"
# Xcode registers the intermediate app even for archives, then moves it into
# the archive. Remove only that transient registration, including on failure.
intermediate="$PWD/.safari/DerivedData/Build/Intermediates.noindex/ArchiveIntermediates/$app_name/InstallationBuildProductsLocation/Applications/$app_name.app"
unregister_intermediate() {
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$intermediate" >/dev/null 2>&1 || true
}
trap unregister_intermediate EXIT
xcodebuild -project "$project_root/$app_name/$app_name.xcodeproj" \
  -scheme "$app_name" -configuration Release \
  -derivedDataPath "$PWD/.safari/DerivedData" \
  -archivePath "$archive" \
  -destination "generic/platform=macOS" \
  CURRENT_PROJECT_VERSION="${SAFARI_BUILD_NUMBER:-1}" \
  MACOSX_DEPLOYMENT_TARGET="${SAFARI_MACOS_TARGET:-14.0}" "${signing[@]}" archive
app_path="$archive/Products/Applications/$app_name.app"
extension="$app_path/Contents/PlugIns/$app_name Extension.appex"
# Only the finished archive receives the installed identities. These local
# development builds use sandbox entitlements and no provisioning profile.
if [[ -e "$app_path/Contents/embedded.provisionprofile" || -e "$extension/Contents/embedded.provisionprofile" ]]; then
  echo "Cannot retarget a provisioned Safari archive" >&2
  exit 1
fi
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  (cd "$project_root" && codesign -d --extract-certificates "$app_path")
  signing_identity=$(shasum -a 1 "$project_root/codesign0" | awk '{print $1}')
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id.Extension" "$extension/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app_path/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :ApplicationProperties:CFBundleIdentifier $bundle_id" "$archive/Info.plist"
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  for target in "$extension" "$app_path"; do
    codesign --force --sign "$signing_identity" --preserve-metadata=entitlements,flags,runtime "$target"
  done
fi
resources="$extension/Contents/Resources"
# The converter registers folders separately. Verify nested runtime chunks too.
while IFS= read -r -d '' file; do
  cmp ".output/safari-mv3/$file" "$resources/${file#./}"
done < <(cd .output/safari-mv3 && find . -type f -print0)
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  codesign --verify --deep --strict "$app_path"
fi
printf '\nSafari app: %s\n' "$app_path"
