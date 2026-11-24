// Ranking eval for the on-device AI helper.
//
//   node scripts/eval-ranking.mjs [path/to/webscape-ai]
//
// Sends hand-graded pages (native/webscape-ai/eval/ranking-cases.json; grade 5 =
// best answer … 0 = unrelated) to the helper and reports, per query:
//   - spread:   standard deviation of scores, and how many distinct scores
//   - order:    of all page pairs with different grades, the share scored in the
//               right order (ties count as half)
//   - spearman: rank correlation between grade and score
// Needs Apple Intelligence (it runs the real model).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const bin = process.argv[2] ?? 'native/webscape-ai/.build/release/webscape-ai';
const cases = JSON.parse(readFileSync('native/webscape-ai/eval/ranking-cases.json', 'utf8'));

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const r = JSON.parse(line);
    waiting.get(r.id)?.(r);
    waiting.delete(r.id);
  } catch {}
});
let n = 0;
const ask = (payload) =>
  new Promise((resolve) => {
    const id = String(++n);
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
  });

const status = await ask({ op: 'status' });
if (!status.available) {
  console.error('Model unavailable:', status.detail);
  process.exit(1);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const ranks = (xs) => {
  const sorted = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    for (let k = i; k <= j; k++) r[sorted[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
const pearson = (a, b) => {
  const ma = mean(a), mb = mean(b);
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const den = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, y) => s + (y - mb) ** 2, 0));
  return den ? num / den : 0;
};

const totals = { sd: [], order: [], spearman: [], distinct: [], topSd: [], topOrder: [] };

/** Share of pairs (with different grades) scored in the right order; ties count half. */
function orderAccuracy(rows) {
  let good = 0, pairs = 0;
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.grade === b.grade) continue;
      pairs++;
      const hi = a.grade > b.grade ? a : b, lo = hi === a ? b : a;
      good += hi.score > lo.score ? 1 : hi.score === lo.score ? 0.5 : 0;
    }
  return pairs ? good / pairs : 0;
}
const started = Date.now();
for (const c of cases) {
  const rows = [];
  for (const p of c.pages) {
    const r = await ask({ op: 'rank', query: c.query, title: p.title, url: p.url, text: p.text });
    rows.push({ grade: p.grade, score: r.ok ? r.score : NaN, answers: r.answers ?? r.error, title: p.title, extra: r.factors, summary: r.summary, evidence: r.evidence });
  }
  const scored = rows.filter((r) => !Number.isNaN(r.score));
  const scores = scored.map((r) => r.score);
  // The pages that do answer (grades 3–5): the tier real searches are mostly made of.
  const top = scored.filter((r) => r.grade >= 3);
  const m = {
    sd: sd(scores),
    distinct: new Set(scores).size,
    order: orderAccuracy(scored),
    spearman: pearson(ranks(scored.map((r) => r.grade)), ranks(scores)),
    topSd: sd(top.map((r) => r.score)),
    topOrder: orderAccuracy(top),
  };
  for (const k of Object.keys(totals)) totals[k].push(m[k]);
  console.log(`\n“${c.query}”`);
  for (const r of rows)
    console.log(`  grade ${r.grade}  score ${String(r.score).padStart(3)}  ${String(r.answers).padEnd(7)} ${r.title.slice(0, 50)}${r.extra ? '  ' + JSON.stringify(r.extra) : ''}`);
  console.log(`  spread sd ${m.sd.toFixed(1)} · ${m.distinct} distinct · order ${(m.order * 100).toFixed(0)}% · spearman ${m.spearman.toFixed(2)} · answering pages: sd ${m.topSd.toFixed(1)}, order ${(m.topOrder * 100).toFixed(0)}%`);
}
console.log(
  `\nOVERALL  spread sd ${mean(totals.sd).toFixed(1)} · distinct ${mean(totals.distinct).toFixed(1)}/6 · ` +
    `order ${(mean(totals.order) * 100).toFixed(0)}% · spearman ${mean(totals.spearman).toFixed(2)}\n` +
    `ANSWERING PAGES (grades 3–5)  spread sd ${mean(totals.topSd).toFixed(1)} · order ${(mean(totals.topOrder) * 100).toFixed(0)}% · ${((Date.now() - started) / 1000).toFixed(0)} s`,
);
child.stdin.end();
