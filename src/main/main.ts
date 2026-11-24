import { app, BaseWindow, clipboard, dialog, ipcMain, IpcMainEvent, IpcMainInvokeEvent, Menu, nativeTheme, WebContentsView } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppState, Bookmark, BookmarkData, NavAction, SavePrompt, ThemeSetting, UICommand, VaultEntrySummary } from '../shared/types';
import { BookmarkStore, cleanUrl, FAVORITES } from './bookmarks';
import { AIHelper } from './ai';
import { Insights, searchQuery } from './insights';
import { cleanUserAgent, initBlocker } from './privacy';
import { resolveInput, startPageUrl, TabManager } from './tabs';
import { fillableOrigin, Vault } from './vault';

app.setName('Webscape Wanderer');
const SMOKE_TEST = process.env.WEBSCAPE_SMOKE_TEST === '1';
if (SMOKE_TEST) {
  // Run isolated: a throwaway data folder, and no clash with a browser you have open.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'webscape-smoke-')));
}
const ICON = path.join(__dirname, '../../build/icon.png');
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

/**
 * Where the page sits inside the window, as insets from each edge. The sidebar
 * UI measures its page slot and reports these (ui:layout), so each look can lay
 * out its own chrome. This default matches the modern look until it reports.
 */
let insets = { left: 272, top: 8, right: 8, bottom: 8 };

// ---------------------------------------------------------------------------
// Settings: UI preferences only (never browsing data).
// ---------------------------------------------------------------------------
interface Settings {
  legacy: boolean;
  theme: ThemeSetting;
  /** Keep bookmarks locked until Touch ID. */
  bookmarksTouchID: boolean;
}
let settings: Settings = { legacy: false, theme: 'system', bookmarksTouchID: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>;
    settings = {
      legacy: raw.legacy === true,
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      bookmarksTouchID: raw.bookmarksTouchID === true,
    };
  } catch {
    /* first run */
  }
}

