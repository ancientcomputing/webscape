import { dialog, Session, BaseWindow } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_PRELOAD = path.join(__dirname, '../preload/page-preload.js');

/** Permissions granted silently. Everything else is denied or asked for. */
const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
/** Permissions the user is asked about. A yes lasts only as long as the tab's memory. */
const ASK = new Map<string, string>([
  ['media', 'use your camera and/or microphone'],
  ['geolocation', 'know your location'],
  ['display-capture', 'see your screen'],
]);

let blocker: ElectronBlocker | null = null;
const blockedCounts = new Map<number, number>();
const configured = new WeakSet<Session>();
const granted = new WeakMap<Session, Set<string>>();

/**
 * Load the Ghostery ads-and-tracking filter lists. The compiled engine is cached
 * on disk (it contains filter rules only, nothing about you). Pages load
 * unfiltered for the second or two before it is ready on first launch.
 */
export async function initBlocker(cacheDir: string): Promise<void> {
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(cacheDir, 'blocker-engine.bin'),
      read: fs.readFile,
      write: fs.writeFile,
    });
  } catch (err) {
    console.warn('[webscape] tracker blocker failed to load:', err);
  }
}

export function blockedCount(webContentsId: number): number {
  return blockedCounts.get(webContentsId) ?? 0;
}

export function forgetBlockedCount(webContentsId: number): void {
  blockedCounts.delete(webContentsId);
}

/** Make a Chrome-looking user agent: drop the "Electron/x" and app tokens that break sign-in pages and aid fingerprinting. */
export function cleanUserAgent(ua: string): string {
  // Electron also appends "<app name>/<version>"; drop any token for this app.
  return ua.replace(/ Electron\/\S+/, '').replace(/ webscape[\w -]*\/[\d.]+/gi, '');
}

/**
 * Harden a tab's in-memory session. Called once per session; popups that share
 * their opener's session reuse it.
 */
export function setupSession(ses: Session, getWindow: () => BaseWindow | null, onBlocked: (webContentsId: number) => void): void {
  if (configured.has(ses)) return;
  configured.add(ses);
  granted.set(ses, new Set());

  // The spell checker downloads dictionaries from Google; keep it off.
  ses.setSpellCheckerEnabled(false);

  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    return ALWAYS_ALLOW.has(permission) || granted.get(ses)!.has(`${origin}|${permission}`);
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALWAYS_ALLOW.has(permission)) return callback(true);
    const what = ASK.get(permission);
    if (!what || !wc) return callback(false);
    let origin: string;
    try {
      origin = new URL(details.requestingUrl).origin;
    } catch {
      return callback(false);
    }
    const key = `${origin}|${permission}`;
    if (granted.get(ses)!.has(key)) return callback(true);
    const win = getWindow();
    const opts = {
      type: 'question' as const,
      buttons: ['Block', 'Allow for this tab'],
      defaultId: 0,
      cancelId: 0,
      message: `${new URL(origin).host} wants to ${what}.`,
      detail: 'If you allow it, the permission is forgotten when you close this tab.',
    };
    (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
      const ok = response === 1;
      if (ok) granted.get(ses)!.add(key);
      callback(ok);
    });
  });

  // Network-level tracker blocking (no browser extension involved).
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!blocker) return callback({});
    blocker.onBeforeRequest(details, (response) => {
      if ((response.cancel || response.redirectURL) && details.webContentsId !== undefined) {
        blockedCounts.set(details.webContentsId, blockedCount(details.webContentsId) + 1);
        onBlocked(details.webContentsId);
      }
      callback(response);
    });
  });

  // Global Privacy Control + Do Not Track on every request.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['Sec-GPC'] = '1';
    headers['DNT'] = '1';
    callback({ requestHeaders: headers });
  });

  // Login-form detection and password autofill, running in an isolated world.
  ses.registerPreloadScript({ type: 'frame', id: 'webscape-page', filePath: PAGE_PRELOAD });
}

/**
 * Lock down a throwaway session used to render a page nobody sees (the
 * JavaScript reading pass for Answers). Stricter than a tab: every permission is
 * refused without asking, downloads are cancelled, trackers are blocked, and
 * nothing is loaded except the page's own scripts, styles and data (images,
 * media and fonts are refused).
 */
export function hardenReaderSession(ses: Session): void {
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  const SKIP = new Set(['image', 'media', 'font', 'object', 'ping', 'cspReport']);
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!/^https?:/i.test(details.url) && !details.url.startsWith('data:')) return callback({ cancel: true });
    if (SKIP.has(details.resourceType)) return callback({ cancel: true });
    if (!blocker) return callback({});
    blocker.onBeforeRequest(details, callback);
  });
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['Sec-GPC'] = '1';
    headers['DNT'] = '1';
    callback({ requestHeaders: headers });
  });
}
