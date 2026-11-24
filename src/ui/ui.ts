import type { ResultInsight, SearchView, AppState, Bookmark, BookmarkData, NavAction, TabState, UICommand, VaultEntrySummary } from '../shared/types.js';

interface Bridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onState(cb: (s: AppState) => void): void;
  onCommand(cb: (c: UICommand) => void): void;
  onBookmarks(cb: (b: BookmarkData | null) => void): void;
  onToast(cb: (t: { text: string; action?: 'undo' }) => void): void;
}
const api = (window as unknown as { webscape: Bridge }).webscape;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Tiny element builder. Text always goes through textContent, never innerHTML: titles come from web pages. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | null)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

let state: AppState = {
  tabs: [], activeId: null, vaultUnlocked: false, vaultAvailable: true, legacy: false, theme: 'system', dark: true,
  bookmarks: { available: true, unlocked: false, touchIDRequired: false, activeId: null },
  loginForm: null, savePrompt: null, search: null, answersFirst: false, insights: null,
};
let vaultOpen = false;
let fillChoices: { origin: string; entries: VaultEntrySummary[] } | null = null;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer: number | undefined;
function toast(msg: string, action?: 'undo'): void {
  const el = $('toast');
  el.replaceChildren(h('span', { text: msg }));
  if (action === 'undo') {
    const undo = h('button', { class: 'toast-action', text: 'Undo' });
    undo.addEventListener('click', () => {
      el.hidden = true;
      void api.invoke('ui:bookmarkUndo');
    });
    el.append(undo);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), action ? 5000 : 2400);
}
api.onToast(({ text, action }) => toast(text, action));

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const activeTab = (): TabState | undefined => state.tabs.find((t) => t.id === state.activeId);

function avatarFor(tab: TabState): HTMLElement {
  // Letter avatars instead of favicons: loading a site's favicon from the
  // browser UI would be a request outside the tab's private memory.
  const letter = (tab.host.replace(/^www\./, '')[0] ?? '✦').toUpperCase();
  let hue = 0;
  for (const ch of tab.host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const el = h('span', { class: tab.host ? 'avatar' : 'avatar start', text: tab.host ? letter : '' });
  if (tab.host) el.style.setProperty('--hue', String(hue));
  if (tab.loading) el.classList.add('loading');
  return el;
}

let tabsKey = '';
function renderTabs(): void {
  // Blocked counts tick constantly while pages load; only rebuild when something visible changed.
  const key = JSON.stringify([state.activeId, state.tabs.map((t) => [t.id, t.title, t.url, t.host, t.loading, t.linkedTo])]);
  if (key === tabsKey) return;
  tabsKey = key;
  const list = $('tabs');
  list.replaceChildren(
    ...state.tabs.map((tab) => {
      const close = h('button', { class: 'tab-close', title: 'Close tab (⌘W)', attrs: { 'aria-label': 'Close tab' } }, icon('m4.5 4.5 7 7M11.5 4.5l-7 7'));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        void api.invoke('ui:close', tab.id);
      });
      const li = h(
        'li',
        {
          class: `tab${tab.id === state.activeId ? ' active' : ''}${tab.linkedTo != null ? ' linked' : ''}`,
          title: tab.url ? `${tab.title}\n${tab.url}` : tab.title,
          attrs: { role: 'tab', 'aria-selected': String(tab.id === state.activeId) },
        },
        tab.linkedTo != null ? h('span', { class: 'link-mark', title: 'Popup: shares memory with the tab that opened it' }, icon('M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1')) : null,
        avatarFor(tab),
        h('span', { class: 'tab-title', text: tab.title }),
        close,
      );
      li.addEventListener('click', () => {
        closePages();
        void api.invoke('ui:select', tab.id);
      });
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) void api.invoke('ui:close', tab.id);
      });
      return li;
    }),
  );
}

// ---------------------------------------------------------------------------
// Address bar and navigation
// ---------------------------------------------------------------------------
// Two address fields: the modern sidebar one and the legacy "Location:" one.
const address = $<HTMLInputElement>('address');
const legacyAddress = $<HTMLInputElement>('l-address');
const addressFields = [address, legacyAddress];
let editingAddress = false;

function renderChrome(): void {
  const tab = activeTab();
  document.body.classList.toggle('legacy', state.legacy);
  document.body.classList.toggle('light', !state.dark);
  if (!editingAddress) for (const f of addressFields) f.value = tab?.url ?? '';
  ($('back') as HTMLButtonElement).disabled = !tab?.canGoBack;
  ($('forward') as HTMLButtonElement).disabled = !tab?.canGoForward;
  $('reload').classList.toggle('loading', !!tab?.loading);
  const lock = $('lock');
  lock.className = `lock ${!tab?.url ? 'none' : tab.secure ? 'secure' : 'insecure'}`;
  lock.title = !tab?.url ? '' : tab.secure ? 'Secure connection' : 'Not secure';
  const star = $('star');
  star.hidden = !tab?.url || !state.bookmarks.available;
  star.classList.toggle('on', !!state.bookmarks.activeId);
  star.title = state.bookmarks.activeId ? 'Remove bookmark' : 'Bookmark this page (⌘D)';
  const n = tab?.blocked ?? 0;
  const blockedText = `${n} tracker${n === 1 ? '' : 's'} blocked`;
  $('shield-text').textContent = blockedText;
  $('shield').classList.toggle('active', n > 0);
  const vs = $('vault-state');
  vs.textContent = state.vaultUnlocked ? 'Unlocked' : 'Locked';
  vs.classList.toggle('on', state.vaultUnlocked);
  renderLegacyChrome(tab, blockedText);
}

