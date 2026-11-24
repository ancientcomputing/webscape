import { systemPreferences } from 'electron';
import crypto from 'node:crypto';
import type { VaultEntrySummary } from '../shared/types';
import { EncryptedJsonFile, encryptionAvailable } from './encrypted-file';

interface Entry {
  id: string;
  origin: string;
  username: string;
  password: string;
  created: number;
  updated: number;
}

const AUTO_LOCK_MS = 10 * 60 * 1000;

/**
 * The password vault: the only thing Webscape Wanderer ever writes to disk about you.
 *
 * - The file is encrypted with Electron's safeStorage, whose key lives in the
 *   macOS Keychain (DPAPI on Windows, libsecret/kwallet on Linux).
 * - Decrypted entries only exist in memory while the vault is unlocked. On macOS
 *   unlocking requires Touch ID when the Mac has it. The vault locks itself after
 *   10 minutes without use.
 * - If OS-level encryption is unavailable the vault refuses to save rather than
 *   falling back to plaintext. That includes Linux without a keyring, where
 *   Electron would otherwise use a built-in key ("basic_text").
 * - Uses the async safeStorage API (the synchronous one is deprecated).
 */
export class Vault {
  private entries: Entry[] | null = null;
  private lockTimer: NodeJS.Timeout | undefined;
  private unlocking: Promise<boolean> | null = null;
  /** null until init() has asked the OS whether encryption is available. */
  private availability: boolean | null = null;
  private readonly store: EncryptedJsonFile<{ version: number; entries: Entry[] }>;

  constructor(
    file: string,
    private readonly onChange: () => void,
  ) {
    this.store = new EncryptedJsonFile(file);
  }

  /** Ask the OS whether real encryption is available. Call once after app ready. */
  async init(): Promise<void> {
    this.availability = await encryptionAvailable();
    this.onChange();
  }

  get available(): boolean {
    return this.availability === true;
  }

  get unlocked(): boolean {
    return this.entries !== null;
  }

  /** Unlock with Touch ID (where present). Resolves false if the user cancels. */
  unlock(reason: string): Promise<boolean> {
    if (this.entries) {
      this.touch();
      return Promise.resolve(true);
    }
    if (!this.available) return Promise.resolve(false);
    // Coalesce concurrent unlock requests into one prompt.
    this.unlocking ??= this.doUnlock(reason).finally(() => (this.unlocking = null));
    return this.unlocking;
  }

  private async doUnlock(reason: string): Promise<boolean> {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        await systemPreferences.promptTouchID(reason);
      } catch {
        return false;
      }
    }
    const { entries, reEncrypt } = await this.read();
    this.entries = entries;
    // The OS rotated or upgraded the key: store the vault under the new one.
    if (reEncrypt) await this.write();
    this.touch();
    this.onChange();
    return true;
  }

  lock(): void {
    this.entries = null;
    clearTimeout(this.lockTimer);
    this.onChange();
  }

  private touch(): void {
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), AUTO_LOCK_MS);
  }

  private async read(): Promise<{ entries: Entry[]; reEncrypt: boolean }> {
    const got = await this.store.read();
    return got ? { entries: got.data.entries, reEncrypt: got.reEncrypt } : { entries: [], reEncrypt: false };
  }

  private write(): Promise<void> {
    if (!this.entries) return Promise.reject(new Error('Vault is locked'));
    return this.store.write({ version: 1, entries: this.entries });
  }

  private requireUnlocked(): Entry[] {
    if (!this.entries) throw new Error('Vault is locked');
    this.touch();
    return this.entries;
  }

  list(): VaultEntrySummary[] {
    return this.requireUnlocked()
      .map(({ id, origin, username, updated }) => ({ id, origin, username, updated }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  forOrigin(origin: string): VaultEntrySummary[] {
    return this.list().filter((e) => e.origin === origin);
  }

  get(id: string): Entry | undefined {
    return this.requireUnlocked().find((e) => e.id === id);
  }

  /** Returns 'same' if this exact login is already saved. Works only while unlocked. */
  compare(origin: string, username: string, password: string): 'new' | 'update' | 'same' {
    if (!this.entries) return 'new';
    const hit = this.entries.find((e) => e.origin === origin && e.username === username);
    if (!hit) return 'new';
    return hit.password === password ? 'same' : 'update';
  }

  upsert(origin: string, username: string, password: string): Promise<void> {
    const entries = this.requireUnlocked();
    const now = Date.now();
    const hit = entries.find((e) => e.origin === origin && e.username === username);
    if (hit) {
      hit.password = password;
      hit.updated = now;
    } else {
      entries.push({ id: crypto.randomUUID(), origin, username, password, created: now, updated: now });
    }
    return this.write();
  }

  remove(id: string): Promise<void> {
    const entries = this.requireUnlocked();
    this.entries = entries.filter((e) => e.id !== id);
    return this.write();
  }
}

/** Only https origins (and http on localhost, for developers) may store or receive passwords. */
export function fillableOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.origin;
  } catch {
    /* not a URL */
  }
  return null;
}
