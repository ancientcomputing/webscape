import { systemPreferences } from 'electron';
import crypto from 'node:crypto';
import type { Bookmark, BookmarkData } from '../shared/types';
import { EncryptedJsonFile, encryptionAvailable } from './encrypted-file';

/** The built-in folder: shown in the sidebar and on the legacy personal toolbar. */
export const FAVORITES = 'Favorites';
const AUTO_LOCK_MS = 10 * 60 * 1000;
const MAX_BOOKMARKS = 20_000;

interface FileFormat {
  version: 1;
  folders: string[];
  bookmarks: Bookmark[];
}

/**
 * Bookmarks: pages you deliberately chose to keep. Like the password vault,
 * they're encrypted with the OS keychain, and nothing else about your browsing
 * (history, visit counts, favicons) is ever stored.
 *
 * By default they unlock automatically at launch. With `requireTouchID` they
 * stay locked until you unlock them, and lock again after 10 idle minutes.
 */
export class BookmarkStore {
  private data: FileFormat | null = null;
  private availability: boolean | null = null;
  private requireTouchID = false;
  private lockTimer: NodeJS.Timeout | undefined;
  private unlocking: Promise<boolean> | null = null;
  /** cleaned URL -> bookmark id, for the star in the address bar */
  private byUrl = new Map<string, string>();
  private readonly store: EncryptedJsonFile<FileFormat>;

  constructor(
    file: string,
    private readonly onChange: () => void,
  ) {
    this.store = new EncryptedJsonFile(file);
  }

  async init(requireTouchID: boolean): Promise<void> {
    this.requireTouchID = requireTouchID;
    this.availability = await encryptionAvailable();
    if (this.availability && !requireTouchID) await this.load();
    this.onChange();
  }

  get available(): boolean {
    return this.availability === true;
  }
  get unlocked(): boolean {
    return this.data !== null;
  }
  get touchIDRequired(): boolean {
    return this.requireTouchID;
  }

  setRequireTouchID(on: boolean): void {
    this.requireTouchID = on;
    if (on) this.touch();
    else clearTimeout(this.lockTimer);
    this.onChange();
  }

  /** Unlock (Touch ID only when required and available). Resolves false if cancelled. */
  unlock(reason: string): Promise<boolean> {
    if (this.data) {
      this.touch();
      return Promise.resolve(true);
    }
    if (!this.available) return Promise.resolve(false);
    this.unlocking ??= (async () => {
      if (this.requireTouchID && process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
        try {
          await systemPreferences.promptTouchID(reason);
        } catch {
          return false;
        }
      }
      await this.load();
      this.onChange();
      return true;
    })().finally(() => (this.unlocking = null));
    return this.unlocking;
  }

  lock(): void {
    if (!this.requireTouchID) return; // nothing to lock when Touch ID isn't required
    this.data = null;
    this.byUrl.clear();
    clearTimeout(this.lockTimer);
    this.onChange();
  }

  private touch(): void {
    clearTimeout(this.lockTimer);
    if (this.requireTouchID) this.lockTimer = setTimeout(() => this.lock(), AUTO_LOCK_MS);
  }

  private async load(): Promise<void> {
    const got = await this.store.read();
    const data: FileFormat = got?.data ?? { version: 1, folders: [FAVORITES], bookmarks: [] };
    if (!data.folders.includes(FAVORITES)) data.folders.unshift(FAVORITES);
    this.data = data;
    this.reindex();
    this.touch();
    if (got?.reEncrypt) await this.save();
  }

  private reindex(): void {
    this.byUrl.clear();
    for (const b of this.data?.bookmarks ?? []) if (!this.byUrl.has(b.url)) this.byUrl.set(b.url, b.id);
  }

  private require(): FileFormat {
    if (!this.data) throw new Error('Bookmarks are locked');
    this.touch();
    return this.data;
  }

  private async save(): Promise<void> {
    const data = this.require();
    this.reindex();
    this.onChange();
    await this.store.write(data);
  }

  /** A copy for the UI, or null while locked. */
  snapshot(): BookmarkData | null {
    if (!this.data) return null;
    return { folders: [...this.data.folders], bookmarks: this.data.bookmarks.map((b) => ({ ...b })) };
  }