function saveSettings(): void {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/** Background behind the UI while it paints: legacy gray, or the modern theme's base color. */
function chromeColor(): string {
  if (settings.legacy) return '#c0c0c0';
  return nativeTheme.shouldUseDarkColors ? '#15171e' : '#eceef3';
}

/**
 * Light / dark / follow the system. Setting nativeTheme.themeSource also sets
 * prefers-color-scheme for the sidebar, the start page and web pages, so sites
 * that support dark mode follow along.
 */
function setTheme(theme: ThemeSetting): void {
  settings.theme = theme;
  nativeTheme.themeSource = theme;
  saveSettings();
  buildMenu();
  pushState();
}

function setLegacy(on: boolean): void {
  if (settings.legacy === on) return;
  settings.legacy = on;
  saveSettings();
  tabs?.setLegacy(on);
  ui?.setBackgroundColor(chromeColor());
  placeWindowButtons();
  buildMenu();
  pushState();
}
const CLIPBOARD_CLEAR_MS = 30_000;

let win: BaseWindow | null = null;
let ui: WebContentsView | null = null;
/** The floating address box (modern look): a small transparent view stacked above the page. */
let popover: WebContentsView | null = null;
let popoverMode: 'peek' | 'edit' | null = null;
let popoverHeight = 64;
let tabs: TabManager | null = null;
let vault: Vault | null = null;
let ai: AIHelper | null = null;
let insights: Insights | null = null;
let bookmarks: BookmarkStore | null = null;
/** The last bookmark removed with the star, for Undo. */
let lastRemovedBookmark: Bookmark | null = null;

/** Logins captured from a form submit, waiting for the user to say Save or Not now. Never written anywhere. */
const pending = new Map<number, SavePrompt & { password: string }>();

// ---------------------------------------------------------------------------
// State pushed to the sidebar UI (coalesced to one message per tick)
// ---------------------------------------------------------------------------

let stateQueued = false;
function pushState(): void {
  if (stateQueued) return;
  stateQueued = true;
  setImmediate(() => {
    stateQueued = false;
    if (!ui || ui.webContents.isDestroyed()) return;
    const st = buildState();
    ui.webContents.send('state', st);
    if (popover && !popover.webContents.isDestroyed()) popover.webContents.send('state', st);
    const active = tabs?.active;
    if (win && !win.isDestroyed()) win.setTitle(active ? `${active.title} — Webscape Wanderer` : 'Webscape Wanderer');
  });
}

function buildState(): AppState {
  const active = tabs?.active;
  if (tabs && insights) insights.prune(new Set(tabs.tabs.map((t) => t.id)));
  const origin = active ? fillableOrigin(active.url) : null;
  const prompt = active ? pending.get(active.id) : undefined;
  return {
    tabs: tabs?.state() ?? [],
    activeId: tabs?.activeId ?? null,
    vaultUnlocked: vault?.unlocked ?? false,
    vaultAvailable: vault?.available ?? false,
    legacy: settings.legacy,
    bookmarks: {
      available: bookmarks?.available ?? false,
      unlocked: bookmarks?.unlocked ?? false,
      touchIDRequired: bookmarks?.touchIDRequired ?? false,
      activeId: active && bookmarks?.unlocked ? bookmarks.idForUrl(active.url) : null,
    },
    theme: settings.theme,
    dark: nativeTheme.shouldUseDarkColors,
    loginForm: active?.hasLoginForm && origin ? { origin } : null,
    savePrompt: prompt ? { tabId: prompt.tabId, origin: prompt.origin, username: prompt.username, update: prompt.update } : null,
    search: active && searchQuery(active.url) ? { query: searchQuery(active.url)! } : null,
    insights: active && insights ? insights.state(active.id, active.url) : null,
  };
}

/** A short message in the sidebar. action 'undo' adds an Undo button (for removed bookmarks). */
function toast(text: string, action?: 'undo'): void {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('toast', { text, action });
}

/** Bookmarks changed (or locked/unlocked): refresh the UI, the address box and the menu. */
let bookmarksQueued = false;
function bookmarksChanged(): void {
  pushState();
  if (bookmarksQueued) return;
  bookmarksQueued = true;
  setImmediate(() => {
    bookmarksQueued = false;
    const snap = bookmarks?.snapshot() ?? null;
    for (const v of [ui, popover]) if (v && !v.webContents.isDestroyed()) v.webContents.send('bookmarks', snap);
    buildMenu();
  });
}

/** Open bookmarks in a fresh private tab (its own empty memory), or in the current tab. */
function openBookmarkUrl(url: string, where: 'new' | 'current' = 'new'): void {
  const clean = cleanUrl(url);
  if (!clean || !tabs) return;
  if (where === 'current' && tabs.active) tabs.active.view.webContents.loadURL(clean).catch(() => {});
  else tabs.create(clean);
}

async function bookmarkActivePage(mode: 'toggle' | 'add'): Promise<void> {
  const tab = tabs?.active;
  if (!tab || !bookmarks) return;
  if (!cleanUrl(tab.url)) return toast("This page can't be bookmarked");
  if (!bookmarks.available) return toast('Bookmarks need the system keychain');
  if (!(await bookmarks.unlock('add a bookmark'))) return toast('Bookmarks stayed locked');
  const existing = bookmarks.idForUrl(tab.url);
  if (existing && mode === 'add') return toast('Already bookmarked');
  if (existing) {
    lastRemovedBookmark = (await bookmarks.remove(existing)) ?? null;
    return toast('Bookmark removed', 'undo');
  }
  await bookmarks.add({ url: tab.url, title: tab.title, folder: FAVORITES });
  toast(`Bookmarked in ${FAVORITES}`);
}

async function exportBookmarks(): Promise<string | null> {
  if (!win || !bookmarks || !(await bookmarks.unlock('export your bookmarks'))) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Bookmarks',
    defaultPath: path.join(app.getPath('downloads'), 'bookmarks.html'),
    filters: [{ name: 'Bookmarks file', extensions: ['html'] }],
  });
  if (canceled || !filePath) return null;
  await fs.promises.writeFile(filePath, bookmarks.exportHtml(), { mode: 0o600 });
  toast('Bookmarks exported (the file is not encrypted)');
  return filePath;
}

