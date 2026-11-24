import { session, WebContentsView } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { hardenReaderSession } from './privacy';

/**
 * Reads a web page's text for the Answers view, as privately as it can.
 *
 * 1. Plain HTML: one request, no JavaScript, no images, no cookies, in a
 *    throwaway in-memory session. Most pages are fully readable this way.
 * 2. JavaScript pass (fallback): if that gives almost no text, the page is
 *    rendered in a hidden view in a locked-down throwaway session (tracker
 *    blocker on; images, media, fonts, pop-ups, permissions and downloads
 *    refused; sound muted), and its finished DOM is read. At most two at a time.
 *
 * Either way the text is extracted inertly by src/ui/reader.ts, and the session
 * is wiped as soon as the page is read.
 */

export interface ReadPage {
  title: string;
  description: string;
  text: string;
  /** Needed the JavaScript pass. */
  rendered: boolean;
}

const FETCH_TIMEOUT_MS = 12_000;
const RENDER_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
/** Less readable text than this means the page builds its content with JavaScript. */
export const MIN_TEXT = 200;
const MAX_RENDERS = 2;

export class PageReader {
  private extractor: WebContentsView | null = null;
  private extractorReady: Promise<void> | null = null;
  private renders = 0;
  private renderQueue: (() => void)[] = [];

  async read(url: string): Promise<ReadPage> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Not a web page.');
    const plain = await this.readHtml(url);
    if (plain.text.length >= MIN_TEXT) return plain;
    // Almost nothing without JavaScript: render it.
    try {
      const rendered = await this.withRenderSlot(() => this.readRendered(url));
      return rendered.text.length > plain.text.length ? rendered : plain;
    } catch {
      return plain;
    }
  }

  /** Step 1: one plain HTML request. */
  private async readHtml(url: string): Promise<ReadPage> {
    const ses = session.fromPartition(`reader-${crypto.randomUUID()}`); // no "persist:" → memory only
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let html: string;
      try {
        const res = await ses.fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          credentials: 'omit',
          headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8', 'Sec-GPC': '1', DNT: '1' },
        });
        if (!res.ok) throw new Error(`The site answered with an error (${res.status}).`);
        const type = res.headers.get('content-type') ?? '';
        if (!/text\/html|application\/xhtml|text\/plain/.test(type)) throw new Error('Not a web page.');
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > MAX_HTML_BYTES) throw new Error('The page is too large to read.');
        const buf = await res.arrayBuffer();
        html = new TextDecoder().decode(buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf);
        if (/text\/plain/.test(type)) return { title: '', description: '', text: html.slice(0, 20_000), rendered: false };
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw new Error('The site took too long to respond.');
        throw err;
      } finally {
        clearTimeout(timer);
      }
      return { ...(await this.extract(html)), rendered: false };
    } finally {
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    }
  }

  /** Step 2: render the page with JavaScript in a hidden, locked-down view and read the result. */
  private async readRendered(url: string): Promise<ReadPage> {
    const partition = `reader-js-${crypto.randomUUID()}`; // memory only
    const ses = session.fromPartition(partition);
    hardenReaderSession(ses);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        images: false,
        webgl: false,
        spellcheck: false,
        backgroundThrottling: false,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    const wc = view.webContents;
    view.setBounds({ x: 0, y: 0, width: 1280, height: 900 }); // a normal desktop layout, never shown
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, to) => {
      if (!/^https?:/i.test(to)) e.preventDefault();
    });
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('The page took too long to render.')), RENDER_TIMEOUT_MS),
      );
      const work = (async () => {
        await wc.loadURL(url).catch(() => {}); // some pages "fail" while still rendering fine
        // Wait for the content to settle: text stops growing (checked every 400 ms, up to ~6 s).
        let last = -1;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 400));
          const length: number = await wc.executeJavaScriptInIsolatedWorld(999, [
            { code: '(document.body && document.body.textContent || "").length' },
          ]);
          if (length > MIN_TEXT && length === last) break;
          last = length;
        }
        const html: string = await wc.executeJavaScriptInIsolatedWorld(999, [
          { code: 'document.documentElement ? document.documentElement.outerHTML : ""' },
        ]);
        return { ...(await this.extract(html)), rendered: true };
      })();
      return await Promise.race([work, timeout]);
    } finally {
      if (!wc.isDestroyed()) wc.close();
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
    }
  }

  private async withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.renders >= MAX_RENDERS) await new Promise<void>((r) => this.renderQueue.push(r));
    this.renders++;
    try {
      return await fn();
    } finally {
      this.renders--;
      this.renderQueue.shift()?.();
    }
  }

  /** HTML → readable text, in the hidden extractor page (src/ui/reader.ts). */
  private async extract(html: string): Promise<{ title: string; description: string; text: string }> {
    if (!this.extractor || this.extractor.webContents.isDestroyed()) {
      const view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
      });
      view.webContents.on('will-navigate', (e) => e.preventDefault());
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.extractor = view;
      this.extractorReady = view.webContents.loadFile(path.join(__dirname, '../ui/reader.html'));
    }
    const view = this.extractor;
    await this.extractorReady;
    return view.webContents.executeJavaScript(`extract(${JSON.stringify(html)})`);
  }

  dispose(): void {
    if (this.extractor && !this.extractor.webContents.isDestroyed()) this.extractor.webContents.close();
    this.extractor = null;
  }
}
