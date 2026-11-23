import { cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Copy non-TypeScript UI assets (HTML, CSS) into dist/ui.
for (const f of readdirSync('src/ui')) {
  if (!f.endsWith('.ts')) cpSync(join('src/ui', f), join('dist/ui', f));
}
