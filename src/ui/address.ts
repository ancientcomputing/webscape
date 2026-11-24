// The floating address box. Two modes:
//   peek: shown while hovering the sidebar address; displays the whole URL.
//         Click it to edit. Moving the mouse away closes it.
//   edit: a wide field for typing a full address. Enter goes, Escape cancels.
//         Matching bookmarks are suggested as you type (from the local list only).
import type { AppState, Bookmark, BookmarkData } from '../shared/types.js';

interface Bridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onState(cb: (s: AppState) => void): void;
  onPopover(cb: (p: { mode: 'peek' | 'edit'; pad: number }) => void): void;
  onBookmarks(cb: (b: BookmarkData | null) => void): void;
}
const api = (window as unknown as { webscape: Bridge }).webscape;

const pop = document.getElementById('pop') as HTMLDivElement;
const peek = document.getElementById('peek') as HTMLDivElement;
const edit = document.getElementById('edit') as HTMLTextAreaElement;
const lock = document.getElementById('lock') as HTMLSpanElement;
const hint = document.getElementById('hint') as HTMLDivElement;
const star = document.getElementById('star') as HTMLButtonElement;
const suggest = document.getElementById('suggest') as HTMLUListElement;

let state: AppState | null = null;
let mode: 'peek' | 'edit' = 'peek';
let bookmarks: Bookmark[] = [];
let matches: Bookmark[] = [];
let selected = -1;

const activeTab = () => state?.tabs.find((t) => t.id === state!.activeId);

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** Show the URL with the host emphasised, so look-alike domains stand out. */
function renderStar(): void {
  const tab = activeTab();
  star.hidden = !tab?.url || !state?.bookmarks.available;
  star.classList.toggle('on', !!state?.bookmarks.activeId);
  star.title = state?.bookmarks.activeId ? 'Remove bookmark' : 'Bookmark this page (⌘D)';
}

function renderPeek(): void {
  const tab = activeTab();
  const url = tab?.url ?? '';
  lock.className = `pop-lock ${!url ? 'none' : tab!.secure ? 'secure' : 'insecure'}`;
  if (!url) {
    peek.replaceChildren(span('empty', 'Search or enter address'));
    return;
  }
  try {
    const u = new URL(url);
    const scheme = `${u.protocol}//`;
    const rest = url.slice(scheme.length + u.host.length);
    peek.replaceChildren(span('dim', scheme), span('host', u.host), span('rest', rest));
  } catch {
    peek.replaceChildren(span('rest', url));
  }
}

function autosize(): void {
  edit.style.height = 'auto';
  edit.style.height = `${edit.scrollHeight}px`;
}

/** Tell the main process how tall the view must be. */
function reportHeight(): void {
  const pad = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
  void api.invoke('ui:addressPopoverHeight', Math.ceil(pop.getBoundingClientRect().height + pad * 2));
}
new ResizeObserver(reportHeight).observe(pop);

// --- Bookmark suggestions ------------------------------------------------------
function findMatches(query: string): Bookmark[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = bookmarks
    .map((b) => {
      const title = b.title.toLowerCase();
      const url = b.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
      if (!terms.every((t) => title.includes(t) || url.includes(t))) return null;
      // Prefer addresses that start with what you typed, then title matches.
      const score = (url.startsWith(terms[0]) ? 0 : 2) + (title.includes(terms[0]) ? 0 : 1);
      return { b, score };
    })
    .filter((x): x is { b: Bookmark; score: number } => !!x)
    .sort((a, z) => a.score - z.score || a.b.title.localeCompare(z.b.title));
  return scored.slice(0, 6).map((x) => x.b);
}

function renderSuggestions(): void {
  suggest.hidden = matches.length === 0;
  suggest.replaceChildren(
    ...matches.map((b, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.className = i === selected ? 'sel' : '';
      let host = '';
      let rest = b.url;
      try {
        const u = new URL(b.url);
        host = u.host;
        rest = b.url.slice(`${u.protocol}//`.length + u.host.length);
      } catch {
        /* show as is */
      }
      const urlLine = span('s-url', '');
      const strong = document.createElement('b');
      strong.textContent = host;
      urlLine.append(strong, document.createTextNode(rest));
      li.append(span('s-star', '★'), span('s-title', b.title), urlLine);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        go(b.url);
      });
      return li;
    }),
  );
  reportHeight();
}

function updateSuggestions(): void {
  matches = findMatches(edit.value);
  selected = -1;
  renderSuggestions();
}

function go(value: string): void {
  matches = [];
  renderSuggestions();
  void api.invoke('ui:navigate', value);
}

function setMode(next: 'peek' | 'edit'): void {
  mode = next;
  pop.dataset.mode = next;
  hint.textContent = next === 'edit' ? 'Return to go · Esc to cancel' : 'Click to edit';
  matches = [];
  selected = -1;
  renderSuggestions();
  renderStar();
  if (next === 'edit') {
    edit.value = activeTab()?.url ?? '';
    autosize();
    edit.focus();
    edit.select();
  } else {
    renderPeek();
  }
  reportHeight();
}

function close(refocusPage: boolean): void {
  void api.invoke('ui:addressPopoverClose', refocusPage);
}

api.onPopover(({ mode: m, pad }) => {
  document.body.style.setProperty('--pad', `${pad}px`);
  setMode(m);
});

api.onState((s) => {
  state = s;
  renderStar();
  if (mode === 'peek') renderPeek();
});
const setBookmarks = (data: BookmarkData | null) => {
  bookmarks = data?.bookmarks ?? [];
};
api.onBookmarks(setBookmarks);
void api.invoke<BookmarkData | null>('ui:bookmarks').then(setBookmarks);

star.addEventListener('mousedown', (e) => e.stopPropagation()); // don't switch peek -> edit
star.addEventListener('click', () => void api.invoke('ui:bookmarkToggle'));
void api.invoke<AppState>('ui:state').then((s) => {
  state = s;
  renderPeek();
});

// Peek: click to start editing; leave to close.
pop.addEventListener('mousedown', (e) => {
  if (mode === 'peek') {
    e.preventDefault();
    setMode('edit');
  }
});
document.documentElement.addEventListener('mouseleave', () => {
  if (mode === 'peek') close(false);
});

// Edit
edit.addEventListener('input', () => {
  autosize();
  updateSuggestions();
});
edit.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && matches.length) {
    e.preventDefault();
    selected = (selected + 1) % matches.length;
    renderSuggestions();
  } else if (e.key === 'ArrowUp' && matches.length) {
    e.preventDefault();
    selected = selected <= 0 ? matches.length - 1 : selected - 1;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selected >= 0 && matches[selected]) return go(matches[selected].url);
    const value = edit.value.replace(/\s*\n\s*/g, '').trim();
    if (value) go(value);
    else close(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (matches.length) {
      matches = [];
      renderSuggestions();
    } else close(true);
  }
});
