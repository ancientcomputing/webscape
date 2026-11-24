import { WebContents } from 'electron';
import type { InsightsState, ResultInsight, SearchView } from '../shared/types';
import { AIHelper } from './ai';
import { MIN_TEXT, PageReader } from './page-reader';

/**
 * "Analyze results": for a search results page, read the top results and ask the
 * on-device model how likely each one answers the search.
 *
 * Privacy:
 * - Only runs when you click Analyze.
 * - The result list is read from the DuckDuckGo page you already loaded. We don't
 *   ask DuckDuckGo for anything again.
 * - Each result page is read by PageReader: plain HTML first; a locked-down
 *   JavaScript render only for pages that show no text without it. Throwaway
 *   in-memory sessions, wiped as soon as the page is read.
 * - The model runs on this Mac. Results live only in the tab's memory.
 */

const MAX_RESULTS = 8;
const READ_CONCURRENCY = 3;

/** The search query if this is a DuckDuckGo results page. */
export function searchQuery(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)duckduckgo\.com$/.test(u.hostname)) return null;
    if (u.pathname !== '/' && u.pathname !== '/html/' && u.pathname !== '/lite/') return null;
    const q = u.searchParams.get('q')?.trim();
    // Only web results (not images, videos, maps...).
    const ia = u.searchParams.get('ia');
    if (!q || (ia && ia !== 'web')) return null;
    return q;
  } catch {
    return null;
  }
}

/** Runs in the results tab (an isolated world, invisible to the page's own scripts). */
const EXTRACT_RESULTS = `(async () => {
  for (let i = 0; i < 50 && !document.querySelector('article[data-testid="result"]'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return Array.from(document.querySelectorAll('article[data-testid="result"]'))
    .filter((a) => a.getAttribute('data-nrn') === 'result')
    .map((a) => {
      const link = a.querySelector('[data-testid="result-title-a"]');
      const snippet = a.querySelector('[data-result="snippet"]');
      return {
        url: link ? link.href : '',
        title: link ? link.textContent.trim() : '',
        snippet: snippet ? snippet.textContent.trim() : '',
      };
    })
    .filter((r) => /^https?:/.test(r.url));
})()`;

interface Analysis extends InsightsState {
  tabId: number;
  cancelled: boolean;
}

export class Insights {
  private byTab = new Map<number, Analysis>();
  private reader = new PageReader();

  constructor(
    private readonly ai: AIHelper,
    private readonly changed: () => void,
  ) {}

  /**
   * The panel state for a tab. An analysis belongs to its search: once the tab
   * shows anything else (another search, a result it opened), it's dropped.
   */
  state(tabId: number, url: string): InsightsState | null {
    const a = this.byTab.get(tabId);
    if (!a) return null;
    if (searchQuery(url) !== a.query) {
      this.cancel(tabId);
      return null;
    }
    const { query, view, status, detail, model, results } = a;
    return { query, view, status, detail, model, results };
  }

  /** Which view the tab's search is showing ('results' when nothing was analyzed). */
  view(tabId: number): SearchView {
    return this.byTab.get(tabId)?.view ?? 'results';
  }

  setView(tabId: number, view: SearchView): void {
    const a = this.byTab.get(tabId);
    if (a && a.view !== view) {
      a.view = view;
      this.changed();
    }
  }

  /** Forget analyses for tabs that no longer exist. */
  prune(liveTabIds: Set<number>): void {
    for (const tabId of [...this.byTab.keys()]) if (!liveTabIds.has(tabId)) this.cancel(tabId);
  }

  cancel(tabId: number): void {
    const a = this.byTab.get(tabId);
    if (a) a.cancelled = true;
    this.byTab.delete(tabId);
  }

  /**
   * Analyze the tab's search and show it in `view`. `auto` is true when started by
   * the "show answers first" preference rather than a click: then, if the model
   * can't run, the tab quietly stays on the results page.
   */
  async start(tabId: number, wc: WebContents, view: SearchView = 'answers', auto = false): Promise<void> {
    const query = searchQuery(wc.getURL());
    if (!query) return;
    const existing = this.byTab.get(tabId);
    if (existing && existing.query === query && existing.status !== 'error' && existing.status !== 'unavailable') {
      if (!auto) this.setView(tabId, view);
      return;
    }
    this.cancel(tabId);
    const a: Analysis = {
      tabId, query, view, status: 'starting', detail: 'Checking the on-device model…',
      model: '', results: [], cancelled: false,
    };
    this.byTab.set(tabId, a);
    this.changed();

    const model = await this.ai.status();
    if (a.cancelled) return;
    a.model = model.model === 'system' ? 'Apple on-device model' : model.model;
    if (!model.available) {
      a.status = 'unavailable';
      a.detail = model.detail;
      if (auto) a.view = 'results';
      this.changed();
      return;
    }

    let found: { url: string; title: string; snippet: string }[] = [];
    try {
      found = await wc.executeJavaScriptInIsolatedWorld(4242, [{ code: EXTRACT_RESULTS }]);
    } catch {
      /* page went away */
    }
    if (a.cancelled) return;
    const seen = new Set<string>();
    a.results = found
      .filter((r) => !seen.has(r.url) && seen.add(r.url))
      .slice(0, MAX_RESULTS)
      .map((r) => ({ ...r, host: hostOf(r.url), status: 'queued' as const }));
    if (!a.results.length) {
      a.status = 'error';
      a.detail = 'No results found on this page.';
      this.changed();
      return;
    }
    a.status = 'running';
    a.detail = `Reading ${a.results.length} pages privately on this Mac…`;
    this.changed();

    // Read pages a few at a time; the model judges them one at a time as they arrive.
    let judging: Promise<void> = Promise.resolve();
    const queue = [...a.results];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (a.cancelled) return;
        const result = r;
        result.status = 'reading';
        this.changed();
        let text = '';
        try {
          const page = await this.reader.read(result.url);
          if (page.title && !result.title) result.title = page.title;
          result.rendered = page.rendered;
          text = [page.description, page.text].filter(Boolean).join('\n\n');
          if (text.length < MIN_TEXT) throw new Error('This page shows almost no text, even with JavaScript, so it couldn’t be read.');
        } catch (err) {
          result.status = 'error';
          result.error = (err as Error).message;
          this.changed();
          continue;
        }
        if (a.cancelled) return;
        result.status = 'judging';
        this.changed();
        judging = judging.then(async () => {
          if (a.cancelled) return;
          try {
            const v = await this.ai.rank(a.query, { title: result.title, url: result.url, text });
            Object.assign(result, v, { status: 'done' as const });
          } catch (err) {
            result.status = 'error';
            result.error = (err as Error).message;
          }
          this.changed();
        });
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    await judging;
    if (a.cancelled) return;
    a.status = 'done';
    const done = a.results.filter((r) => r.status === 'done').length;
    a.detail = `Read ${done} of ${a.results.length} pages on this Mac.`;
    this.changed();
  }

  dispose(): void {
    for (const tabId of [...this.byTab.keys()]) this.cancel(tabId);
    this.reader.dispose();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
