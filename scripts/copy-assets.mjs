/** Copy runtime assets into lib/ so the published package keeps the offline
 *  snapshot, the icon and the locale resources (G0-6 / G0-9). */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'lib'), { recursive: true });
copyFileSync(join(root, 'src', 'snapshot.json'), join(root, 'lib', 'snapshot.json'));
copyFileSync(join(root, 'icon.svg'), join(root, 'lib', 'icon.svg'));

const localesIn = join(root, 'src', 'locales');
const localesOut = join(root, 'lib', 'locales');
mkdirSync(localesOut, { recursive: true });
const locales = readdirSync(localesIn).filter((name) => name.endsWith('.json'));
for (const name of locales) copyFileSync(join(localesIn, name), join(localesOut, name));
console.log(`copy-assets: snapshot.json + icon.svg + ${locales.length} locale(s) → lib/`);