async function importBookmarks(): Promise<{ added: number; skipped: number } | null> {
  if (!win || !bookmarks || !(await bookmarks.unlock('import bookmarks'))) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Bookmarks',
    properties: ['openFile'],
    filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePaths[0]) return null;
  const stat = await fs.promises.stat(filePaths[0]);
  if (stat.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a bookmarks file.');
  const result = await bookmarks.importHtml(await fs.promises.readFile(filePaths[0], 'utf8'));
  toast(`Imported ${result.added} bookmark${result.added === 1 ? '' : 's'}${result.skipped ? ` (${result.skipped} skipped)` : ''}`);
  return result;
}

function sendCommand(cmd: UICommand): void {
  if (!ui) return;
  ui.webContents.focus();
  ui.webContents.send('command', cmd);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** macOS window buttons: centred in the legacy title bar, or floating over the modern sidebar. */
function placeWindowButtons(): void {
  if (process.platform !== 'darwin' || !win) return;
  win.setWindowButtonPosition(settings.legacy ? { x: 9, y: 9 } : { x: 16, y: 18 });
}

function contentBounds(): Electron.Rectangle {
  const { width, height } = win!.getContentBounds();
  const { left, top, right, bottom } = insets;
  return { x: left, y: top, width: Math.max(0, width - left - right), height: Math.max(0, height - top - bottom) };
}

function createWindow(): void {
  win = new BaseWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 480,
    title: 'Webscape Wanderer',
    backgroundColor: chromeColor(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
  });

  placeWindowButtons();

  ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/ui-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  ui.setBackgroundColor(chromeColor());
  win.contentView.addChildView(ui);
  // The sidebar only ever shows our own local files.
  ui.webContents.on('will-navigate', (e) => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ui.webContents.loadFile(path.join(__dirname, '../ui/index.html'));

  const layout = () => {
    const { width, height } = win!.getContentBounds();
    ui!.setBounds({ x: 0, y: 0, width, height });
    tabs?.layout();
  };

  tabs = new TabManager(win, contentBounds, pushState, () => sendCommand('focus-address'));
  tabs.legacy = settings.legacy;
  layout();
  win.on('resize', () => {
    layout();
    if (popoverMode) placePopover();
  });
  win.on('blur', () => {
    if (popoverMode === 'peek') closePopover(false);
  });
  win.on('closed', () => {
    win = null;
    popover = null;
    ui = null;
    tabs = null;
  });

  createPopover();

  ui.webContents.once('did-finish-load', () => {
    const first = tabs!.create();
    sendCommand('focus-address');
    if (SMOKE_TEST) void runSmokeTest(first.view.webContents);
  });
}

// ---------------------------------------------------------------------------
// Smoke test (CI): WEBSCAPE_SMOKE_TEST=1 launches the browser, checks the
// essentials, prints the result and quits with exit code 0 or 1. CI runs it on
// every pull request, including automated Electron (Chromium) upgrades.
// ---------------------------------------------------------------------------

function smokeFail(reason: unknown): void {
  console.error('SMOKE TEST FAILED:', reason);
  app.exit(1);
}

if (SMOKE_TEST) {
  process.on('uncaughtException', smokeFail);
  process.on('unhandledRejection', smokeFail);
  setTimeout(() => smokeFail('timed out after 60 s'), 60_000).unref();
}

/** Resolves once a view has a page and has stopped loading. Polls, so it can't miss an event. */
function loaded(wc: Electron.WebContents): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => (wc.getURL() && !wc.isLoading() ? resolve() : setTimeout(poll, 100));
    poll();
  });
}

async function runSmokeTest(tab: Electron.WebContents): Promise<void> {
  const checks: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) throw new Error(what);
    checks.push(what);
  };
  try {
    // Wait for every view: on slow machines they finish in any order.
    await Promise.all([loaded(ui!.webContents), loaded(popover!.webContents), loaded(tab)]);
    check(!ui!.webContents.isCrashed(), 'sidebar UI loaded');
    check(!popover!.webContents.isCrashed() && popover!.webContents.getURL().endsWith('address.html'), 'address box loaded');
    check(tab.getURL().includes('newtab.html'), 'first tab shows the start page');
    // The core privacy promise: tab storage must never be persisted to disk.
    check(!tab.session.isPersistent(), 'tab session is in-memory only');
    check(tab.session !== tabs!.create(undefined, { background: true }).view.webContents.session, 'each tab gets its own session');
    check(/Chrome\/\d+/.test(tab.getUserAgent()) && !/Electron/.test(tab.getUserAgent()), 'user agent looks like Chrome, not Electron');
    console.log(`SMOKE TEST PASSED (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`);
    for (const c of checks) console.log(`  ✓ ${c}`);
    app.exit(0);
  } catch (err) {
    smokeFail(err);
  }
}

