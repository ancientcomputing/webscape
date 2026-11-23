import { BaseWindow, clipboard, Menu, session, WebContents, WebContentsView, WebPreferences } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TabState } from '../shared/types';
import { blockedCount, forgetBlockedCount, setupSession } from './privacy';

export const START_PAGE = pathToFileURL(path.join(__dirname, '../ui/newtab.html')).href;

/** The start page, styled for the current UI mode (the hash tells the page which look to use). */
export function startPageUrl(legacy: boolean): string {
  return legacy ? `${START_PAGE}#legacy` : START_PAGE;
}

export function isStartPage(url: string): boolean {
  return url.split('#')[0] === START_PAGE;
}
const ERROR_PAGE = pathToFileURL(path.join(__dirname, '../ui/error.html')).href;

export interface Tab {
  id: number;
  view: WebContentsView;
  partition: string;
  linkedTo: number | null;
  title: string;
  /** The URL the user is on (for error pages: the URL that failed). */
  url: string;
  loading: boolean;
  hasLoginForm: boolean;
}

function tabPreferences(partition: string): WebPreferences {
  return {
    // No "persist:" prefix: Chromium keeps this partition's cookies, storage
    // and cache in memory only, and it shares nothing with any other partition.
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
  };
}

export function displayUrl(url: string): string {
  return isStartPage(url) ? '' : url;
}

export class TabManager {
  readonly tabs: Tab[] = [];
  activeId: number | null = null;
  /** When true the sidebar UI is showing a full-size panel (the vault) over the page area. */
  private overlay = false;
  private nextId = 1;
  /** Legacy mode: square page corners and the retro start page. */
  legacy = false;
  private partitionUsers = new Map<string, number>();

  constructor(
    private readonly win: BaseWindow,
    private readonly bounds: () => Electron.Rectangle,
    private readonly changed: () => void,
    /** Give keyboard focus back to the address bar. */
    private readonly focusAddress: () => void,
  ) {}

  get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  byWebContents(wc: WebContents): Tab | undefined {
    return this.tabs.find((t) => t.view.webContents === wc);
  }

