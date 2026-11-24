// The page reader: turns a fetched HTML page into its readable text, for the
// on-device model to judge. Runs in a hidden, sandboxed page of ours. DOMParser
// builds an inert document: the page's scripts never run and nothing it
// references (images, styles, frames) is loaded.
//
// Approach follows the LocalLM SDK's WebPageExtractor: drop scripts, navigation,
// headers, footers, asides, forms and boilerplate; pick the main content (an
// article, main, or the element with the most paragraph text); keep headings,
// paragraphs and lists.

const DROP_TAGS =
  'script,style,noscript,iframe,frame,object,embed,template,svg,canvas,video,audio,' +
  'form,button,input,select,textarea,nav,header,footer,aside,dialog,menu';
const DROP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alert', 'menu']);
const BOILERPLATE =
  /(^|[\s_-])(nav|navbar|menu|footer|sidebar|cookie|cookies|consent|gdpr|banner|advert|ads|ad-slot|sponsor|promo|share|social|breadcrumbs?|related|newsletter|popup|modal|subscribe|comments?|signup|paywall)([\s_-]|$)/i;
const HIDDEN_CLASSES = /(^|\s)(sr-only|visually-hidden|visuallyhidden|screen-reader-text|hidden)(\s|$)/i;
const KEEP = new Set(['HTML', 'BODY', 'MAIN', 'ARTICLE']);
const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'BLOCKQUOTE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DL', 'DT', 'DD', 'FIGCAPTION', 'BR', 'HR',
]);
const MAX_CHARS = 20_000;

function prune(doc: Document): void {
  doc.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[role],[class],[id],[hidden],[aria-hidden],[style]'))) {
    if (KEEP.has(el.tagName)) continue;
    const role = el.getAttribute('role') ?? '';
    const marker = `${el.getAttribute('class') ?? ''} ${el.id}`;
    const style = (el.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase();
    if (
      DROP_ROLES.has(role) ||
      el.hasAttribute('hidden') ||
      el.getAttribute('aria-hidden') === 'true' ||
      style.includes('display:none') ||
      style.includes('visibility:hidden') ||
      HIDDEN_CLASSES.test(marker) ||
      BOILERPLATE.test(marker)
    ) {
      el.remove();
    }
  }
}

function paragraphText(el: Element): number {
  let n = 0;
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'P' || child.tagName === 'LI' || child.tagName === 'PRE' || child.tagName === 'BLOCKQUOTE') {
      n += (child.textContent ?? '').trim().length;
    }
  }
  return n;
}

function mainContent(doc: Document): Element {
  const longest = (els: Element[]) =>
    els.sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0];
  const articles = Array.from(doc.querySelectorAll('article'));
  const article = articles.length ? longest(articles) : undefined;
  if (article && (article.textContent ?? '').trim().length > 400) return article;
  const main = doc.querySelector('main, [role="main"]');
  if (main && (main.textContent ?? '').trim().length > 400) return main;
  // The element holding the most paragraph text.
  let best: Element = doc.body;
  let bestScore = 0;
  for (const el of Array.from(doc.body?.querySelectorAll('div, section, td') ?? [])) {
    const score = paragraphText(el);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return bestScore > 200 ? best : doc.body;
}

function toText(root: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push((node.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    const block = BLOCK.has(tag);
    if (block) out.push('\n');
    if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} `);
    else if (tag === 'LI') out.push('- ');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push('\n');
  };
  walk(root);
  return out
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line || (all[i - 1] ?? '') !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ReadPage {
  title: string;
  description: string;
  text: string;
}

function extract(html: string): ReadPage {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (sel: string) => doc.querySelector<HTMLMetaElement>(sel)?.content?.trim() ?? '';
  const title = meta('meta[property="og:title"]') || (doc.title ?? '').trim();
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  prune(doc);
  if (!doc.body) return { title, description, text: '' };
  const text = toText(mainContent(doc)).slice(0, MAX_CHARS);
  return { title, description, text };
}

(window as unknown as { extract: typeof extract }).extract = extract;