// ---------------------------------------------------------------------------
// IPC from the sidebar UI. Every handler checks the sender is our own UI.
// ---------------------------------------------------------------------------

function fromUI(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  for (const v of [ui, popover]) {
    if (v && e.sender === v.webContents && e.senderFrame === v.webContents.mainFrame) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Floating address box
// ---------------------------------------------------------------------------

/** Room around the box for its drop shadow (the view itself is transparent). */
const POPOVER_PAD = 10;
let popoverAnchor = { x: 12, y: 52 };

function createPopover(): void {
  popover = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/ui-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  popover.setBackgroundColor('#00000000');
  popover.webContents.on('will-navigate', (e) => e.preventDefault());
  popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popover.webContents.loadFile(path.join(__dirname, '../ui/address.html'));
  // Close the editor when focus moves elsewhere in the browser, but keep it
  // (and what you typed) when you just switch to another app.
  popover.webContents.on('blur', () => {
    setTimeout(() => {
      if (popoverMode === 'edit' && win?.isFocused() && !popover?.webContents.isFocused()) closePopover(false);
    }, 60);
  });
}

function placePopover(): void {
  if (!win || !popover) return;
  const { width } = win.getContentBounds();
  const x = Math.max(0, popoverAnchor.x - POPOVER_PAD);
  const y = Math.max(0, popoverAnchor.y - POPOVER_PAD);
  // Stretch across the window so the whole address is visible.
  const w = Math.max(320, Math.min(width - x - 8, 1200));
  popover.setBounds({ x, y, width: w, height: popoverHeight });
}

function openPopover(mode: 'peek' | 'edit', anchor?: { x: number; y: number }): void {
  if (!win || !popover || settings.legacy) return;
  if (anchor) popoverAnchor = anchor;
  // Don't downgrade an open editor to a peek.
  if (popoverMode === 'edit' && mode === 'peek') return;
  popoverMode = mode;
  win.contentView.addChildView(popover); // (re)adding puts it on top of the page
  placePopover();
  popover.webContents.send('popover', { mode, pad: POPOVER_PAD });
  if (mode === 'edit') popover.webContents.focus();
}

function closePopover(refocusPage: boolean): void {
  if (!win || !popover || !popoverMode) return;
  popoverMode = null;
  win.contentView.removeChildView(popover);
  if (refocusPage) tabs?.active?.view.webContents.focus();
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, (e, ...args) => {
    if (!win) return undefined; // window already closed (shutting down)
    if (!fromUI(e)) throw new Error('Not allowed');
    return fn(...(args as T));
  });
}

/** Copy a secret and clear it from the clipboard after 30 s unless something else was copied since. */
function copySecret(text: string): void {
  clipboard.writeText(text);
  setTimeout(async () => {
    if ((await clipboard.readText()) === text) clipboard.clear();
  }, CLIPBOARD_CLEAR_MS);
}

function registerUIHandlers(): void {
  handle('ui:state', () => buildState());
  handle('ui:newTab', (url?: string) => {
    tabs?.create(url ? resolveInput(url) : undefined);
    if (!url) sendCommand('focus-address');
  });
  handle('ui:select', (id: number) => tabs?.select(id));
  handle('ui:close', (id: number) => tabs?.close(id));
  handle('ui:navigate', (input: string) => {
    closePopover(false);
    const tab = tabs?.active;
    if (!tab) return;
    tab.view.webContents.loadURL(resolveInput(input)).catch(() => {});
    tab.view.webContents.focus();
  });
  handle('ui:nav', (action: NavAction) => {
    const wc = tabs?.active?.view.webContents;
    if (!wc) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
  });
  handle('ui:focusPage', () => tabs?.active?.view.webContents.focus());
  handle('ui:setLegacy', (on: boolean) => {
    closePopover(false);
    setLegacy(on === true);
  });
  handle('ui:addressPopover', (mode: unknown, anchor: unknown) => {
    const a = anchor as { x?: unknown; y?: unknown } | undefined;
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 4000;
    if (mode !== 'peek' && mode !== 'edit') return;
    openPopover(mode, a && ok(a.x) && ok(a.y) ? { x: a.x, y: a.y } : undefined);
  });
  handle('ui:addressPopoverClose', (refocusPage: unknown) => closePopover(refocusPage === true));
  handle('ui:addressPopoverHeight', (h: unknown) => {
    if (typeof h !== 'number' || !Number.isFinite(h)) return;
    popoverHeight = Math.max(40, Math.min(Math.round(h), 400));
    if (popoverMode) placePopover();
  });
  handle('ui:setTheme', (theme: ThemeSetting) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') setTheme(theme);
  });
  handle('ui:home', () => {
    const tab = tabs?.active;
    if (tab) tab.view.webContents.loadURL(startPageUrl(settings.legacy)).catch(() => {});
  });
  handle('ui:layout', (next: unknown) => {
    const n = next as Record<string, unknown>;
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 2000;
    if (!n || !ok(n.left) || !ok(n.top) || !ok(n.right) || !ok(n.bottom)) return;
    insets = { left: Math.round(n.left as number), top: Math.round(n.top as number), right: Math.round(n.right as number), bottom: Math.round(n.bottom as number) };
    tabs?.layout();
  });
  handle('ui:overlay', (on: boolean) => tabs?.setOverlay(on === true));

  // --- On-device AI: analyze search results --------------------------------
  handle('ui:analyze', () => {
    const tab = tabs?.active;
    if (tab && insights) void insights.start(tab.id, tab.view.webContents);
  });
  handle('ui:insightsOpen', (open: unknown) => {
    const tab = tabs?.active;
    if (tab) insights?.setOpen(tab.id, open === true);
  });
  handle('ui:openResult', (url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) tabs?.create(url);
  });

  // --- Bookmarks ---------------------------------------------------------
  const str = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
  handle('ui:bookmarks', (): BookmarkData | null => bookmarks!.snapshot());
  handle('ui:bookmarkToggle', () => bookmarkActivePage('toggle'));
  handle('ui:bookmarkAdd', () => bookmarkActivePage('add'));
  handle('ui:bookmarkUndo', async () => {
    if (!lastRemovedBookmark) return;
    await bookmarks!.restore(lastRemovedBookmark);
    lastRemovedBookmark = null;
  });
  handle('ui:bookmarkOpen', (url: unknown, where: unknown) => openBookmarkUrl(str(url), where === 'current' ? 'current' : 'new'));
  handle('ui:bookmarkSave', async (id: unknown, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    const fields = {
      title: p.title === undefined ? undefined : str(p.title, 500),
      url: p.url === undefined ? undefined : str(p.url),
      folder: p.folder === undefined ? undefined : str(p.folder, 120),
    };
    if (typeof id === 'string' && id) await bookmarks!.update(id, fields);
    else await bookmarks!.add({ url: fields.url ?? '', title: fields.title, folder: fields.folder });
  });
  handle('ui:bookmarkDelete', async (id: unknown) => {
    await bookmarks!.remove(str(id, 64));
  });
  handle('ui:folderAdd', (name: unknown) => bookmarks!.addFolder(str(name, 120)));
  handle('ui:folderRename', (from: unknown, to: unknown) => bookmarks!.renameFolder(str(from, 120), str(to, 120)));
  handle('ui:folderDelete', (name: unknown) => bookmarks!.removeFolder(str(name, 120)));
  handle('ui:bookmarksUnlock', () => bookmarks!.unlock('show your bookmarks'));
  handle('ui:bookmarksLock', () => bookmarks!.lock());
  handle('ui:bookmarksSetTouchID', (on: unknown) => {
    settings.bookmarksTouchID = on === true;
    saveSettings();
    bookmarks!.setRequireTouchID(settings.bookmarksTouchID);
  });
  handle('ui:bookmarksImport', () => importBookmarks());
  handle('ui:bookmarksExport', () => exportBookmarks());

  // --- Passwords ---------------------------------------------------------
  handle('ui:vaultUnlock', async () => vault!.unlock('unlock your saved passwords'));
  handle('ui:vaultLock', () => vault!.lock());
  handle('ui:vaultList', (): VaultEntrySummary[] | null => (vault!.unlocked ? vault!.list() : null));
  handle('ui:vaultCopy', (id: string) => {
    const entry = vault!.get(id);
    if (entry) copySecret(entry.password);
  });
  handle('ui:vaultDelete', async (id: string) => {
    await vault!.remove(id);
    pushState();
  });
  handle('ui:vaultAdd', async (url: string, username: string, password: string) => {
    const origin = fillableOrigin(/^[a-z]+:/i.test(url) ? url : `https://${url}`);
    if (!origin) throw new Error('Passwords can only be saved for https sites.');
    if (!password) throw new Error('Password is empty.');
    await vault!.upsert(origin, username, password);
    pushState();
  });
  handle('ui:copySecret', (text: string) => copySecret(text));

  /** Logins saved for the active tab's site. Unlocks the vault (Touch ID) if needed. */
  handle('ui:fillCandidates', async (): Promise<VaultEntrySummary[] | null> => {
    const tab = tabs?.active;
    const origin = tab && fillableOrigin(tab.url);
    if (!origin) return [];
    if (!(await vault!.unlock(`fill your password for ${new URL(origin).host}`))) return null;
    return vault!.forOrigin(origin);
  });

  handle('ui:fill', (id: string) => {
    const tab = tabs?.active;
    const entry = vault!.get(id);
    if (!tab || !entry) return;
    // Re-check at fill time: only ever hand a password to the page it was saved for.
    if (fillableOrigin(tab.view.webContents.getURL()) !== entry.origin) return;
    tab.view.webContents.mainFrame.send('page:fill', { username: entry.username, password: entry.password });
    tab.view.webContents.focus();
  });

  handle('ui:saveDecision', async (tabId: number, save: boolean) => {
    const p = pending.get(tabId);
    pending.delete(tabId);
    pushState();
    if (!p || !save) return true;
    if (!(await vault!.unlock(`save your password for ${new URL(p.origin).host}`))) {
      pending.set(tabId, p); // cancelled Touch ID: keep the prompt up
      pushState();
      return false;
    }
    await vault!.upsert(p.origin, p.username, p.password);
    pushState();
    return true;
  });
}

