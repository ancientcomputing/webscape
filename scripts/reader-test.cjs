// Tests the Answers page reader (src/main/page-reader.ts) against a local web server.
// Run after `npm run build`:  npx electron scripts/reader-test.cjs
//
//   - an ordinary page is read as plain HTML: its scripts aren't even requested
//   - a page that builds its text with JavaScript is read by the JavaScript pass
//   - the JavaScript pass loads no images and opens no windows
//   - a page with no text at all comes back empty, without errors
const { app } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');

const ARTICLE = 'Mount Kilimanjaro is the tallest mountain in Africa, rising 5,895 metres above sea level. '.repeat(6);
const requests = [];

const server = http.createServer((req, res) => {
  requests.push(req.url);
  const html = (body) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Test</title></head><body>${body}</body></html>`);
  };
  switch (req.url) {
    case '/static':
      return html(`<article><h1>Kilimanjaro</h1><p>${ARTICLE}</p></article><script src="/static.js"></script>`);
    case '/js':
      return html('<div id="app">Loading…</div><img src="/pixel.png"><script src="/app.js"></script>');
    case '/app.js':
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`setTimeout(() => {
        document.getElementById('app').innerHTML = '<article><h1>Kilimanjaro</h1><p>${ARTICLE}</p></article>';
        const img = new Image(); img.src = '/tracker.gif';
        window.open('/popup');
      }, 300);`);
    case '/empty':
      return html('<div id="app"></div><script>/* never renders anything */</script>');
    default:
      res.writeHead(404);
      return res.end();
  }
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { PageReader } = require('../dist/main/page-reader.js');
  const reader = new PageReader();
  const step = (msg) => console.log(`  ✓ ${msg}`);
  try {
    const plain = await reader.read(`${base}/static`);
    assert.equal(plain.rendered, false);
    assert.match(plain.text, /tallest mountain in Africa/);
    assert.ok(!requests.includes('/static.js'), 'plain reading must not fetch scripts');
    step('reads an ordinary page as plain HTML, without running or fetching scripts');

    const js = await reader.read(`${base}/js`);
    assert.equal(js.rendered, true, 'should need the JavaScript pass');
    assert.match(js.text, /tallest mountain in Africa/);
    step('reads a JavaScript-only page with the JavaScript pass');

    assert.ok(!requests.includes('/pixel.png') && !requests.includes('/tracker.gif'), `images must not load (got ${requests})`);
    assert.ok(!requests.includes('/popup'), 'pop-ups must not open');
    step('the JavaScript pass loads no images and opens no pop-ups');

    const empty = await reader.read(`${base}/empty`);
    assert.ok(empty.text.length < 200);
    step('a page with no text comes back empty, without errors');

    console.log('READER TEST PASSED');
    app.exit(0);
  } catch (err) {
    console.error('READER TEST FAILED:', err);
    app.exit(1);
  } finally {
    reader.dispose();
    server.close();
  }
});
