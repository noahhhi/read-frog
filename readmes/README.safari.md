# Read Frog for Safari on macOS

Build the extension from source with the repository's pnpm and Node versions:

```sh
pnpm install --frozen-lockfile
pnpm build:safari
```

The result is `.output/safari-mv3`. The build checks that its entry resources exist and that Chrome-only permissions did not leak into the Safari manifest.

## Create the macOS app

Install full Xcode, open it once to finish setup, and select it with `DEVELOPER_DIR` when your active developer directory points to Command Line Tools. For a signed local build, use a development team already configured in Xcode:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
SAFARI_TEAM_ID=YOUR_TEAM_ID \
pnpm package:safari
```

The app is `.safari/DerivedData/Build/Products/Release/Read Frog Safari.app`. Copy it into Applications, open it, and enable Read Frog in Safari's Extensions settings. Grant access to the websites you want to translate. Keep the same `SAFARI_BUNDLE_ID` across updates to preserve the extension's identity and preferences; the default is `app.readfrog.safari.local`.

Without `SAFARI_TEAM_ID`, the script creates an unsigned development build. Safari requires its developer setting for unsigned extensions in that case. Signed local development and App Store distribution have different requirements; this script does not publish an App Store release.

The packaging script fixes the Xcode 27 converter's inconsistent containing-app identifier, keeps app and extension versions aligned with the manifest, and defaults the macOS deployment target to 14.0. Override `SAFARI_MACOS_TARGET` if needed. Runtime verification has been performed on Safari 27/macOS 27; earlier versions and iOS are not certified by this work.

## Safari behavior

- A nonpersistent background page supplies the DOM-based audio fallback, since Safari has no Chrome `offscreen` API.
- Page translation, selection translation, input injection, popup and options UI use the existing extension code.
- Google Drive sign-in requires `browser.identity`, which Safari does not provide. The module now loads safely and reports the limitation when sign-in is requested. Local configuration import/export and backups remain available.
- The upstream side-panel page is currently a placeholder. Safari has no Chrome `sidePanel` API; its permission and manifest entry are excluded. The normal floating translation button remains available.
- Xcode's converter may warn about `type`, `persistent`, and `world`. These are retained for the background-page and main-world content-script behavior; verify runtime behavior on each supported Safari release instead of removing them blindly.

## Validation

```sh
SKIP_FREE_API=true pnpm test
pnpm lint
pnpm fmt:check
pnpm build:safari
```

In Safari, verify page translation and restoration, selected-text streaming translation, the settings page, provider connection testing, and input replacement on a test page. API availability requires a working provider; an HTTP success with empty model output is not sufficient proof.

References: [Apple's Safari extension overview](https://developer.apple.com/safari/extensions/), [WebKit's Manifest V3 support](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/), and [WXT browser targets](https://wxt.dev/guide/essentials/target-different-browsers).