/** The 90s toolbar, throbber and status bar. */
function renderLegacyChrome(tab: TabState | undefined, blockedText: string): void {
  const tool = (action: string) => document.querySelector<HTMLButtonElement>(`.l-tool[data-action="${action}"]`)!;
  tool('back').disabled = !tab?.canGoBack;
  tool('forward').disabled = !tab?.canGoForward;
  tool('stop').disabled = !tab?.loading;
  $('l-throbber').classList.toggle('loading', !!tab?.loading);
  document.body.classList.toggle('loading-page', !!tab?.loading);
  $('l-title').textContent = tab && tab.url ? `Webscape Wanderer - [${tab.title}]` : 'Webscape Wanderer';
  $('l-status').textContent = tab?.loading ? `Contacting host: ${tab.host || 'page'}...` : 'Document: Done';
  const lock = $('l-lock');
  lock.className = `l-lock ${!tab?.url ? '' : tab.secure ? 'secure' : 'insecure'}`;
  lock.parentElement!.title = !tab?.url ? 'No page loaded' : tab.secure ? 'This page is encrypted (https)' : 'This page is NOT encrypted';
  $('l-blocked').textContent = blockedText;
}

// Modern look: the sidebar address is a compact summary. Hovering shows the whole
// address in a wide floating box; clicking (or ⌘L) opens that box for typing.
function openAddressBox(mode: 'peek' | 'edit'): void {
  const r = $('address-form').getBoundingClientRect();
  void api.invoke('ui:addressPopover', mode, { x: r.left, y: r.top });
}
let hoverTimer: number | undefined;
$('address-form').addEventListener('mouseenter', () => {
  clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => openAddressBox('peek'), 250);
});
$('address-form').addEventListener('mouseleave', () => clearTimeout(hoverTimer));
address.readOnly = true;
address.addEventListener('mousedown', (e) => {
  e.preventDefault();
  clearTimeout(hoverTimer);
  openAddressBox('edit');
});
address.addEventListener('focus', () => {
  // Keyboard focus (Tab) lands here: hand it to the big box.
  address.blur();
  openAddressBox('edit');
});

for (const field of [legacyAddress]) {
  field.addEventListener('focus', () => {
    editingAddress = true;
    field.select();
  });
  field.addEventListener('blur', () => {
    editingAddress = false;
    renderChrome();
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      field.value = activeTab()?.url ?? '';
      void api.invoke('ui:focusPage');
    }
  });
  field.form!.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    closePages();
    void api.invoke('ui:navigate', value);
    field.blur();
  });
}

const nav = (a: NavAction) => () => void api.invoke('ui:nav', a);
$('back').addEventListener('click', nav('back'));
$('forward').addEventListener('click', nav('forward'));
$('reload').addEventListener('click', () => void api.invoke('ui:nav', activeTab()?.loading ? 'stop' : 'reload'));
const newTab = () => {
  closePages();
  void api.invoke('ui:newTab');
};
$('new-tab').addEventListener('click', newTab);
$('new-tab-row').addEventListener('click', newTab);
$('legacy-toggle').addEventListener('click', () => void api.invoke('ui:setLegacy', true));
$('theme-toggle').addEventListener('click', () => void api.invoke('ui:setTheme', state.dark ? 'light' : 'dark'));

// Legacy toolbar buttons
const legacyActions: Record<string, () => void> = {
  back: nav('back'),
  forward: nav('forward'),
  reload: nav('reload'),
  stop: nav('stop'),
  home: () => {
    closePages();
    void api.invoke('ui:home');
  },
  search: () => {
    closePages();
    void api.invoke('ui:navigate', 'https://duckduckgo.com/');
  },
  passwords: () => (vaultOpen ? closeVault() : openVault()),
  'new-tab': newTab,
  modern: () => void api.invoke('ui:setLegacy', false),
  bookmark: () => void api.invoke('ui:bookmarkAdd'), // "Add Bookmark" only adds; it never removes
  bookmarks: () => (bookmarksOpen ? closeBookmarks() : openBookmarks()),
};
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  btn.addEventListener('click', () => legacyActions[btn.dataset.action!]?.());
}

