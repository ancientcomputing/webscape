// macOS shows the bundle name of the running .app in the menu bar, so a dev run
// (`electron .`) would say "Electron". This renames the local dev copy of
// Electron.app in node_modules. Packaged builds are named by electron-builder
// and don't need this. It also swaps in our icon, which the About box uses.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, utimesSync } from 'node:fs';

const NAME = 'Webscape Wanderer';
const app = 'node_modules/electron/dist/Electron.app/Contents';
const plist = `${app}/Info.plist`;

if (process.platform === 'darwin' && existsSync(plist)) {
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try {
      execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
    } catch {
      execFileSync('plutil', ['-insert', key, '-string', NAME, plist]);
    }
  }
  if (existsSync('build/icon.icns')) copyFileSync('build/icon.icns', `${app}/Resources/electron.icns`);
  // macOS caches a bundle's icon, so the About box kept showing Electron's.
  // Touching the bundle and registering it again makes it read the new one.
  const bundle = 'node_modules/electron/dist/Electron.app';
  const now = new Date();
  utimesSync(bundle, now, now);
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try {
    execFileSync(lsregister, ['-f', bundle]);
  } catch {
    // Not fatal: only the cached icon stays stale.
  }
}
