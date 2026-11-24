<p align="center">
  <img src="build/icon.png" width="128" height="128" alt="Webscape Wanderer app icon: a blue globe with a gold orbit ring and a shooting star on a navy background">
</p>

<h1 align="center">Webscape Wanderer</h1>

<p align="center"><a href="https://github.com/ancientcomputing/webscape/actions/workflows/ci.yml"><img src="https://github.com/ancientcomputing/webscape/actions/workflows/ci.yml/badge.svg" alt="CI status"></a></p>

A private-by-default web browser built on Chromium. Every tab has its own memory, nothing about your browsing is written to disk except what you choose to keep, tabs are vertical, and passwords and bookmarks are built in. There are no extensions.

> Status: early prototype (v0.1). It works as a daily browser for basic use, but it hasn't had a security audit. See [Limitations](#limitations).

## What makes it different

| | |
|---|---|
| **Each tab has its own memory** | Every tab gets its own in-memory Chromium partition: its own cookies, localStorage, IndexedDB, cache and service workers. Tab A can't see that you're signed in on tab B, and trackers can't link the two. When you close a tab, its memory is wiped. |
| **Nothing is written to disk** | Tab partitions never get a `persist:` prefix, so Chromium keeps them in RAM only. When you quit, everything is gone. There's no history, no cookie jar and no session restore. The only things kept are passwords and bookmarks you choose to save, both encrypted. |
| **Vertical tabs** | Tabs are listed in a sidebar. Popups such as "Sign in with…" open as linked tabs, indented under the tab that opened them. |
| **Built-in password vault** | Saves and fills logins natively, with no extension involved. The vault is encrypted with the OS keychain and unlocked with Touch ID on Macs that have it. It fills only when you click, never automatically, and only on the site the login was saved for. It includes a password generator. |
| **Encrypted bookmarks** | Pages you bookmark are encrypted with the OS keychain, cleaned of tracking parameters, and opened in a fresh private tab. No history, visit counts or favicons are ever stored. |
| **Tracker blocking in the network layer** | Requests to ads and trackers are cancelled before they leave the browser, using Ghostery's filter engine and its prebuilt ads-and-tracking lists. |
| **No extensions** | Extensions are a major source of browser data leaks. Everything an extension would do here is built in. |

### Floating address box

The sidebar shows a compact address. Hover over it and the **whole address** appears in a wide box floating over the page, with the site's domain in bold so look-alike domains stand out. Click it, or press **⌘L**, and the same box becomes a full-width field for typing. Return goes there; Esc cancels. If you switch to another app, the box stays open with what you typed.

### Bookmarks

Bookmarks are treated like passwords: things you deliberately chose to keep, stored encrypted, and nothing else.