// ---------------------------------------------------------------------------
// Tell the main process where the page goes (it differs between the two looks).
// ---------------------------------------------------------------------------
let lastInsets = '';
function reportLayout(): void {
  const frame = $('page-frame');
  const r = frame.getBoundingClientRect();
  const inset = state.legacy ? 2 : 0; // stay inside the sunken bevel
  const insets = {
    left: r.left + inset,
    top: r.top + inset,
    right: window.innerWidth - r.right + inset,
    bottom: window.innerHeight - r.bottom + inset,
  };
  const key = JSON.stringify(insets);
  if (key === lastInsets) return;
  lastInsets = key;
  void api.invoke('ui:layout', insets);
}
new ResizeObserver(reportLayout).observe($('page-frame'));

// ---------------------------------------------------------------------------
// Login card: save prompt, or fill offer
// ---------------------------------------------------------------------------
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

let cardKey = '';
function renderLoginCard(force = false): void {
  const key = JSON.stringify([state.savePrompt, state.loginForm, state.vaultUnlocked, fillChoices]);
  if (key === cardKey && !force) return;
  cardKey = key;
  const card = $('login-card');
  const prompt = state.savePrompt;
  const form = state.loginForm;

  if (prompt) {
    const save = h('button', { class: 'btn primary', text: prompt.update ? 'Update' : 'Save' });
    const dismiss = h('button', { class: 'btn ghost', text: 'Not now' });
    save.addEventListener('click', async () => {
      const ok = await api.invoke<boolean>('ui:saveDecision', prompt.tabId, true);
      if (ok) toast('Password saved');
    });
    dismiss.addEventListener('click', () => void api.invoke('ui:saveDecision', prompt.tabId, false));
    card.replaceChildren(
      h('div', { class: 'card-title', text: prompt.update ? 'Update saved password?' : 'Save password?' }),
      h('div', { class: 'card-sub', text: hostOf(prompt.origin) }),
      h('div', { class: 'card-user', text: prompt.username || '(no username)' }),
      h('div', { class: 'row' }, dismiss, save),
    );
    card.hidden = false;
    return;
  }

  if (form) {
    if (fillChoices && fillChoices.origin === form.origin) {
      const rows = fillChoices.entries.map((entry) => {
        const b = h('button', { class: 'fill-choice' }, h('span', { text: entry.username || '(no username)' }));
        b.addEventListener('click', () => {
          void api.invoke('ui:fill', entry.id);
          fillChoices = null;
          renderLoginCard();
        });
        return b;
      });
      card.replaceChildren(
        h('div', { class: 'card-title', text: rows.length ? 'Fill login' : 'No saved login' }),
        h('div', { class: 'card-sub', text: hostOf(form.origin) }),
        ...(rows.length ? rows : [h('div', { class: 'card-user muted', text: 'Sign in and choose Save to keep it.' })]),
      );
    } else {
      const fill = h('button', { class: 'btn primary wide' }, icon('M5.5 13.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM7.6 8.4 13.5 2.5M11 5l1.8 1.8'), h('span', { text: state.vaultUnlocked ? 'Fill password' : 'Unlock & fill' }));
      fill.addEventListener('click', async () => {
        const entries = await api.invoke<VaultEntrySummary[] | null>('ui:fillCandidates');
        if (entries === null) return toast('Vault stayed locked');
        if (entries.length === 1) {
          void api.invoke('ui:fill', entries[0].id);
          return;
        }
        fillChoices = { origin: form.origin, entries };
        renderLoginCard();
      });
      card.replaceChildren(h('div', { class: 'card-sub', text: `Sign-in form on ${hostOf(form.origin)}` }), fill);
    }
    card.hidden = false;
    return;
  }

  fillChoices = null;
  card.hidden = true;
}

// ---------------------------------------------------------------------------
// Vault page
// ---------------------------------------------------------------------------
let vaultEntries: VaultEntrySummary[] = [];

function openVault(): void {
  if (vaultOpen) return;
  closeBookmarks();
  vaultOpen = true;
  $('vault-page').hidden = false;
  document.body.classList.add('vault-mode');
  void api.invoke('ui:overlay', true);
  void refreshVault();
  newPassword();
}

function closeVault(): void {
  if (!vaultOpen) return;
  vaultOpen = false;
  $('vault-page').hidden = true;
  document.body.classList.remove('vault-mode');
  void api.invoke('ui:overlay', false);
}

async function refreshVault(): Promise<void> {
  $('vault-locked').hidden = state.vaultUnlocked;
  $('vault-open').hidden = !state.vaultUnlocked;
  $('vault-lock').hidden = !state.vaultUnlocked;
  $<HTMLButtonElement>('vault-unlock').disabled = !state.vaultAvailable;
  if (!state.vaultAvailable) $('vault-unlock').textContent = 'System keychain unavailable';
  if (!state.vaultUnlocked) return;
  vaultEntries = (await api.invoke<VaultEntrySummary[] | null>('ui:vaultList')) ?? [];
  renderVaultList();
}

