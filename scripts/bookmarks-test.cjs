// End-to-end test of bookmarks: encryption through the real keychain, tracking
// parameter removal, folders, undo, and bookmarks.html import/export.
// Run after `npm run build`:  npx electron scripts/bookmarks-test.cjs
//
// Uses its own app name (own keychain entry) and a temp folder; never touches
// your real bookmarks. Touch ID is skipped so it runs unattended.
const { app, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setName('Webscape Wanderer Bookmarks Test');
systemPreferences.canPromptTouchID = () => false;

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://news.example/?utm_source=x&amp;id=7" ADD_DATE="1700000001">News &amp; Views</A>
        <DT><H3>Work</H3>
        <DL><p>
            <DT><A HREF="https://docs.example/a">Docs</A>
        </DL><p>
        <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://recipes.example/">Recipes &#8211; best</A>
        <DT><A HREF="https://news.example/?id=7">Duplicate of news</A>
    </DL><p>
</DL><p>`;

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscape-bookmarks-test-'));
  const file = path.join(dir, 'bookmarks.bin');
  const { BookmarkStore, cleanUrl, parseBookmarksHtml, FAVORITES } = require('../dist/main/bookmarks.js');
  const step = (msg) => console.log(`  ✓ ${msg}`);
  try {
    // --- Tracking parameters ---------------------------------------------------
    assert.equal(cleanUrl('https://a.example/p?utm_source=x&utm_medium=y&id=3&fbclid=z'), 'https://a.example/p?id=3');
    assert.equal(cleanUrl('https://a.example/p?gclid=1#top'), 'https://a.example/p#top');
    assert.equal(cleanUrl('https://www.youtube.com/watch?v=abc&si=TRACK'), 'https://www.youtube.com/watch?v=abc');
    assert.equal(cleanUrl('https://other.example/?si=keep'), 'https://other.example/?si=keep', 'si is only stripped on sites that use it for tracking');
    assert.equal(cleanUrl('javascript:alert(1)'), null);
    assert.equal(cleanUrl('file:///etc/passwd'), null);
    step('removes tracking parameters, keeps meaningful ones, rejects non-web links');

    // --- Store ------------------------------------------------------------------
    let changes = 0;
    const store = new BookmarkStore(file, () => changes++);
    await store.init(false);
    assert.equal(store.available, true);
    assert.equal(store.unlocked, true, 'unlocks at launch when Touch ID is not required');
    assert.deepEqual(store.snapshot().folders, [FAVORITES]);
    step('starts unlocked with a Favorites folder');

    const a = await store.add({ url: 'https://secret-diary.example/entry?utm_campaign=c', title: 'My private diary' });
    assert.equal(a.url, 'https://secret-diary.example/entry');
    assert.equal(a.folder, FAVORITES);
    const again = await store.add({ url: 'https://secret-diary.example/entry', title: 'Dup' });
    assert.equal(again.id, a.id, 'adding the same page twice returns the existing bookmark');
    assert.equal(store.idForUrl('https://secret-diary.example/entry?fbclid=1'), a.id, 'star lookup ignores tracking params');
    const onDisk = fs.readFileSync(file);
    assert.ok(!onDisk.includes('secret-diary'), 'URLs must not be stored in plain text');
    assert.ok(!onDisk.includes('My private diary'), 'titles must not be stored in plain text');
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    step('saves encrypted (no URLs or titles in plain text), owner-only, no duplicates');

    await store.addFolder('Reading');
    const b = await store.add({ url: 'https://longread.example/', title: 'Long read', folder: 'Reading' });
    await store.update(b.id, { title: 'A very long read' });
    await store.renameFolder('Reading', 'Later');
    assert.equal(store.snapshot().bookmarks.find((x) => x.id === b.id).folder, 'Later');
    await assert.rejects(store.renameFolder(FAVORITES, 'x'));
    await assert.rejects(store.removeFolder(FAVORITES));
    step('folders: add, rename (Favorites is protected), move');

    const removed = await store.remove(a.id);
    assert.equal(store.idForUrl(a.url), null);
    await store.restore(removed);
    assert.equal(store.idForUrl(a.url), a.id);
    step('remove and undo');

    // Reload from disk in a fresh store.
    const reopened = new BookmarkStore(file, () => {});
    await reopened.init(false);
    assert.deepEqual(reopened.snapshot().bookmarks.map((x) => x.title).sort(), ['A very long read', 'My private diary']);
    step('persists and decrypts in a new session');

    // --- Touch ID lock ------------------------------------------------------------
    const locked = new BookmarkStore(file, () => {});
    await locked.init(true);
    assert.equal(locked.unlocked, false, 'stays locked at launch when Touch ID is required');
    assert.equal(locked.snapshot(), null);
    assert.equal(await locked.unlock('test'), true);
    assert.equal(locked.snapshot().bookmarks.length, 2);
    locked.lock();
    assert.equal(locked.unlocked, false);
    step('optional Touch ID lock');

    // --- Import / export -------------------------------------------------------------
    const parsed = parseBookmarksHtml(CHROME_EXPORT);
    assert.deepEqual(parsed.map((p) => p.folder), [FAVORITES, 'Work', 'Other bookmarks', 'Other bookmarks']);
    assert.equal(parsed[0].title, 'News & Views');
    assert.equal(parsed[2].title, 'Recipes – best');
    const result = await reopened.importHtml(CHROME_EXPORT);
    assert.deepEqual(result, { added: 3, skipped: 1 }, 'the duplicate (after removing utm_source) is skipped; javascript: links are dropped');
    const snap = reopened.snapshot();
    assert.ok(snap.folders.includes('Work') && snap.folders.includes('Other bookmarks'));
    assert.ok(snap.bookmarks.some((x) => x.url === 'https://news.example/?id=7' && x.folder === FAVORITES));
    step('imports a Chrome-style bookmarks.html (toolbar -> Favorites, nested folders, entities)');

    const html = reopened.exportHtml();
    assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
    const roundTrip = parseBookmarksHtml(html);
    assert.equal(roundTrip.length, snap.bookmarks.length);
    for (const bm of snap.bookmarks) {
      const back = roundTrip.find((r) => r.url === bm.url);
      assert.ok(back, `missing after round trip: ${bm.url}`);
      assert.equal(back.title, bm.title);
      assert.equal(back.folder, bm.folder);
    }
    step('exports bookmarks.html that re-imports identically');

    console.log('BOOKMARKS TEST PASSED');
    app.exit(0);
  } catch (err) {
    console.error('BOOKMARKS TEST FAILED:', err);
    app.exit(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
