// Runs in every web page, in an isolated world the page's own scripts cannot see.
// It does three things, all in the top frame only:
//   1. tells the browser whether the page shows a password field,
//   2. reports a login when a form with a password is submitted (so the user can save it),
//   3. fills a saved login when the user asks for it from the sidebar.
// Passwords are never filled automatically: only on an explicit click.
import { ipcRenderer } from 'electron';

if (window.top === window) {
  const isVisible = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  const passwordFields = (): HTMLInputElement[] =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(isVisible);

  const USERNAME_TYPES = new Set(['text', 'email', 'tel']);

  const usernameFor = (pw: HTMLInputElement): HTMLInputElement | null => {
    const scope: ParentNode = pw.form ?? document;
    const fields = Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter(
      (i) => USERNAME_TYPES.has(i.type) && isVisible(i),
    );
    const tagged = fields.find((i) => /\b(username|email)\b/.test(i.autocomplete));
    if (tagged) return tagged;
    // Otherwise: the closest text field before the password field.
    const before = fields.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.at(-1) ?? null;
  };

  // 1. Login form detection --------------------------------------------------
  let reported: boolean | null = null;
  const report = () => {
    const has = passwordFields().length > 0;
    if (has !== reported) {
      reported = has;
      ipcRenderer.send('page:login-form', has);
    }
  };
  let timer: number | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(report, 250);
  };
  window.addEventListener('DOMContentLoaded', () => {
    report();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'style', 'class', 'hidden'],
    });
  });

  // 2. Capture logins on submit --------------------------------------------------
  let lastSent = '';
  const capture = () => {
    const fields = passwordFields().filter((p) => p.value);
    if (!fields.length) return;
    // On sign-up / change-password forms the new password is the last filled field.
    const pw = fields.find((p) => p.autocomplete === 'new-password') ?? fields.at(-1)!;
    const username = usernameFor(pw)?.value.trim() ?? '';
    const key = `${username}\u0000${pw.value}`;
    if (key === lastSent) return;
    lastSent = key;
    ipcRenderer.send('page:credentials', { username, password: pw.value });
  };
  document.addEventListener('submit', capture, true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) capture();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (el) capture();
    },
    true,
  );

  // 3. Fill on request ----------------------------------------------------------
  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const setValue = (el: HTMLInputElement, value: string) => {
    el.focus();
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  ipcRenderer.on('page:fill', (_e, login: { username: string; password: string }) => {
    const fields = passwordFields();
    const pw = fields.find((p) => p.autocomplete === 'current-password') ?? fields[0];
    const user = pw ? usernameFor(pw) : document.querySelector<HTMLInputElement>('input[autocomplete~="username"], input[type="email"]');
    if (user && login.username) setValue(user, login.username);
    if (pw) setValue(pw, login.password);
    lastSent = `${login.username}\u0000${login.password}`; // don't offer to re-save what we just filled
  });
}