function renderVaultList(): void {
  const q = $<HTMLInputElement>('vault-search').value.trim().toLowerCase();
  const shown = vaultEntries.filter((e) => !q || e.origin.toLowerCase().includes(q) || e.username.toLowerCase().includes(q));
  $('vault-empty').hidden = vaultEntries.length > 0;
  $('vault-list').replaceChildren(
    ...shown.map((entry) => {
      const copy = h('button', { class: 'btn ghost small', text: 'Copy password' });
      copy.addEventListener('click', async () => {
        await api.invoke('ui:vaultCopy', entry.id);
        toast('Copied — clipboard clears in 30 s');
      });
      const del = h('button', { class: 'btn ghost small danger', text: 'Delete' });
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the saved password for ${entry.username || '(no username)'} on ${hostOf(entry.origin)}?`)) return;
        await api.invoke('ui:vaultDelete', entry.id);
        await refreshVault();
      });
      const host = hostOf(entry.origin);
      return h(
        'li',
        { class: 'vault-row' },
        avatarFor({ host, loading: false } as TabState),
        h('div', { class: 'vault-meta' }, h('div', { class: 'vault-site', text: host }), h('div', { class: 'vault-user', text: entry.username || '(no username)' })),
        h('div', { class: 'row' }, copy, del),
      );
    }),
  );
}

$('vault-button').addEventListener('click', () => (vaultOpen ? closeVault() : openVault()));
$('vault-close').addEventListener('click', closeVault);
$('vault-lock').addEventListener('click', () => void api.invoke('ui:vaultLock'));
$('vault-unlock').addEventListener('click', async () => {
  const ok = await api.invoke<boolean>('ui:vaultUnlock');
  if (!ok) toast('Vault stayed locked');
});
$('vault-search').addEventListener('input', renderVaultList);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (vaultOpen || bookmarksOpen) && !(e.target instanceof HTMLInputElement)) closePages();
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  const err = $('add-error');
  try {
    await api.invoke('ui:vaultAdd', String(data.get('site')), String(data.get('username') ?? ''), String(data.get('password')));
    form.reset();
    err.hidden = true;
    toast('Login saved');
    await refreshVault();
  } catch (ex) {
    err.textContent = String((ex as Error).message).replace(/^Error invoking remote method '[^']+': Error: /, '');
    err.hidden = false;
  }
});

// Password generator: uniform random characters from crypto.getRandomValues (rejection sampling, no modulo bias).
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';
function generate(length: number, symbols: boolean): string {
  const alphabet = symbols ? LETTERS + SYMBOLS : LETTERS;
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
function newPassword(): void {
  const len = Number($<HTMLInputElement>('gen-len').value);
  $('gen-len-label').textContent = String(len);
  $('gen-output').textContent = generate(len, $<HTMLInputElement>('gen-symbols').checked);
}
$('gen-len').addEventListener('input', newPassword);
$('gen-symbols').addEventListener('change', newPassword);
$('gen-new').addEventListener('click', newPassword);
$('gen-copy').addEventListener('click', async () => {
  await api.invoke('ui:copySecret', $('gen-output').textContent ?? '');
  toast('Copied — clipboard clears in 30 s');
});

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------
const FAVORITES = 'Favorites';
let bookmarkData: BookmarkData | null = null;
let bookmarksOpen = false;
let selectedFolder = FAVORITES;
let editingId: string | null = null;
let renamingFolder = false;

function closePages(): void {
  closeVault();
  closeBookmarks();
}

const hostOfUrl = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
const bookmarkAvatar = (b: Bookmark) => avatarFor({ host: hostOfUrl(b.url), loading: false } as TabState);
const errorText = (ex: unknown) => String((ex as Error)?.message ?? ex).replace(/^Error invoking remote method '[^']+': Error: /, '');

async function guarded(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (ex) {
    toast(errorText(ex));
  }
}

$('star').addEventListener('mousedown', (e) => e.stopPropagation()); // don't open the address box
$('star').addEventListener('click', (e) => {
  e.stopPropagation();
  void guarded(() => api.invoke('ui:bookmarkToggle'));
});

// --- Sidebar: Favorites -----------------------------------------------------
let favsCollapsed = false;
$('bm-collapse').addEventListener('click', () => {
  favsCollapsed = !favsCollapsed;
  $('bm-collapse').setAttribute('aria-expanded', String(!favsCollapsed));
  renderFavorites();
});
$('bm-all').addEventListener('click', () => (bookmarksOpen ? closeBookmarks() : openBookmarks()));

function renderFavorites(): void {
  const list = $('bm-list');
  const hint = $('bm-hint');
  $('bm-section').classList.toggle('collapsed', favsCollapsed);
  hint.replaceChildren();
  if (!state.bookmarks.available) {
    list.replaceChildren();
    hint.textContent = 'Bookmarks need the system keychain.';
    hint.hidden = favsCollapsed;
    return;
  }
  if (!bookmarkData) {
    list.replaceChildren();
    const b = h('button', { class: 'linkish', text: 'Unlock bookmarks' });
    b.addEventListener('click', () => void api.invoke('ui:bookmarksUnlock'));
    hint.append(b);
    hint.hidden = favsCollapsed;
    return;
  }
  const favs = bookmarkData.bookmarks.filter((b) => b.folder === FAVORITES);
  hint.textContent = favs.length ? '' : 'Press ⌘D or ☆ to bookmark a page.';
  hint.hidden = favsCollapsed || favs.length > 0;
  list.replaceChildren(
    ...(favsCollapsed ? [] : favs).map((b) => {
      const li = h('li', { class: 'tab bm-item', title: `${b.title}\n${b.url}` }, bookmarkAvatar(b), h('span', { class: 'tab-title', text: b.title }));
      li.addEventListener('click', () => {
        closePages();
        void api.invoke('ui:bookmarkOpen', b.url, 'new');
      });
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) void api.invoke('ui:bookmarkOpen', b.url, 'new');
      });
      return li;
    }),
  );
}

// --- Legacy personal toolbar -------------------------------------------------
function renderLegacyFavorites(): void {
  const favs = bookmarkData?.bookmarks.filter((b) => b.folder === FAVORITES) ?? [];
  $('l-favs').replaceChildren(
    ...favs.map((b) => {
      const chip = h('button', { class: 'l-chip l-fav', text: b.title.length > 28 ? `${b.title.slice(0, 26)}…` : b.title, title: `${b.title}\n${b.url}`, attrs: { role: 'listitem' } });
      chip.addEventListener('click', () => {
        closePages();
        void api.invoke('ui:bookmarkOpen', b.url, 'new');
      });
      return chip;
    }),
  );
}

// --- Bookmarks page ------------------------------------------------------------
function openBookmarks(): void {
  if (bookmarksOpen) return;
  closeVault();
  bookmarksOpen = true;
  $('bm-page').hidden = false;
  document.body.classList.add('vault-mode');
  void api.invoke('ui:overlay', true);
  renderBookmarksPage();
}

function closeBookmarks(): void {
  if (!bookmarksOpen) return;
  bookmarksOpen = false;
  editingId = null;
  renamingFolder = false;
  $('bm-page').hidden = true;
  document.body.classList.remove('vault-mode');
  void api.invoke('ui:overlay', false);
}

function renderBookmarksPage(): void {
  if (!bookmarksOpen) return;
  const unlocked = !!bookmarkData;
  $('bm-locked').hidden = unlocked;
  $('bm-open').hidden = !unlocked;
  $<HTMLButtonElement>('bm-import').disabled = !state.bookmarks.available;
  $<HTMLButtonElement>('bm-export').disabled = !unlocked;
  const unlockBtn = $<HTMLButtonElement>('bm-unlock');
  unlockBtn.disabled = !state.bookmarks.available;
  $('bm-locked-text').textContent = state.bookmarks.available ? 'Your bookmarks are locked.' : 'Bookmarks need the system keychain, which is unavailable.';
  if (!bookmarkData) return;
  if (!bookmarkData.folders.includes(selectedFolder)) selectedFolder = FAVORITES;
  $<HTMLInputElement>('bm-touchid').checked = state.bookmarks.touchIDRequired;
  $('bm-lock').hidden = !state.bookmarks.touchIDRequired;
  renderFolderList();
  renderBookmarkItems();
}

function renderFolderList(): void {
  const data = bookmarkData!;
  $('bm-folder-list').replaceChildren(
    ...data.folders.map((f) => {
      const count = data.bookmarks.filter((b) => b.folder === f).length;
      const active = f === selectedFolder && !$<HTMLInputElement>('bm-search').value.trim();
      if (active && renamingFolder) {
        const input = h('input', { class: 'bm-rename', attrs: { value: f, 'aria-label': 'Folder name' } });
        const save = () =>
          guarded(async () => {
            const to = input.value.trim();
            renamingFolder = false;
            if (to && to !== f) {
              await api.invoke('ui:folderRename', f, to);
              selectedFolder = to;
            }
            renderBookmarksPage();
          });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') {
            renamingFolder = false;
            renderBookmarksPage();
          }
        });
        input.addEventListener('blur', () => void save());
        queueMicrotask(() => {
          input.focus();
          input.select();
        });
        return h('li', { class: 'bm-folder active' }, input);
      }
      const li = h('li', { class: `bm-folder${active ? ' active' : ''}` }, h('span', { class: 'bm-folder-name', text: f }), h('span', { class: 'bm-count', text: String(count) }));
      li.addEventListener('click', () => {
        selectedFolder = f;
        editingId = null;
        renamingFolder = false;
        $<HTMLInputElement>('bm-search').value = '';
        renderBookmarksPage();
      });
      return li;
    }),
  );
  const isFav = selectedFolder === FAVORITES;
  $('bm-folder-actions').hidden = isFav || !!$<HTMLInputElement>('bm-search').value.trim();
}

function folderSelect(current: string): HTMLSelectElement {
  const sel = h('select', { class: 'bm-select', attrs: { 'aria-label': 'Folder' } });
  for (const f of bookmarkData!.folders) {
    const o = h('option', { text: f, attrs: { value: f } });
    if (f === current) o.selected = true;
    sel.append(o);
  }
  return sel;
}

function renderBookmarkItems(): void {
  const data = bookmarkData!;
  const q = $<HTMLInputElement>('bm-search').value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const shown = terms.length
    ? data.bookmarks.filter((b) => terms.every((t) => b.title.toLowerCase().includes(t) || b.url.toLowerCase().includes(t)))
    : data.bookmarks.filter((b) => b.folder === selectedFolder);
  const empty = $('bm-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = terms.length ? 'No bookmarks match.' : selectedFolder === FAVORITES ? 'No favorites yet. Press ⌘D or ☆ on any page.' : 'This folder is empty.';
  $('bm-add-form').hidden = terms.length > 0;

  $('bm-items').replaceChildren(
    ...shown.map((b) => {
      if (b.id === editingId) {
        const title = h('input', { attrs: { value: b.title, 'aria-label': 'Title' } });
        const url = h('input', { attrs: { value: b.url, 'aria-label': 'Address', spellcheck: 'false' } });
        const folder = folderSelect(b.folder);
        const save = h('button', { class: 'btn primary small', text: 'Save' });
        const cancel = h('button', { class: 'btn ghost small', text: 'Cancel' });
        save.addEventListener('click', () =>
          void guarded(async () => {
            await api.invoke('ui:bookmarkSave', b.id, { title: title.value, url: url.value, folder: folder.value });
            editingId = null;
          }),
        );
        cancel.addEventListener('click', () => {
          editingId = null;
          renderBookmarkItems();
        });
        const form = h('li', { class: 'vault-row bm-edit' }, h('div', { class: 'bm-edit-fields' }, title, url, folder), h('div', { class: 'row' }, cancel, save));
        form.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save.click();
          if (e.key === 'Escape') cancel.click();
        });
        queueMicrotask(() => title.focus());
        return form;
      }
      const open = h('button', { class: 'btn ghost small', text: 'Open' });
      open.addEventListener('click', () => {
        closePages();
        void api.invoke('ui:bookmarkOpen', b.url, 'new');
      });
      const edit = h('button', { class: 'btn ghost small', text: 'Edit' });
      edit.addEventListener('click', () => {
        editingId = b.id;
        renderBookmarkItems();
      });
      const del = h('button', { class: 'btn ghost small danger', text: 'Delete' });
      del.addEventListener('click', () => void guarded(() => api.invoke('ui:bookmarkDelete', b.id)));
      return h(
        'li',
        { class: 'vault-row' },
        bookmarkAvatar(b),
        h(
          'div',
          { class: 'vault-meta' },
          h('div', { class: 'vault-site', text: b.title }),
          h('div', { class: 'vault-user', text: terms.length && b.folder !== FAVORITES ? `${b.folder} · ${b.url}` : b.url }),
        ),
        h('div', { class: 'row' }, open, edit, del),
      );
    }),
  );
}

$('bm-search').addEventListener('input', () => {
  editingId = null;
  renderBookmarksPage();
});
$('bm-close').addEventListener('click', closeBookmarks);
$('bm-unlock').addEventListener('click', async () => {
  const ok = await api.invoke<boolean>('ui:bookmarksUnlock');
  if (!ok) toast('Bookmarks stayed locked');
});
$('bm-lock').addEventListener('click', () => void api.invoke('ui:bookmarksLock'));
$('bm-touchid').addEventListener('change', (e) => void api.invoke('ui:bookmarksSetTouchID', (e.target as HTMLInputElement).checked));
$('bm-import').addEventListener('click', () => void guarded(() => api.invoke('ui:bookmarksImport')));
$('bm-export').addEventListener('click', () => void guarded(() => api.invoke('ui:bookmarksExport')));
$('bm-folder-rename').addEventListener('click', () => {
  renamingFolder = true;
  renderBookmarksPage();
});
$('bm-folder-delete').addEventListener('click', () => {
  const n = bookmarkData?.bookmarks.filter((b) => b.folder === selectedFolder).length ?? 0;
  if (!confirm(`Delete the folder "${selectedFolder}"${n ? ` and its ${n} bookmark${n === 1 ? '' : 's'}` : ''}?`)) return;
  void guarded(async () => {
    await api.invoke('ui:folderDelete', selectedFolder);
    selectedFolder = FAVORITES;
  });
});
$('bm-folder-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const name = String(new FormData(form).get('name') ?? '').trim();
  if (!name) return;
  void guarded(async () => {
    selectedFolder = await api.invoke<string>('ui:folderAdd', name);
    form.reset();
  });
});
$('bm-add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  let url = String(data.get('url') ?? '').trim();
  if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
  const err = $('bm-error');
  void (async () => {
    try {
      await api.invoke('ui:bookmarkSave', null, { url, title: String(data.get('title') ?? ''), folder: selectedFolder });
      form.reset();
      err.hidden = true;
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    }
  })();
});

function setBookmarks(data: BookmarkData | null): void {
  bookmarkData = data;
  renderFavorites();
  renderLegacyFavorites();
  renderBookmarksPage();
}
api.onBookmarks(setBookmarks);
void api.invoke<BookmarkData | null>('ui:bookmarks').then(setBookmarks);


// ---------------------------------------------------------------------------
// On-device AI: Results / Answers views of a search
// ---------------------------------------------------------------------------
const STATUS_ORDER: Record<ResultInsight['status'], number> = { done: 0, judging: 1, reading: 2, queued: 3, error: 4 };

function scoreLabel(score: number): { label: string; cls: string } {
  if (score >= 70) return { label: 'High', cls: 'high' };
  if (score >= 40) return { label: 'Medium', cls: 'medium' };
  return { label: 'Low', cls: 'low' };
}

const currentView = (): SearchView => state.insights?.view ?? 'results';

/** A Results | Answers switch. Built once and updated in place, so clicks never land on a replaced button. */
function makeViewSwitch(): HTMLElement {
  const make = (view: SearchView, text: string, hint: string) => {
    const b = h('button', { class: 'seg-btn', text, title: hint, attrs: { 'data-view': view } });
    b.addEventListener('click', () => {
      closePages();
      void api.invoke('ui:searchView', view);
    });
    return b;
  };
  return h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Search view' } },
    make('results', 'Results', 'DuckDuckGo’s results page'),
    make('answers', 'Answers', 'Results ranked by how likely they answer your search (⇧⌘A)'));
}

function updateViewSwitch(sw: HTMLElement): void {
  for (const b of Array.from(sw.querySelectorAll<HTMLButtonElement>('.seg-btn'))) {
    const on = b.dataset.view === currentView();
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function insightsSummary(): string {
  const ins = state.insights;
  if (!ins) return 'Answers reads the top results privately and ranks them with on-device AI.';
  if (ins.status === 'unavailable' || ins.status === 'error') return ins.detail;
  const done = ins.results.filter((r) => r.status === 'done');
  if (ins.status !== 'done') return `Judged ${done.length} of ${ins.results.length || 8} pages…`;
  const best = Math.max(...done.map((r) => r.score ?? 0));
  return done.length ? `${done.length} pages judged · best ${best} (${scoreLabel(best).label})` : ins.detail;
}

// The sidebar's "This search" card, built once.
const cardSwitch = makeViewSwitch();
const cardSummary = h('div', { class: 'card-sub' });
const answersFirstBox = h('input', { attrs: { type: 'checkbox' } }) as HTMLInputElement;
answersFirstBox.addEventListener('change', () => void api.invoke('ui:answersFirst', answersFirstBox.checked));
$('analyze-card').replaceChildren(
  h('div', { class: 'card-title', text: 'This search' }),
  cardSwitch,
  cardSummary,
  h('label', { class: 'check small', title: 'Every search is analyzed automatically: its top pages are read privately on this Mac.' },
    answersFirstBox, h('span', { text: 'Open searches on Answers' })),
);

function renderSearchCard(): void {
  const card = $('analyze-card');
  card.hidden = !state.search;
  if (!state.search) return;
  updateViewSwitch(cardSwitch);
  cardSummary.textContent = insightsSummary();
  answersFirstBox.checked = state.answersFirst;
}

function resultItem(r: ResultInsight, rank: number): HTMLElement {
  const open = h('button', { class: 'ins-title', text: r.title || r.host, title: `Open ${r.url} in a new tab` });
  open.addEventListener('click', () => void api.invoke('ui:openResult', r.url));
  const badge =
    r.status === 'done' && r.score !== undefined
      ? (() => {
          const { label, cls } = scoreLabel(r.score!);
          return h('span', { class: `ins-score ${cls}`, title: `${r.score} out of 100` },
            h('b', { text: String(r.score) }), h('span', { text: label }));
        })()
      : r.status === 'error'
        ? h('span', { class: 'ins-score none', text: '—' })
        : h('span', { class: 'ins-score pending' }, h('span', { class: 'ins-spin' }));
  const body = h('div', { class: 'ins-body' },
    h('div', { class: 'ins-host', text: r.status === 'done' ? `${rank}. ${r.host}` : r.host }), open);
  if (r.status === 'done') {
    const verdict = r.listicle
      ? 'Listicle · scored 0'
      : r.answers === 'yes' ? 'Answers it' : r.answers === 'partly' ? 'Partly answers it' : 'Doesn’t answer it';
    const reasons = r.listicle ? [] : [...(r.factors ?? [])];
    if (r.rendered) reasons.push('read with JavaScript');
    const why = reasons.join(' · ');
    body.append(h('div', { class: `ins-verdict ${r.listicle ? 'listicle' : r.answers ?? 'no'}`, title: r.listicle ? 'Listicles (“Top 10…”, “15 best…”) are scored 0.' : '' },
      h('span', { text: verdict }),
      why ? h('span', { class: 'ins-factors', text: ` · ${why}` }) : null));
    if (r.summary) body.append(h('p', { class: 'ins-summary', text: r.summary }));
    if (r.evidence) body.append(h('blockquote', { class: 'ins-evidence', text: r.evidence }));
  } else if (r.status === 'error') {
    body.append(h('p', { class: 'ins-error', text: r.error ?? 'Couldn’t read this page.' }));
  } else {
    const what = r.status === 'judging' ? 'Judging…' : r.status === 'reading' ? 'Reading the page…' : 'Waiting…';
    body.append(h('p', { class: 'ins-pending', text: what }));
  }
  return h('li', { class: `ins-item ${r.status}` }, badge, body);
}

// The Answers page: a fixed frame (heading, switch, status) built once; only the list is rebuilt.
const pageSwitch = makeViewSwitch();
const pageQuery = h('h1', { class: 'ins-query' });
const pageSpin = h('span', { class: 'ins-spin' });
const pageStatusText = h('span');
const pageStatus = h('div', { class: 'ins-status' }, pageSpin, pageStatusText);
const pageBody = h('div');
const pageFoot = h('footer', { class: 'ins-foot' });
$('insights').replaceChildren(h('div', { class: 'ins-inner' },
  h('header', { class: 'ins-header' },
    h('div', { class: 'ins-heading' }, h('div', { class: 'ins-kicker', text: 'Best answers for' }), pageQuery),
    pageSwitch),
  pageStatus, pageBody, pageFoot));

let insightsKey = '';
function renderInsights(): void {
  renderSearchCard();
  const page = $('insights');
  const ins = state.insights;
  const show = !!state.search && !!ins && ins.view === 'answers' && !vaultOpen && !bookmarksOpen;
  page.hidden = !show;
  if (!show || !ins) {
    insightsKey = '';
    return;
  }
  updateViewSwitch(pageSwitch);
  pageQuery.textContent = ins.query;
  pageSpin.hidden = !(ins.status === 'starting' || ins.status === 'running');
  pageStatusText.textContent = insightsSummary();
  pageFoot.textContent = `${ins.model || 'On-device model'} · runs on this Mac · scores are the model’s estimate · click a title to open it in a new tab`;

  const key = JSON.stringify([ins.status, ins.results]);
  if (key === insightsKey) return;
  insightsKey = key;
  if (ins.status === 'unavailable' || ins.status === 'error') {
    const retry = h('button', { class: 'btn', text: 'Try again' });
    retry.addEventListener('click', () => void api.invoke('ui:searchView', 'answers'));
    pageBody.replaceChildren(h('p', { class: 'ins-empty', text: ins.detail }), retry);
    return;
  }
  const sorted = [...ins.results].sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.score ?? -1) - (a.score ?? -1));
  let rank = 0;
  pageBody.replaceChildren(h('ol', { class: 'ins-list' },
    ...sorted.map((r) => resultItem(r, r.status === 'done' ? ++rank : 0))));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function render(): void {
  renderChrome();
  renderTabs();
  renderLoginCard();
  renderInsights();
  requestAnimationFrame(reportLayout); // the page slot moves when the look changes
}

let prevUnlocked = false;
let prevBookmarksAvailable = true;
api.onState((s) => {
  const activeChanged = s.activeId !== state.activeId;
  state = s;
  if (activeChanged) fillChoices = null;
  if (prevUnlocked !== s.vaultUnlocked) {
    prevUnlocked = s.vaultUnlocked;
    if (!s.vaultUnlocked) fillChoices = null;
    if (vaultOpen) void refreshVault();
  }
  if (prevBookmarksAvailable !== s.bookmarks.available) {
    prevBookmarksAvailable = s.bookmarks.available;
    renderFavorites();
  }
  render();
  if (bookmarksOpen) {
    $<HTMLInputElement>('bm-touchid').checked = s.bookmarks.touchIDRequired;
    $('bm-lock').hidden = !s.bookmarks.touchIDRequired;
  }
});

api.onCommand((cmd) => {
  if (cmd === 'focus-address') {
    closePages();
    if (state.legacy) {
      legacyAddress.focus();
      legacyAddress.select();
    } else {
      openAddressBox('edit');
    }
  } else if (cmd === 'toggle-vault') {
    vaultOpen ? closeVault() : openVault();
  } else if (cmd === 'toggle-bookmarks') {
    bookmarksOpen ? closeBookmarks() : openBookmarks();
  }
});

void api.invoke<AppState>('ui:state').then((s) => {
  state = s;
  render();
});
