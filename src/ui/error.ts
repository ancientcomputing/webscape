const params = new URLSearchParams(location.search);
const url = params.get('u') ?? '';
const code = params.get('e') ?? 'Unknown error';

(document.getElementById('url') as HTMLElement).textContent = url;
(document.getElementById('code') as HTMLElement).textContent = code;
document.title = `Can't reach ${(() => {
  try {
    return new URL(url).host;
  } catch {
    return 'this page';
  }
})()}`;

const retry = document.getElementById('retry') as HTMLAnchorElement;
if (/^https?:/i.test(url)) retry.href = url;
else retry.hidden = true;

export {};
