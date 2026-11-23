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

let state: AppState = { tabs: [], activeId: null, vaultUnlocked: false, vaultAvailable: true, loginForm: null, savePrompt: null };
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
const address = $<HTMLInputElement>('address');
let editingAddress = false;

function renderChrome(): void {
  const tab = activeTab();
  if (!editingAddress) address.value = tab?.url ?? '';
  ($('back') as HTMLButtonElement).disabled = !tab?.canGoBack;
  ($('forward') as HTMLButtonElement).disabled = !tab?.canGoForward;
  $('reload').classList.toggle('loading', !!tab?.loading);
  const lock = $('lock');
  lock.className = `lock ${!tab?.url ? 'none' : tab.secure ? 'secure' : 'insecure'}`;
  lock.title = !tab?.url ? '' : tab.secure ? 'Secure connection' : 'Not secure';
  const n = tab?.blocked ?? 0;
  $('shield-text').textContent = `${n} tracker${n === 1 ? '' : 's'} blocked`;
  $('shield').classList.toggle('active', n > 0);
  const vs = $('vault-state');
  vs.textContent = state.vaultUnlocked ? 'Unlocked' : 'Locked';
  vs.classList.toggle('on', state.vaultUnlocked);
}

address.addEventListener('focus', () => {
  editingAddress = true;
  address.select();
});
address.addEventListener('blur', () => {
  editingAddress = false;
  renderChrome();
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    address.value = activeTab()?.url ?? '';
    void api.invoke('ui:focusPage');
  }
});
$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = address.value.trim();
  if (!value) return;
  closeVault();
  void api.invoke('ui:navigate', value);
  address.blur();
});

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
  renderTabs();
  renderChrome();
  renderLoginCard();
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
    address.focus();
    address.select();
  } else if (cmd === 'toggle-vault') {
    vaultOpen ? closeVault() : openVault();
  }
});

void api.invoke<AppState>('ui:state').then((s) => {
  state = s;
  render();
});