  /** Id of the bookmark for this page, if any. */
  idForUrl(url: string): string | null {
    const clean = cleanUrl(url);
    return (clean && this.byUrl.get(clean)) ?? null;
  }

  /** Add a bookmark. If the page is already bookmarked, returns the existing one. */
  async add(input: { url: string; title?: string; folder?: string }): Promise<Bookmark> {
    const data = this.require();
    const url = cleanUrl(input.url);
    if (!url) throw new Error('Only http and https pages can be bookmarked.');
    const existing = data.bookmarks.find((b) => b.url === url);
    if (existing) return existing;
    if (data.bookmarks.length >= MAX_BOOKMARKS) throw new Error('Too many bookmarks.');
    const folder = this.folderOrFavorites(input.folder);
    const bookmark: Bookmark = { id: crypto.randomUUID(), title: tidyTitle(input.title, url), url, folder, created: Date.now() };
    data.bookmarks.push(bookmark);
    await this.save();
    return bookmark;
  }

  async update(id: string, patch: { title?: string; url?: string; folder?: string }): Promise<void> {
    const data = this.require();
    const b = data.bookmarks.find((x) => x.id === id);
    if (!b) throw new Error('Bookmark not found.');
    if (patch.url !== undefined) {
      const url = cleanUrl(patch.url);
      if (!url) throw new Error('Only http and https pages can be bookmarked.');
      b.url = url;
    }
    if (patch.title !== undefined) b.title = tidyTitle(patch.title, b.url);
    if (patch.folder !== undefined) b.folder = this.folderOrFavorites(patch.folder);
    await this.save();
  }

  async remove(id: string): Promise<Bookmark | undefined> {
    const data = this.require();
    const b = data.bookmarks.find((x) => x.id === id);
    data.bookmarks = data.bookmarks.filter((x) => x.id !== id);
    await this.save();
    return b;
  }

  /** Put a removed bookmark back exactly as it was (for Undo). */
  async restore(b: Bookmark): Promise<void> {
    const data = this.require();
    if (data.bookmarks.some((x) => x.id === b.id || x.url === b.url)) return;
    if (!data.folders.includes(b.folder)) data.folders.push(b.folder);
    data.bookmarks.push(b);
    await this.save();
  }

  async addFolder(name: string): Promise<string> {
    const data = this.require();
    const n = tidyFolder(name);
    if (!n) throw new Error('Folder name is empty.');
    if (!data.folders.includes(n)) data.folders.push(n);
    await this.save();
    return n;
  }

  async renameFolder(from: string, to: string): Promise<void> {
    const data = this.require();
    const n = tidyFolder(to);
    if (from === FAVORITES) throw new Error(`${FAVORITES} can't be renamed.`);
    if (!n) throw new Error('Folder name is empty.');
    if (n !== from && data.folders.includes(n)) throw new Error('A folder with that name already exists.');
    data.folders = data.folders.map((f) => (f === from ? n : f));
    for (const b of data.bookmarks) if (b.folder === from) b.folder = n;
    await this.save();
  }

  /** Deletes the folder and the bookmarks in it. */
  async removeFolder(name: string): Promise<void> {
    const data = this.require();
    if (name === FAVORITES) throw new Error(`${FAVORITES} can't be deleted.`);
    data.folders = data.folders.filter((f) => f !== name);
    data.bookmarks = data.bookmarks.filter((b) => b.folder !== name);
    await this.save();
  }

  exportHtml(): string {
    return toBookmarksHtml(this.require());
  }

  /** Adds bookmarks from a bookmarks.html file. Pages already bookmarked are skipped. */
  async importHtml(html: string): Promise<{ added: number; skipped: number }> {
    const data = this.require();
    let added = 0;
    let skipped = 0;
    const seen = new Set(data.bookmarks.map((b) => b.url));
    for (const item of parseBookmarksHtml(html)) {
      const url = cleanUrl(item.url);
      if (!url || seen.has(url) || data.bookmarks.length >= MAX_BOOKMARKS) {
        skipped++;
        continue;
      }
      const folder = tidyFolder(item.folder) || FAVORITES;
      if (!data.folders.includes(folder)) data.folders.push(folder);
      data.bookmarks.push({ id: crypto.randomUUID(), title: tidyTitle(item.title, url), url, folder, created: item.created ?? Date.now() });
      seen.add(url);
      added++;
    }
    await this.save();
    return { added, skipped };
  }

