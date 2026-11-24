import { app } from 'electron';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * The browser's built-in AI: the `webscape-ai` helper (native/webscape-ai), a small
 * Swift program built on the LocalLM Lab SDK. It ships inside the app, runs models
 * on this Mac, and talks to us over stdin/stdout, one JSON object per line. No
 * server, no port. It starts on first use and is stopped when the browser quits.
 */

export interface ModelStatus {
  available: boolean;
  model: string;
  detail: string;
  contextWindow?: number;
}

export interface Verdict {
  score: number;
  answers: 'yes' | 'partly' | 'no';
  summary: string;
  evidence: string;
  /** Short reasons for the score, e.g. ["direct", "detailed", "focused"]. */
  factors: string[];
  /** A listicle: scored 0. */
  listicle: boolean;
}

type Reply = { id: string; ok: boolean; error?: string } & Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 90_000;

/** Where the helper lives: inside the app bundle when packaged, else the Swift build folder. */
export function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'webscape-ai', 'webscape-ai')
    : path.join(__dirname, '../../native/webscape-ai/.build/release/webscape-ai');
}

export class AIHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private waiting = new Map<string, { resolve: (r: Reply) => void; timer: NodeJS.Timeout }>();

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const bin = helperPath();
    if (process.platform !== 'darwin') throw new Error('On-device AI is only available on macOS.');
    if (!fs.existsSync(bin)) throw new Error('The AI helper isn’t built. Run “npm run build:ai”.');
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        return; // not one of our replies
      }
      const w = this.waiting.get(reply.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(reply.id);
      w.resolve(reply);
    });
    child.stderr.on('data', (d) => console.warn('[webscape-ai]', String(d).trim()));
    const fail = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.resolve({ id: '', ok: false, error: why });
      }
      this.waiting.clear();
    };
    child.on('exit', (code) => fail(`The AI helper stopped (exit code ${code}).`));
    child.on('error', (err) => fail(`The AI helper couldn’t start: ${err.message}`));
    return child;
  }

  private request(op: string, payload: Record<string, unknown> = {}): Promise<Reply> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.start();
    } catch (err) {
      return Promise.resolve({ id: '', ok: false, error: (err as Error).message });
    }
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, ok: false, error: 'The on-device model took too long.' });
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
    });
  }

  async status(): Promise<ModelStatus> {
    const r = await this.request('status');
    if (!r.ok) return { available: false, model: 'system', detail: r.error ?? 'Unavailable' };
    return {
      available: r.available === true,
      model: String(r.model ?? 'system'),
      detail: String(r.detail ?? ''),
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : undefined,
    };
  }

  async rank(query: string, page: { title: string; url: string; text: string }): Promise<Verdict> {
    const r = await this.request('rank', { query, ...page });
    if (!r.ok) throw new Error(r.error ?? 'The model couldn’t judge this page.');
    const answers = r.answers === 'yes' || r.answers === 'partly' ? r.answers : 'no';
    return {
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      answers,
      summary: String(r.summary ?? ''),
      evidence: String(r.evidence ?? ''),
      factors: Array.isArray(r.factors) ? r.factors.map(String).slice(0, 4) : [],
      listicle: r.listicle === true,
    };
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