  create(url: string = startPageUrl(this.legacy), opts: { partition?: string; webContents?: WebContents; linkedTo?: number; background?: boolean } = {}): Tab {
    const partition = opts.partition ?? `tab-${crypto.randomUUID()}`;
    const ses = session.fromPartition(partition);
    setupSession(ses, () => (this.win.isDestroyed() ? null : this.win), () => this.changed());
    this.partitionUsers.set(partition, (this.partitionUsers.get(partition) ?? 0) + 1);

    const view = opts.webContents
      ? new WebContentsView({ webContents: opts.webContents })
      : new WebContentsView({ webPreferences: tabPreferences(partition) });
    view.setBorderRadius(this.legacy ? 0 : 10);
    view.setBackgroundColor('#ffffff');

    const tab: Tab = {
      id: this.nextId++,
      view,
      partition,
      linkedTo: opts.linkedTo ?? null,
      title: 'New Tab',
      url,
      loading: false,
      hasLoginForm: false,
    };
    // Open next to the tab that spawned it, else at the end.
    const parentIndex = this.tabs.findIndex((t) => t.id === (opts.linkedTo ?? this.activeId));
    if (opts.linkedTo != null || opts.background) this.tabs.splice(parentIndex + 1, 0, tab);
    else this.tabs.push(tab);

    this.wire(tab);
    if (!opts.webContents) view.webContents.loadURL(url).catch(() => {});
    // A blank start page leaves keyboard focus in the address bar. Attaching a
    // loading view can steal native focus, so hand it back once the page is up.
    if (!opts.background) this.select(tab.id, !isStartPage(url));
    if (!opts.background && !opts.webContents && isStartPage(url)) {
      view.webContents.once('did-finish-load', () => {
        if (this.activeId === tab.id) this.focusAddress();
      });
    }
    this.changed();
    return tab;
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.changed();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      if (!wc.getTitle() || isStartPage(wc.getURL())) tab.title = isStartPage(wc.getURL()) ? 'New Tab' : tab.url;
      this.changed();
    });
    const onNavigate = (url: string) => {
      if (url.startsWith(ERROR_PAGE)) {
        tab.url = new URL(url).searchParams.get('u') ?? tab.url;
      } else {
        tab.url = url;
      }
      this.changed();
    };
    wc.on('did-start-navigation', (details) => {
      // The blocked-tracker count is per page, not per tab lifetime.
      if (details.isMainFrame && !details.isSameDocument) forgetBlockedCount(wc.id);
    });
    wc.on('did-navigate', (_e, url) => {
      tab.hasLoginForm = false;
      onNavigate(url);
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) onNavigate(url);
    });
    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED (a navigation replaced by another one): not an error.
      if (!isMainFrame || code === -3 || validatedURL.startsWith(ERROR_PAGE)) return;
      const q = new URLSearchParams({ u: validatedURL, e: description });
      wc.loadURL(`${ERROR_PAGE}?${q}`).catch(() => {});
    });
    wc.on('render-process-gone', () => {
      tab.title = 'Tab crashed — reload to retry';
      tab.loading = false;
      this.changed();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') {
        // A scripted popup (e.g. "Sign in with…"). It must share the opener's
        // memory and keep window.opener, so it becomes a linked tab.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: tabPreferences(tab.partition) },
          createWindow: (options) => {
            // Electron passes the popup's already-created WebContents in `options` (untyped).
            const { webContents } = options as { webContents?: WebContents };
            const child = this.create(undefined, { webContents, partition: tab.partition, linkedTo: tab.id });
            return child.view.webContents;
          },
        };
      }
      // Ordinary links opened in a new tab get a brand new, isolated memory.
      this.create(url, { background: disposition === 'background-tab' });
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (p.linkURL) {
        items.push(
          { label: 'Open Link in New Private Tab', click: () => this.create(p.linkURL) },
          { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' },
        );
      }
      if (p.isEditable) {
        items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      } else if (p.selectionText) {
        items.push({ role: 'copy' });
      }
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
      );
      Menu.buildFromTemplate(items).popup();
    });
  }

  select(id: number, focusPage = true): void {
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    const prev = this.active;
    if (prev && prev !== next) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    this.win.contentView.addChildView(next.view);
    next.view.setBounds(this.bounds());
    next.view.setVisible(!this.overlay);
    if (!this.overlay && focusPage) next.view.webContents.focus();
    this.changed();
  }

  selectRelative(delta: number): void {
    if (!this.tabs.length) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.select(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  selectIndex(i: number): void {
    const tab = i < 0 ? this.tabs.at(-1) : this.tabs[i];
    if (tab) this.select(tab.id);
  }

  close(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    if (this.activeId === id) {
      this.win.contentView.removeChildView(tab.view);
      this.activeId = null;
      const neighbour = this.tabs[i] ?? this.tabs[i - 1];
      if (neighbour) this.select(neighbour.id);
    }
    const wcId = tab.view.webContents.id;
    tab.view.webContents.close();
    forgetBlockedCount(wcId);
    this.release(tab.partition);
    if (!this.tabs.length) this.create();
    this.changed();
  }

  /** When the last tab using a memory partition closes, wipe it. */
  private release(partition: string): void {
    const n = (this.partitionUsers.get(partition) ?? 1) - 1;
    if (n > 0) {
      this.partitionUsers.set(partition, n);
      return;
    }
    this.partitionUsers.delete(partition);
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
    ses.clearAuthCache().catch(() => {});
  }

  setOverlay(on: boolean): void {
    this.overlay = on;
    const tab = this.active;
    if (!tab) return;
    tab.view.setVisible(!on);
    if (!on) tab.view.webContents.focus();
  }

  /** Switch look: square corners in legacy mode, and restyle tabs sitting on the start page. */
  setLegacy(on: boolean): void {
    this.legacy = on;
    for (const t of this.tabs) {
      t.view.setBorderRadius(on ? 0 : 10);
      const wc = t.view.webContents;
      if (!wc.isDestroyed() && isStartPage(wc.getURL())) wc.loadURL(startPageUrl(on)).catch(() => {});
    }
  }

  layout(): void {
    this.active?.view.setBounds(this.bounds());
  }

  state(): TabState[] {
    return this.tabs.map((t) => {
      const wc = t.view.webContents;
      let host = '';
      try {
        host = isStartPage(t.url) ? '' : new URL(t.url).host;
      } catch {
        /* ignore */
      }
      return {
        id: t.id,
        title: t.title || host || 'Untitled',
        url: displayUrl(t.url),
        host,
        loading: t.loading,
        secure: t.url.startsWith('https:'),
        canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
        canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
        blocked: wc.isDestroyed() ? 0 : blockedCount(wc.id),
        linkedTo: t.linkedTo,
      };
    });
  }
}

/** Turn address-bar input into a URL: URLs pass through, bare domains get https://, the rest is a DuckDuckGo search. */
export function resolveInput(input: string): string {
  const text = input.trim();
  if (!text) return START_PAGE; // caller swaps in the legacy start page if needed
  if (/^(https?|file|about|data):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}