// ---------------------------------------------------------------------------
// IPC from web pages (the isolated page preload). Main frame only.
// ---------------------------------------------------------------------------

function registerPageHandlers(): void {
  const tabFor = (e: IpcMainEvent) => {
    const tab = tabs?.byWebContents(e.sender);
    return tab && e.senderFrame === e.sender.mainFrame ? tab : undefined;
  };

  ipcMain.on('page:login-form', (e, has: unknown) => {
    const tab = tabFor(e);
    if (!tab) return;
    tab.hasLoginForm = has === true;
    if (tab.id === tabs?.activeId) pushState();
  });

  ipcMain.on('page:credentials', (e, data: unknown) => {
    const tab = tabFor(e);
    if (!tab || !e.senderFrame || typeof data !== 'object' || data === null) return;
    const { username, password } = data as { username?: unknown; password?: unknown };
    if (typeof password !== 'string' || !password || password.length > 1024) return;
    const user = typeof username === 'string' ? username.slice(0, 512) : '';
    const origin = fillableOrigin(e.senderFrame.url);
    if (!origin) return;
    const status = vault!.compare(origin, user, password);
    if (status === 'same') return;
    pending.set(tab.id, { tabId: tab.id, origin, username: user, password, update: status === 'update' });
    pushState();
  });
}

