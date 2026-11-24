// Builds the on-device AI helper (native/webscape-ai, Swift + LocalLM Lab SDK).
// macOS only; elsewhere the browser works without AI and this step is skipped.
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('build-ai: skipped (on-device AI needs macOS)');
  process.exit(0);
}
try {
  execFileSync('swift', ['build', '-c', 'release', '--package-path', 'native/webscape-ai'], { stdio: 'inherit' });
} catch {
  console.error('build-ai: the Swift build failed. The browser still runs, without on-device AI.');
  process.exit(process.env.CI ? 1 : 0);
}
