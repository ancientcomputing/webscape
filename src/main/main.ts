import { app, BaseWindow, clipboard, ipcMain, IpcMainEvent, IpcMainInvokeEvent, Menu, WebContentsView } from 'electron';
import path from 'node:path';
import type { AppState, NavAction, SavePrompt, UICommand, VaultEntrySummary } from '../shared/types';
import { cleanUserAgent, initBlocker } from './privacy';
import { resolveInput, TabManager } from './tabs';
import { fillableOrigin, Vault } from './vault';

app.setName('Webscape Obfuscator');
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

const SIDEBAR_WIDTH = 272;
const GUTTER = 8;
const CLIPBOARD_CLEAR_MS = 30_000;

let win: BaseWindow | null = null;
let ui: WebContentsView | null = null;
let tabs: TabManager | null = null;
let vault: Vault | null = null;

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
    ui.webContents.send('state', buildState());
    const active = tabs?.active;
    if (win && !win.isDestroyed()) win.setTitle(active ? `${active.title} — Webscape Obfuscator` : 'Webscape Obfuscator');
  });
}

function buildState(): AppState {
  const active = tabs?.active;
  const origin = active ? fillableOrigin(active.url) : null;
  const prompt = active ? pending.get(active.id) : undefined;
  return {
    tabs: tabs?.state() ?? [],
    activeId: tabs?.activeId ?? null,
    vaultUnlocked: vault?.unlocked ?? false,
    vaultAvailable: vault?.available ?? false,
    loginForm: active?.hasLoginForm && origin ? { origin } : null,
    savePrompt: prompt ? { tabId: prompt.tabId, origin: prompt.origin, username: prompt.username, update: prompt.update } : null,
  };
}

function sendCommand(cmd: UICommand): void {
  if (!ui) return;
  ui.webContents.focus();
  ui.webContents.send('command', cmd);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function contentBounds(): Electron.Rectangle {
  const { width, height } = win!.getContentBounds();
  return { x: SIDEBAR_WIDTH, y: GUTTER, width: Math.max(0, width - SIDEBAR_WIDTH - GUTTER), height: Math.max(0, height - GUTTER * 2) };
}

function createWindow(): void {
  win = new BaseWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 480,
    title: 'Webscape Obfuscator',
    backgroundColor: '#0d0f14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
  });

  ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/ui-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  ui.setBackgroundColor('#0d0f14');
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
  layout();
  win.on('resize', layout);
  win.on('closed', () => {
    win = null;
    ui = null;
    tabs = null;
  });

  ui.webContents.once('did-finish-load', () => {
    tabs!.create();
    sendCommand('focus-address');
  });
}

// ---------------------------------------------------------------------------
// IPC from the sidebar UI. Every handler checks the sender is our own UI.
// ---------------------------------------------------------------------------

function fromUI(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!ui && e.sender === ui.webContents && e.senderFrame === ui.webContents.mainFrame;
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, (e, ...args) => {
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
  handle('ui:overlay', (on: boolean) => tabs?.setOverlay(on === true));

  // --- Passwords ---------------------------------------------------------
  handle('ui:vaultUnlock', async () => vault!.unlock('unlock your saved passwords'));
  handle('ui:vaultLock', () => vault!.lock());
  handle('ui:vaultList', (): VaultEntrySummary[] | null => (vault!.unlocked ? vault!.list() : null));
  handle('ui:vaultCopy', (id: string) => {
    const entry = vault!.get(id);
    if (entry) copySecret(entry.password);
  });
  handle('ui:vaultDelete', (id: string) => {
    vault!.remove(id);
    pushState();
  });
  handle('ui:vaultAdd', (url: string, username: string, password: string) => {
    const origin = fillableOrigin(/^[a-z]+:/i.test(url) ? url : `https://${url}`);
    if (!origin) throw new Error('Passwords can only be saved for https sites.');
    if (!password) throw new Error('Password is empty.');
    vault!.upsert(origin, username, password);
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
    vault!.upsert(p.origin, p.username, p.password);
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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });

  app.whenReady().then(() => {
    vault = new Vault(path.join(app.getPath('userData'), 'vault.bin'), pushState);
    void initBlocker(app.getPath('userData'));
    registerUIHandlers();
    registerPageHandlers();
    buildMenu();
    createWindow();
  });

  // Closing the window ends the private session: all tab memory is gone.
  app.on('window-all-closed', () => app.quit());
}
