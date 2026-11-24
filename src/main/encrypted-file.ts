import { safeStorage } from 'electron';
import fs from 'node:fs';

/**
 * Encrypted JSON files, shared by the password vault and bookmarks.
 *
 * - Encrypted with Electron's safeStorage, whose key lives in the OS keychain
 *   (macOS Keychain, DPAPI on Windows, libsecret/kwallet on Linux).
 * - Refuses to work when the OS can't really protect the key, including Linux
 *   without a keyring, where Electron would fall back to a built-in key.
 * - Writes are atomic (temp file + rename), owner-only (0600) and run one at a
 *   time, in order.
 */

/** Whether the OS offers real encryption. Call after app ready. */
export async function encryptionAvailable(): Promise<boolean> {
  let ok = await safeStorage.isAsyncEncryptionAvailable();
  if (ok && process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') ok = false;
  return ok;
}

export class EncryptedJsonFile<T> {
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  /** Returns null when the file doesn't exist yet. reEncrypt: the OS changed its key; save again. */
  async read(): Promise<{ data: T; reEncrypt: boolean } | null> {
    if (!fs.existsSync(this.file)) return null;
    const blob = await fs.promises.readFile(this.file);
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(blob);
    return { data: JSON.parse(result) as T, reEncrypt: shouldReEncrypt };
  }

  /** Encrypt and save. The data is serialised immediately, so later changes don't leak into this write. */
  write(data: T): Promise<void> {
    const snapshot = JSON.stringify(data);
    const run = async () => {
      const blob = await safeStorage.encryptStringAsync(snapshot);
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, blob, { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    };
    // Keep the queue alive after a failure, but still report it to this caller.
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => {});
    return next;
  }
}
