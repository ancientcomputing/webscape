import type { AppState, NavAction, TabState, UICommand, VaultEntrySummary } from '../shared/types.js';

interface Bridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onState(cb: (s: AppState) => void): void;
  onCommand(cb: (c: UICommand) => void): void;
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

let state: AppState = { tabs: [], activeId: null, vaultUnlocked: false, vaultAvailable: true, legacy: false, theme: 'system', dark: true, loginForm: null, savePrompt: null };
let vaultOpen = false;
let fillChoices: { origin: string; entries: VaultEntrySummary[] } | null = null;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer: number | undefined;
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2400);
}

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
        closeVault();
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
    closeVault();
    void api.invoke('ui:navigate', value);
    field.blur();
  });
}

const nav = (a: NavAction) => () => void api.invoke('ui:nav', a);
$('back').addEventListener('click', nav('back'));
$('forward').addEventListener('click', nav('forward'));
$('reload').addEventListener('click', () => void api.invoke('ui:nav', activeTab()?.loading ? 'stop' : 'reload'));
const newTab = () => {
  closeVault();
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
    closeVault();
    void api.invoke('ui:home');
  },
  search: () => {
    closeVault();
    void api.invoke('ui:navigate', 'https://duckduckgo.com/');
  },
  passwords: () => (vaultOpen ? closeVault() : openVault()),
  'new-tab': newTab,
  modern: () => void api.invoke('ui:setLegacy', false),
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
  if (e.key === 'Escape' && vaultOpen) closeVault();
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
// Wiring
// ---------------------------------------------------------------------------
function render(): void {
  renderChrome();
  renderTabs();
  renderLoginCard();
  requestAnimationFrame(reportLayout); // the page slot moves when the look changes
}

let prevUnlocked = false;
api.onState((s) => {
  const activeChanged = s.activeId !== state.activeId;
  state = s;
  if (activeChanged) fillChoices = null;
  if (prevUnlocked !== s.vaultUnlocked) {
    prevUnlocked = s.vaultUnlocked;
    if (!s.vaultUnlocked) fillChoices = null;
    if (vaultOpen) void refreshVault();
  }
  render();
});

api.onCommand((cmd) => {
  if (cmd === 'focus-address') {
    closeVault();
    if (state.legacy) {
      legacyAddress.focus();
      legacyAddress.select();
    } else {
      openAddressBox('edit');
    }
  } else if (cmd === 'toggle-vault') {
    vaultOpen ? closeVault() : openVault();
  }
});

void api.invoke<AppState>('ui:state').then((s) => {
  state = s;
  render();
});
