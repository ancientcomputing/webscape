// End-to-end test of the password vault's encryption, using the real OS keychain.
// Run after `npm run build`:  npx electron scripts/vault-test.cjs
//
// It uses its own app name (so its own keychain entry) and a temp folder, so it
// never touches a real vault. Touch ID is skipped so it can run unattended.
const { app, safeStorage, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setName('Webscape Wanderer Vault Test');
systemPreferences.canPromptTouchID = () => false; // no fingerprint prompt in tests

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscape-vault-test-'));
  const file = path.join(dir, 'vault.bin');
  const { Vault } = require('../dist/main/vault.js');
  const step = (msg) => console.log(`  ✓ ${msg}`);
  try {
    const vault = new Vault(file, () => {});
    assert.equal(vault.available, false, 'unavailable before init');
    await vault.init();
    assert.equal(vault.available, true, 'OS encryption should be available');
    step('OS encryption available');

    assert.equal(await vault.unlock('test'), true);
    assert.deepEqual(vault.list(), []);
    step('unlocks an empty vault');

    await vault.upsert('https://example.test', 'alice', 'correct horse battery staple');
    await Promise.all([
      vault.upsert('https://example.test', 'bob', 'pw-bob-1'),
      vault.upsert('https://other.test', 'carol', 'pw-carol'),
    ]);
    const onDisk = fs.readFileSync(file);
    assert.ok(!onDisk.includes('correct horse'), 'password must not be stored in plain text');
    assert.ok(!onDisk.includes('alice'), 'usernames must not be stored in plain text');
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    step('saves encrypted, owner-only (0600), concurrent writes ok');

    vault.lock();
    assert.equal(vault.unlocked, false);
    assert.equal(await vault.unlock('test'), true);
    const all = vault.list();
    assert.deepEqual(all.map((e) => e.username), ['alice', 'bob', 'carol']);
    assert.equal(vault.get(all[0].id).password, 'correct horse battery staple');
    step('locks, then decrypts all logins after unlocking');

    await vault.upsert('https://example.test', 'bob', 'pw-bob-2');
    assert.equal(vault.forOrigin('https://example.test').length, 2);
    assert.equal(vault.compare('https://example.test', 'bob', 'pw-bob-2'), 'same');
    await vault.remove(all[2].id);
    vault.lock();
    await vault.unlock('test');
    assert.deepEqual(vault.list().map((e) => e.username), ['alice', 'bob']);
    step('updates and deletes persist');

    // Vaults written by earlier versions (synchronous encryptString) must still open.
    const legacy = path.join(dir, 'legacy.bin');
    const legacyData = { version: 1, entries: [{ id: 'x', origin: 'https://old.test', username: 'dave', password: 'old-pw', created: 1, updated: 1 }] };
    fs.writeFileSync(legacy, safeStorage.encryptString(JSON.stringify(legacyData)));
    const old = new Vault(legacy, () => {});
    await old.init();
    await old.unlock('test');
    assert.equal(old.get('x').password, 'old-pw');
    step('opens vaults written by the previous version');

    console.log('VAULT TEST PASSED');
    app.exit(0);
  } catch (err) {
    console.error('VAULT TEST FAILED:', err);
    app.exit(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