- **⌘D** or the **☆** in the address field bookmarks the page in **Favorites**. A filled ★ means it's already bookmarked; click it to remove the bookmark (with Undo).
- **Favorites** appear in the sidebar under your tabs, and as buttons on the Personal toolbar in Legacy mode.
- **⇧⌘B** opens the Bookmarks page to search, edit, organise into folders and delete. The **Bookmarks** menu lists them too.
- **The address box suggests matching bookmarks** as you type, from the list on your machine only, with no network lookup.
- **Opening a bookmark starts a fresh private tab** with its own empty memory. You won't be signed in, but the password vault offers to fill your login.
- **Tracking parameters are removed when you save** (`utm_*`, `fbclid`, `gclid`, `msclkid` and others), so saved links don't carry marketing tags.
- **Stored encrypted** in `bookmarks.bin` with the OS keychain. They unlock automatically at launch; turn on **Require Touch ID** on the Bookmarks page to keep them locked until you unlock them, with an automatic re-lock after 10 idle minutes.
- **Import and export** use the standard `bookmarks.html` format, whose header is still `NETSCAPE-Bookmark-file-1`. Any browser can read it. A browser's toolbar folder imports into Favorites, and nested folders are flattened (`Parent / Child`). Exported files are not encrypted.
- **Left out on purpose:** sync (it would need an account and a server), favicons (extra network requests) and "recently" or "most visited" (that's history by another name).

### Results or Answers (on-device AI)

Every DuckDuckGo search has two views, and a **Results | Answers** switch (in the sidebar and at the top of Answers, or **⇧⌘A**) flips between them:

- **Results** is DuckDuckGo's own page.
- **Answers** reads the top 8 results and ranks them by how likely each one answers your search. Each gets a score (High, Medium or Low), a short summary, and a quote from the page as evidence, so you can judge the score yourself. Click a title to open the page in a new tab, with your answers still there.

Searches open on **Results** by default, and nothing is analyzed until you switch to Answers. Tick **Open searches on Answers** (in the sidebar, or **View → Open Searches on Answers**) to land on Answers instead. Then every search is analyzed automatically. If the on-device model isn't available, searches simply open on Results.

How it stays private:

- **No extra request to DuckDuckGo:** the result list is read from the page you already loaded.
- **Private reading:** each result page is fetched once as plain HTML (no JavaScript, images or trackers) in a throwaway, cookie-less, in-memory session that's wiped right after.
- **Pages built with JavaScript:** if a page shows almost no text as plain HTML, it gets a second pass: rendered in a hidden, locked-down throwaway tab (tracker blocker on; images, media, fonts, pop-ups, permissions and downloads refused; sound muted), then read the same way. At most two at a time. These results say "read with JavaScript".
- **On this Mac:** the model is Apple's on-device model, run through the [LocalLM Lab SDK](https://github.com/ancientcomputing/locallm) by a small helper inside the app (`native/webscape-ai`). It talks to the browser over a pipe; nothing listens on a network port and nothing is sent to a cloud service.
- **Memory only:** answers live in the tab, like everything else, and disappear when you search again or close the tab.

**Listicles score 0.** "Top 10…", "15 best…" and similar pages go to the bottom, labelled "Listicle · scored 0". To avoid zeroing a good page, the title alone only counts when it's unmistakable (a small number before a superlative or list word, like "15 Best" or "10 Highest"). Otherwise the page needs numbered section headings *and* the model's judgement that it's a listicle, so a numbered step-by-step recipe isn't caught.

How a score is made: asked directly for a number, a small on-device model gives nearly every relevant page about 92. So instead it answers a short rubric of plain judgements (does the page answer it; how directly; how completely; how focused the page is), and the score is computed from that in code, together with two measurements of the page itself (how early the answer appears, and how much of the page covers the question). A quote that isn't actually in the page costs points and isn't shown. Each result lists its reasons, for example "Answers it · direct · detailed · focused".

`npm run eval:ranking` scores a hand-graded set of pages ([native/webscape-ai/eval](native/webscape-ai/eval)) and reports how well scores spread and order them. On it, the pages that answer the question went from a spread of 1.9 points and 56% correct order to a spread of 6.5 points and 86% correct order (95% across all pages), and listicle detection catches 4 of 4 with no false alarms, including a numbered recipe it must not flag. `npm run test:reader` checks the page reader against a local server, including that the JavaScript pass loads no images or pop-ups.

Needs a Mac with Apple Intelligence turned on (macOS 26 or later). Scores are the model's estimate, not a guarantee.

### Light and dark

The modern look follows your system's light or dark setting. To force one, use **View → Appearance** or the sun/moon button at the top of the sidebar. Web pages that support dark mode follow along.

### Legacy mode

Press **⇧⌘L**, or use **View → Legacy Mode**, for a mid-90s desktop-browser look:

![Webscape Wanderer in Legacy mode: gray beveled toolbar with Back, Forward, Reload, Home, Search, Passwords and Stop buttons, a Location bar, a list of private tabs on the left, and a status bar showing 25 trackers blocked](docs/screenshots/legacy-mode.png)

- gray `#C0C0C0` chrome with 3D bevels and 12px Verdana, legible on high-DPI screens
- a big labelled toolbar (Back, Forward, Reload, Home, Search, Passwords, Stop)
- a globe throbber that spins while pages load
- a `Location:` bar and a personal toolbar
- tabs in a classic list box with navy selection
- a status bar with a padlock, progress bar and tracker count
- a 1996-style start page, where you are always visitor number 000001

Switch back with **Modern look** on the personal toolbar. The look you choose is remembered. It's the only UI preference the browser saves.

Legacy mode is an original homage to that era and uses no third-party logos or artwork.

### Other hardening

- Sends `Sec-GPC: 1` (Global Privacy Control) and `DNT: 1` on every request.
- Turns off the WebRTC local-IP leak (`disable_non_proxied_udp`).
- Removes the `Electron/x` token from the user agent, so sites see standard Chrome.
- Turns off the spell checker, which would download dictionaries from Google.
- Asks before granting camera, microphone, location or screen sharing. A grant lasts only as long as the tab. Notifications and other permissions are denied.
- Shows letter avatars instead of favicons, so the browser UI never makes requests outside a tab's memory.
- Clears copied passwords from the clipboard after 30 seconds.
- Runs every page sandboxed with context isolation. The password helper runs in an isolated world that the page's own scripts can't reach.

## How tabs and memory work

```
┌────────────── Window ──────────────┐
│ Sidebar UI (local files only)      │
│                                    │
│  Tab 1 ── partition "tab-<uuid1>"  │  ← own cookies, storage, cache (RAM)
│  Tab 2 ── partition "tab-<uuid2>"  │  ← fully separate
│   └ popup ── shares "tab-<uuid2>"  │  ← sign-in popup keeps window.opener
└────────────────────────────────────┘
```

- **New tab, link opened in a new tab, middle-click:** gets a new, separate memory.
- **Scripted popup** (`window.open` with window features, used by OAuth and payment flows): shares the memory of the tab that opened it, so the sign-in flow can finish.
- **Close the last tab using a partition:** its storage, cache and HTTP auth are cleared right away.

## Passwords

1. Sign in on a site. When the form is submitted, the sidebar asks **Save password?**
2. Choose **Save** and confirm with Touch ID. The login is encrypted into `vault.bin` in the app's data folder.
3. The next time that site shows a password field, the sidebar offers **Fill password**.

The vault only saves and fills on `https://` origins, plus `http://localhost` for developers. It locks itself after 10 minutes without use. Open it with **⇧⌘P** to search, copy, delete, add logins or generate passwords.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘T / ⌘W | New private tab / close tab |
| ⌘L | Open the address box for typing |
| ⌘R / ⇧⌘R | Reload / reload ignoring cache |
| ⌘[ / ⌘] | Back / forward |
| ⌃Tab / ⌃⇧Tab | Next / previous tab |
| ⌘1…⌘9 | Jump to a tab (⌘9 = last) |
| ⇧⌘P | Open the password vault |
| ⇧⌘L | Toggle Legacy mode |
| ⇧⌘A | Switch a search between Results and Answers |
| ⌘D | Bookmark this page |
| ⇧⌘B | Show all bookmarks |
| ⌥⌘I | Developer tools for the current tab |

On Windows and Linux, use Ctrl instead of ⌘.

## Build and run

You need Node.js 20 or newer.

```bash
git clone https://github.com/ancientcomputing/webscape.git
cd webscape
npm install
npm start          # builds the TypeScript and the AI helper, then launches the browser
npm run build:ai   # builds just the on-device AI helper (Swift; needs Xcode on macOS)
npm run icon       # re-renders build/icon.png from build/icon.svg
npm run dist       # packages a .dmg / AppImage / installer into release/ with electron-builder
```

### Project layout

```
src/
  main/
    main.ts        app lifecycle, window, menu, IPC
    tabs.ts        TabManager: one WebContentsView + one in-memory partition per tab
    privacy.ts     per-session hardening: blocker, headers, permissions, preload
    vault.ts       encrypted password vault (safeStorage + Touch ID)
    insights.ts    Answers: reads search results privately, asks the AI helper to judge them
    page-reader.ts plain-HTML reading, plus the locked-down JavaScript pass
    ai.ts          starts and talks to the AI helper (JSON lines over stdin/stdout)
  preload/
    ui-preload.ts  narrow, allow-listed bridge for the sidebar
    page-preload.ts  login-form detection and fill, in an isolated world
  ui/              sidebar (HTML/CSS/TS), legacy.css (90s look), start page, error page,
                   reader.ts (turns fetched HTML into readable text, inertly)
  shared/types.ts  types shared by main and UI
native/webscape-ai/  on-device AI helper: Swift, LocalLM Lab SDK 3.0.0-GA (binary release)
build/             app icon (SVG source, PNG, ICNS)
scripts/           build helpers; dev-app-name.mjs names the dev Electron.app "Webscape Wanderer"
```

## What is stored on disk

| File | Contents |
|---|---|
| `vault.bin` | Your saved logins, encrypted with the OS keychain |
| `bookmarks.bin` | Your bookmarks, encrypted with the OS keychain |
| `blocker-engine.bin` | Compiled tracker filter lists (no personal data) |
| `settings.json` | UI preferences: look (modern or legacy, light or dark), whether bookmarks need Touch ID, whether searches open on Answers |
| Chromium housekeeping | GPU shader caches and the sidebar UI's own storage. Web pages never use this profile. |

The folder is `~/Library/Application Support/Webscape Wanderer` on macOS, `%APPDATA%` on Windows and `~/.config` on Linux.

## Limitations

- **Engine updates:** the browser uses Electron's bundled Chromium, which usually trails Chrome's security fixes by a few days to a few weeks. Dependabot checks for a new Electron every day and opens a pull request, and CI builds and smoke-tests it (see [Keeping the engine current](#keeping-the-engine-current)). Merge those pull requests promptly.
- **No extensions:** this is a design choice, and it won't change.
- **No sync:** passwords stay on this machine.
- **No Touch ID fallback:** on Macs without Touch ID, and on Windows and Linux, the vault is protected only by your OS login keychain. There is no extra prompt.
- **Fingerprinting:** tab isolation stops cookie and storage tracking. It doesn't stop browser fingerprinting.
- **Two-step logins:** sign-ins where the username and password are on separate pages may save without the username.
- **Unsigned builds:** builds aren't code-signed yet, so macOS asks you to approve them on first launch.

## Keeping the engine current

The browser engine is the `electron` package, which bundles Chromium. Electron releases a new major version about every 8 weeks and supports only the newest three, so an app that isn't updated stops getting security fixes within about six months.

- **Dependabot** ([.github/dependabot.yml](.github/dependabot.yml)) checks npm daily. Electron updates get their own pull request.
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) type-checks, builds, **smoke-tests** and runs the **vault** and **bookmarks** tests on every pull request on macOS. The smoke test launches the real browser and checks that the UI loads, that each tab gets its own in-memory session, and that the user agent doesn't reveal Electron.
- **Patch and minor updates** are mostly security fixes. Merge them as soon as CI is green.
- **Major updates** can change Electron's APIs. Merge them after CI passes and a quick manual check with `npm start`.

Run the checks locally with:

```bash
npm run build && WEBSCAPE_SMOKE_TEST=1 npx electron .   # smoke test
npm run test:vault                                     # password vault, via the real keychain
npm run test:bookmarks                                 # bookmarks, via the real keychain
```

The vault and bookmarks tests use their own keychain entries and a temporary folder, so they never touch your saved passwords or bookmarks.

## Contributing

Issues and pull requests are welcome. Please keep the core promise intact: **no browsing data on disk, no extensions, and no network requests that aren't made by the page you're viewing.** Report security problems privately (see [SECURITY.md](SECURITY.md)), not in public issues.

## License

[Apache License 2.0](LICENSE). Webscape Wanderer is an independent project and isn't affiliated with Netscape, AOL or Google.
