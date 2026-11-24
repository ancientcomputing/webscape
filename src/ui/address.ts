// The floating address box. Two modes:
//   peek: shown while hovering the sidebar address; displays the whole URL.
//         Click it to edit. Moving the mouse away closes it.
//   edit: a wide field for typing a full address. Enter goes, Escape cancels.
import type { AppState } from '../shared/types.js';

interface Bridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onState(cb: (s: AppState) => void): void;
  onPopover(cb: (p: { mode: 'peek' | 'edit'; pad: number }) => void): void;
}
const api = (window as unknown as { webscape: Bridge }).webscape;

const pop = document.getElementById('pop') as HTMLDivElement;
const peek = document.getElementById('peek') as HTMLDivElement;
const edit = document.getElementById('edit') as HTMLTextAreaElement;
const lock = document.getElementById('lock') as HTMLSpanElement;
const hint = document.getElementById('hint') as HTMLDivElement;

let state: AppState | null = null;
let mode: 'peek' | 'edit' = 'peek';

const activeTab = () => state?.tabs.find((t) => t.id === state!.activeId);

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** Show the URL with the host emphasised, so look-alike domains stand out. */
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

function setMode(next: 'peek' | 'edit'): void {
  mode = next;
  pop.dataset.mode = next;
  hint.textContent = next === 'edit' ? 'Return to go · Esc to cancel' : 'Click to edit';
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
  if (mode === 'peek') renderPeek();
});
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
edit.addEventListener('input', autosize);
edit.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const value = edit.value.replace(/\s*\n\s*/g, '').trim();
    if (value) void api.invoke('ui:navigate', value);
    else close(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close(true);
  }
});