// ---------------------------------------------------------------------------
// Menu and keyboard shortcuts
// ---------------------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const wc = () => tabs?.active?.view.webContents;
  const tabShortcuts: Electron.MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => tabs?.selectIndex(i === 8 ? -1 : i),
  }));

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Private Tab', accelerator: 'CmdOrCtrl+T', click: () => { tabs?.create(); sendCommand('focus-address'); } },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => tabs?.activeId != null && tabs.close(tabs.activeId) },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('focus-address') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => wc()?.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => { const w = wc(); if (w) w.setZoomLevel(w.getZoomLevel() + 0.5); } },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => { const w = wc(); if (w) w.setZoomLevel(w.getZoomLevel() - 0.5); } },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => wc()?.setZoomLevel(0) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => wc()?.toggleDevTools() },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: (['system', 'light', 'dark'] as const).map((t) => ({
            label: t === 'system' ? 'Match System' : t === 'light' ? 'Light' : 'Dark',
            type: 'radio' as const,
            checked: settings.theme === t,
            click: () => setTheme(t),
          })),
        },
        { label: 'Legacy Mode', type: 'checkbox', checked: settings.legacy, accelerator: 'CmdOrCtrl+Shift+L', click: (item) => setLegacy(item.checked) },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => wc()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => wc()?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => tabs?.selectRelative(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => tabs?.selectRelative(-1) },
        { type: 'separator' },
        ...tabShortcuts,
      ],
    },
    bookmarksMenu(),
    {
      label: 'Passwords',
      submenu: [
        { label: 'Show Vault', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendCommand('toggle-vault') },
        { label: 'Lock Vault', click: () => vault?.lock() },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Bookmarks menu: actions, then Favorites, then one submenu per folder. */
function bookmarksMenu(): Electron.MenuItemConstructorOptions {
  const snap = bookmarks?.snapshot();
  const item = (b: Bookmark): Electron.MenuItemConstructorOptions => ({
    label: b.title.length > 60 ? `${b.title.slice(0, 57)}…` : b.title,
    click: () => openBookmarkUrl(b.url),
  });
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: () => void bookmarkActivePage('add') },
    { label: 'Show All Bookmarks', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendCommand('toggle-bookmarks') },
    { type: 'separator' },
  ];
  if (!snap) {
    items.push({
      label: bookmarks?.available === false ? 'Bookmarks need the system keychain' : 'Unlock Bookmarks…',
      enabled: bookmarks?.available !== false,
      click: () => void bookmarks?.unlock('show your bookmarks'),
    });
  } else {
    const favs = snap.bookmarks.filter((b) => b.folder === FAVORITES).slice(0, 30);
    items.push(...(favs.length ? favs.map(item) : [{ label: 'No favorites yet', enabled: false }]));
    const others = snap.folders.filter((f) => f !== FAVORITES);
    if (others.length) {
      items.push({ type: 'separator' });
      for (const f of others) {
        const inFolder = snap.bookmarks.filter((b) => b.folder === f).slice(0, 60);
        items.push({ label: f, submenu: inFolder.length ? inFolder.map(item) : [{ label: 'Empty', enabled: false }] });
      }
    }
  }
  items.push(
    { type: 'separator' },
    { label: 'Import Bookmarks…', click: () => void importBookmarks().catch((e) => toast(String(e.message ?? e))) },
    { label: 'Export Bookmarks…', click: () => void exportBookmarks().catch((e) => toast(String(e.message ?? e))) },
  );
  return { label: 'Bookmarks', submenu: items };
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  app.whenReady().then(() => {
    loadSettings();
    ai = new AIHelper();
    insights = new Insights(ai, pushState);
    nativeTheme.themeSource = settings.theme;
    nativeTheme.on('updated', () => {
      ui?.setBackgroundColor(chromeColor());
      win?.setBackgroundColor(chromeColor());
      pushState();
    });
    app.setAboutPanelOptions({
      applicationName: 'Webscape Wanderer',
      applicationVersion: app.getVersion(),
      version: `Chromium ${process.versions.chrome}`,
      copyright: 'Open source under the Apache License 2.0',
      credits: 'Private by default: every tab has its own memory, and nothing you browse is written to disk.',
      website: 'https://github.com/ancientcomputing/webscape',
      iconPath: ICON,
    });
    // Packaged builds get their icon from the bundle; dev runs borrow Electron's otherwise.
    if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(ICON)) app.dock?.setIcon(ICON);
    vault = new Vault(path.join(app.getPath('userData'), 'vault.bin'), pushState);
    void vault.init();
    bookmarks = new BookmarkStore(path.join(app.getPath('userData'), 'bookmarks.bin'), bookmarksChanged);
    void bookmarks.init(settings.bookmarksTouchID);
    void initBlocker(app.getPath('userData'));
    registerUIHandlers();
    registerPageHandlers();
    buildMenu();
    createWindow();
  });

  // Closing the window ends the private session: all tab memory is gone.
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    insights?.dispose();
    ai?.stop();
  });
}
