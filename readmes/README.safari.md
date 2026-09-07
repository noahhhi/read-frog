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

The app is `.safari/DerivedData/Build/Products/Release/Read Frog Safari.app`. Copy it into Applications, open it, and enable Read Frog in Safari's Extensions settings. Grant access to the websites you want to translate. Keep the same `SAFARI_BUNDLE_ID` across updates; the default is `app.readfrog.safari.local`. Increase `SAFARI_BUILD_NUMBER` for each installed update. Export your configuration before replacing a local development app: uninstalling or unregistering an extension can reset its local storage, including sign-in state.

Without `SAFARI_TEAM_ID`, the script creates an unsigned development build. Safari requires its developer setting for unsigned extensions in that case. Signed local development and App Store distribution have different requirements; this script does not publish an App Store release.

The packaging script fixes the Xcode 27 converter's inconsistent containing-app identifier, keeps app and extension versions aligned with the manifest, and defaults the macOS deployment target to 14.0. Override `SAFARI_MACOS_TARGET` if needed. Runtime verification has been performed on Safari 27/macOS 27; earlier versions and iOS are not certified by this work.

## Safari behavior

- Safari uses a nonpersistent background page and has no Chrome `offscreen` API. Speech uses the existing Edge TTS HTTP service, then decodes and plays audio in the page through Web Audio. The click handler resumes audio before asynchronous synthesis begins, respecting Safari's user-gesture requirement. Playback is scoped to the current page; Chrome and Firefox retain their existing background/offscreen playback.
- Page translation, selection translation, input injection, popup and options UI use the existing extension code.
- Google Drive sign-in uses a dedicated Safari tab to complete the same Google OAuth flow as Chrome. The callback must match the tab, exact registered origin/path and a random login state. Closing the sign-in tab cancels the attempt; timeout and navigation failure remove its listeners. Local configuration import/export and backups remain available.
- The upstream side-panel page is currently a placeholder. Safari has no Chrome `sidePanel` API; its permission and manifest entry are excluded. The normal floating translation button remains available.
- Xcode's converter may warn about `type`, `persistent`, and `world`. These are retained for the background-page and main-world content-script behavior; verify runtime behavior on each supported Safari release instead of removing them blindly.

## Google Drive configuration

Use the same `WXT_GOOGLE_CLIENT_ID` used for the upstream Chrome release. It is a public application identifier, not a user's Google password or access token. The upstream release pipeline injects it when building; a local source build can put it in the ignored `.env.safari.local` file. Installing an already configured Safari app does not require each user to create a Google Cloud project.

Safari defaults to the upstream Chrome extension's registered callback, `https://modkelfkcfjpgbfmnbnllalkiogfofhb.chromiumapp.org/`. If your own OAuth client registers a different HTTPS callback, set `WXT_GOOGLE_REDIRECT_URL` too. Keep client and callback paired: Google rejects an unregistered redirect. The Safari flow opens the real Google website in a regular tab, and observes only the tab it created. It does not embed Google's login page, request a client secret, use a local callback server, or add native messaging permissions.

Using the same upstream client preserves the Google application identity and requested scopes (`drive.appdata` and `userinfo.email`). It also keeps the current Chrome token behavior: the access token is used until near expiry, then a new sign-in flow runs. User authorization stays in extension-local storage. A separate Google Cloud project would represent a different application and should not be assumed to share the upstream app's backups.

## Validation

```sh
SKIP_FREE_API=true pnpm test
pnpm lint
pnpm fmt:check
pnpm build:safari
```

In Safari, verify page translation and restoration, selected-text streaming translation, the settings page, provider connection testing, input replacement on a test page, Google Drive upload/download readback, video subtitle translation during playback, and speech completion (not just a successful synthesis response). API availability requires a working provider; an HTTP success with empty model output is not sufficient proof.

References: [Apple's Safari extension overview](https://developer.apple.com/safari/extensions/), [WebKit's Manifest V3 support](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/), and [WXT browser targets](https://wxt.dev/guide/essentials/target-different-browsers).
