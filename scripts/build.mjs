/**
 * 把 src/client.tsx 原样包进 dsh 的 ModuleLoader 形式，产出 lib/client.js。
 * 源文件刻意只含 JS（无 JSX / TS 语法），所以构建 = 缩进 + 包裹，零依赖、可复现。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src', 'client.tsx'), 'utf8');

if (/^\s*(?:import|export)\s/m.test(src)) {
  throw new Error('client 源文件必须保持 ModuleLoader 工厂体形态：不要用 import/export');
}
if (/<\/[A-Za-z]|\/>/.test(src)) {
  throw new Error('client 源文件不要用 JSX：用 React.createElement / h(...)');
}

const body = src.split('\n').map((line) => (line ? '    ' + line : '')).join('\n');
const out = [
  "window.__ModuleLoader__.load({",
  "  id: 'dsh-plugin-market',",
  "  factory(require) {",
  body,
  '  },',
  '});',
  '',
].join('\n');

const dest = join(root, 'lib');
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'client.js'), out, 'utf8');
process.stdout.write('built lib/client.js from src/client.tsx (' + out.length + ' bytes)\n');