  private folderOrFavorites(folder: string | undefined): string {
    const data = this.require();
    const n = tidyFolder(folder ?? '');
    if (n && !data.folders.includes(n)) data.folders.push(n);
    return n || FAVORITES;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Query parameters that only exist to track you. Removed when a page is bookmarked. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'igsh', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'oly_anon_id', 'oly_enc_id',
  'vero_id', 'vero_conv', 'li_fat_id', 'srsltid', 'ref_src', 'ref_url', '__s', 's_cid', 'wickedid',
]);
/** Share-tracking ids used by specific sites only (elsewhere these names can be meaningful). */
const SITE_TRACKING_PARAMS: Record<string, string[]> = {
  'youtube.com': ['si', 'feature', 'pp'],
  'youtu.be': ['si', 'feature'],
  'spotify.com': ['si'],
  'twitter.com': ['s', 't'],
  'x.com': ['s', 't'],
  'amazon.com': ['ref_', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r', 'content-id'],
};

/** Normalise a URL for bookmarking: http(s) only, tracking parameters removed. Returns null if not bookmarkable. */
export function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '');
  const siteParams = Object.entries(SITE_TRACKING_PARAMS).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1] ?? [];
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k) || siteParams.includes(k)) u.searchParams.delete(key);
  }
  const out = u.toString();
  return out.length <= 4096 ? out : null;
}

function tidyTitle(title: string | undefined, url: string): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (t) return t;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function tidyFolder(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 120);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Parse the standard bookmarks.html format ("NETSCAPE-Bookmark-file-1") that
 * every browser exports. Nested folders are flattened to "Parent / Child"; a
 * browser's toolbar folder becomes Favorites. Only http(s) links are kept.
 */
export function parseBookmarksHtml(html: string): { folder: string; title: string; url: string; created?: number }[] {
  const out: { folder: string; title: string; url: string; created?: number }[] = [];
  const stack: (string | null)[] = [];
  let pending: string | null = null;
  const re = /<h3\b([^>]*)>([\s\S]*?)<\/h3>|<dl\b[^>]*>|<\/dl>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[0].slice(0, 4).toLowerCase();
    if (tag.startsWith('<h3')) {
      const isToolbar = /PERSONAL_TOOLBAR_FOLDER\s*=\s*["']?true/i.test(m[1]);
      pending = isToolbar ? FAVORITES : decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim() || 'Untitled folder';
    } else if (tag.startsWith('<dl')) {
      stack.push(pending);
      pending = null;
    } else if (tag === '</dl') {
      stack.pop();
    } else {
      const attrs = m[3];
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs);
      const url = href ? decodeEntities(href[1] ?? href[2] ?? '') : '';
      if (!/^https?:\/\//i.test(url)) continue;
      const added = /add_date\s*=\s*"(\d+)"/i.exec(attrs);
      const path = stack.filter((f): f is string => !!f);
      // "Favorites / Work" reads better as just "Work" when the parent is the toolbar.
      const folder = path.length > 1 && path[0] === FAVORITES ? path.slice(1).join(' / ') : path.join(' / ');
      out.push({
        folder: folder || FAVORITES,
        title: decodeEntities(m[4].replace(/<[^>]*>/g, '')).trim(),
        url,
        created: added ? Number(added[1]) * 1000 : undefined,
      });
    }
  }
  return out;
}

export function toBookmarksHtml(data: { folders: string[]; bookmarks: Bookmark[] }): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const folder of data.folders) {
    const items = data.bookmarks.filter((b) => b.folder === folder);
    const toolbar = folder === FAVORITES ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
    lines.push(`    <DT><H3${toolbar}>${escapeHtml(folder)}</H3>`, '    <DL><p>');
    for (const b of items) {
      lines.push(`        <DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${Math.floor(b.created / 1000)}">${escapeHtml(b.title)}</A>`);
    }
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>', '');
  return lines.join('\n');
}
