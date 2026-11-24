# Webscape Wanderer: notes for Claude Code

A private-by-default browser built on Electron (Chromium), Apple Silicon first.
Repo: https://github.com/ancientcomputing/webscape (public, Apache-2.0).
The README covers features, layout and build steps; this file covers how we
work on it and what isn't obvious from the code.

## State as of 24 Nov 2026

- `main` is at the `v0.1.1` tag. CI is green. Nothing is in progress.
- Releases: [0.1.0](https://github.com/ancientcomputing/webscape/releases/tag/v0.1.0)
  and [0.1.1](https://github.com/ancientcomputing/webscape/releases/tag/v0.1.1)
  (Google sign-in fix, gmail.com crash fix, bigger window-drag area, About icon).
- Next planned feature: **shared tab memory**, see [ROADMAP.md](ROADMAP.md).
- Known loose ends:
  - README "Limitations" still says builds are unsigned. They are now signed and
    notarized; fix that line.
  - One moderate Dependabot alert: `minimatch`, pulled in by electron-builder
    only (build tooling, not shipped). Leave it for Dependabot/upstream.
  - Never tested by hand: Touch ID save and fill of passwords, and bookmarks
    Import/Export buttons in the app (the bookmarks test covers the code).

## How the user likes to work

- Commit and push only when asked ("Commit and push"). Work on `main`.
- **Never** add `Co-Authored-By`, "Generated with Claude Code" or any other
  Claude/Anthropic attribution to commits, PRs or release notes.
- The repo is public. Before every commit, check the staged files hold no
  personal details (names, email addresses, local `/Users/...` paths, machine
  names). For example: `git grep -i -e "/Users/" -e "@gmail" --cached`.
- Don't type into password fields or approve Touch ID / Keychain prompts; leave
  those to the user. GitHub actions that others can see (repo settings,
  comments) need the user's OK unless they asked for them.
- Verify in the real app before saying something works, and say plainly what
  wasn't tested.

## Setting up this Mac

1. Node 24 (CI uses 24; npm 11.19+). `npm ci` must pass with the committed
   lockfile. If npm complains the lockfile is out of sync, regenerate it with
   the same npm CI uses (`npx npm@11.19.1 install`) rather than your local npm,
   and check the diff only adds what you expect.
2. Xcode with Swift 6 for the on-device AI helper (`npm run build:ai`).
   Without it the browser still runs, minus Answers. Answers also needs
   Apple Intelligence turned on (macOS 26+).
3. `npm start` renames the dev Electron.app to "Webscape Wanderer" and swaps in
   our icon (`scripts/dev-app-name.mjs`), then builds and launches.
4. For releases only: the **Developer ID Application: ThisBrainAI LLC
   (MP7PDLDJ96)** certificate and its private key must be in this Mac's
   keychain (export as .p12 from the other Mac, import here), and a notarytool
   profile must exist:
   `xcrun notarytool store-credentials locallmlab-notary` (the user enters the
   Apple ID / app-specific password or API key themselves).

## Checks to run before committing

```bash
npm run typecheck
npm run build && WEBSCAPE_SMOKE_TEST=1 npx electron .   # prints SMOKE TEST PASSED
npx electron scripts/vault-test.cjs                     # VAULT TEST PASSED
npx electron scripts/bookmarks-test.cjs                 # BOOKMARKS TEST PASSED
npx electron scripts/reader-test.cjs                    # page reader (Answers)
```

CI (`.github/workflows/ci.yml`, macos-latest) runs all of these plus the AI
helper build. Dependabot opens daily npm PRs (Electron grouped) and weekly
Actions PRs; merge them when CI is green.

## Making a release

1. `npm version X.Y.Z --no-git-tag-version`.
2. Build, sign, notarize and staple (takes ~5 minutes; run it in the background):
   `CSC_NAME="ThisBrainAI LLC (MP7PDLDJ96)" APPLE_KEYCHAIN_PROFILE=locallmlab-notary scripts/release-mac.sh`
3. Open `release/mac-arm64/Webscape Wanderer.app` and check: About shows our
   globe icon and the new version, a few sites load, gmail.com reaches Google's
   sign-in page. Quit any dev copy first (see the single-instance note below).
4. Commit the version bump ("Release X.Y.Z"), tag `vX.Y.Z`, push both.
5. Copy the DMG to `Webscape-Wanderer-X.Y.Z-arm64.dmg` (hyphens, no spaces),
   write `Webscape-Wanderer-X.Y.Z-arm64.dmg.sha256` with `shasum -a 256`, and
   `gh release create vX.Y.Z <dmg> <sha256> --title "Webscape Wanderer X.Y.Z" --notes-file ... --latest`.
   Notes follow the earlier releases: what changed, Install, Requires, Verify.
6. Download the release back and check `shasum -a 256 -c` and
   `spctl --assess --type open --context context:primary-signature -vv <dmg>`
   (expect "Notarized Developer ID").

## Things learned the hard way

- **Google sign-in:** Google rejects a Chromium that claims to be Chrome or
  Firefox ("This browser or app may not be secure"). On `accounts.google.com`
  only, tabs send Electron's own unedited user agent, which Google accepts
  (`privacy.ts`: `isSignInHost`, `signInUserAgent`, `matchSignInIdentity`).
  Don't reintroduce spoofing there.
- **Never call `webContents.setUserAgent` mid-redirect** (`will-redirect`,
  `did-redirect-navigation`): it aborts the navigation or crashes Electron
  (SIGTRAP). Change it only in `did-start-navigation`; a sign-in page reached
  by redirect is reloaded once after `did-navigate`.
- **Tab memory:** every tab has its own in-memory partition (`tab-<uuid>`, no
  `persist:`). Pop-ups opened by a page share their opener's partition (needed
  for OAuth). A partition is cleared when its last tab closes. So Google asks
  for 2FA on every sign-in, and a sign-in lasts only in that tab.
- **Single instance:** the dev copy and the packaged app share the same
  user-data folder, so whichever starts second just quits. Quit one first.
- **About box icon (macOS):** `setAboutPanelOptions({iconPath})` is ignored on
  macOS; the panel uses the bundle icon. Packaged builds get `build/icon.icns`.
  For dev, `dev-app-name.mjs` copies it over `electron.icns` and re-registers
  the bundle with `lsregister -f`, since macOS caches icons.
- **Window dragging (modern look):** the whole sidebar is
  `-webkit-app-region: drag`; anything clickable opts out with `no-drag` in
  `styles.css`. New clickable sidebar elements must be covered by that rule.
- **Smoke test** (`WEBSCAPE_SMOKE_TEST=1`) uses a temp user-data folder and
  skips the single-instance lock, so it can run beside an open browser.
- **Computer-use background control can't move windows** (drags don't reach
  the window server). Check drag regions with `getComputedStyle(el)['-webkit-app-region']`
  and ask the user to try the real drag.
- `safeStorage` uses the async API (`encryptStringAsync`/`decryptStringAsync`);
  vaults written by the old sync API must still open (the vault test checks).
