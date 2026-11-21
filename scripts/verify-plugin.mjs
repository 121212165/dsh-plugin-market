#!/usr/bin/env node
/** M5 发布门禁（本地等价实现）。
 *
 * 依据 DSH-MARKET-PLAN.md §3/§6：家族工具
 * `dsh-family-tools/tools/verify-plugin.mjs` 不在当前工作区，无法原样调用。
 * 本脚本按计划中已记录的门禁语义，实现 G0-5/6/7/8/9/10 的等价断言：
 *   G0-5 清单与挂载契约   G0-6 本地化资源与 exports 声明
 *   G0-7 类型声明          G0-8 许可证与运行时依赖
 *   G0-9 构建产物入库      G0-10 三层测试存在性
 * 任一 gate 有 fail → 退出 1。结果写入 m5-gates.json；--json 仅打印 JSON。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (p) => join(ROOT, p);
const read = (p) => readFileSync(abs(p), 'utf8');
const exists = (p) => existsSync(abs(p));
const parse = (p) => JSON.parse(read(p));

const gates = [];
function gate(id, title, check) {
  const problems = [];
  let note = '';
  try {
    const result = check(problems);
    if (typeof result === 'string') note = result;
  } catch (error) {
    problems.push(`检查异常：${error instanceof Error ? error.message : String(error)}`);
  }
  gates.push({ id, title, ok: problems.length === 0, problems, note });
}

const pkg = parse('package.json');

gate('G0-5', '清单与挂载契约', (problems) => {
  for (const key of ['name', 'main', 'types', 'license']) if (!pkg[key]) problems.push(`package.json 缺 ${key}`);
  if (!pkg.exports?.['.']?.default) problems.push('exports["."].default 缺失');
  if (pkg.main !== './lib/index.js') problems.push(`main 应指向 ./lib/index.js（实际 ${pkg.main}）`);
  if (!pkg.dsh?.bundle?.patch) problems.push('dsh.bundle.patch 缺失');
  const catalog = pkg.dsh?.catalog ?? {};
  for (const key of ['category', 'blurb', 'entries']) if (!catalog[key]) problems.push(`dsh.catalog.${key} 缺失`);

  const patch = read('cordis.patch.yml');
  if (!/^\s*-\s*insert\s*:/m.test(patch)) problems.push('cordis.patch.yml 缺 insert 段');
  if (!/^\s*(?:-\s*)?id\s*:\s*market\s*$/m.test(patch)) problems.push('cordis.patch.yml 缺 id: market');

  const entry = read('lib/index.js');
  for (const name of ['name', 'inject', 'apply']) {
    if (!new RegExp(`\\b${name}\\b`).test(entry)) problems.push(`lib/index.js 未导出 ${name}`);
  }
  if (!catalog.entries?.includes('/market')) problems.push('dsh.catalog.entries 未声明 /market');
  return 'package.json / dsh.catalog / cordis.patch / lib 入口四项一致';
});

gate('G0-6', '本地化资源与 exports 声明', (problems) => {
  const srcDir = abs('src/locales');
  if (!existsSync(srcDir)) {
    problems.push('src/locales/ 缺失（缺 locale 应点名 G0-6；修复位置在 package.json exports）');
    return;
  }
  const locales = readdirSync(srcDir).filter((name) => name.endsWith('.json'));
  if (!locales.length) problems.push('src/locales/ 下无 .json 资源');
  if (!pkg.exports?.['./locales/*']) problems.push('package.json exports 未声明 "./locales/*"（G0-6 的修复位置）');
  let hasMarketKey = false;
  for (const name of locales) {
    const data = parse(`src/locales/${name}`);
    if (data?.market?.command?.description) hasMarketKey = true;
    if (!exists(`lib/locales/${name}`)) problems.push(`lib/locales/${name} 未构建入库`);
    else if (read(`lib/locales/${name}`) !== read(`src/locales/${name}`)) problems.push(`lib/locales/${name} 与源不一致`);
  }
  if (!hasMarketKey) problems.push('locale 资源缺 market.command.description');
  return `${locales.length} 个 locale 资源，已声明 exports 且随 lib/ 发布`;
});

gate('G0-7', '类型声明', (problems) => {
  const tsconfig = parse('tsconfig.json');
  const compiler = tsconfig.compilerOptions ?? {};
  if (compiler.declaration !== true) problems.push('tsconfig declaration 未开启');
  if (!compiler.declarationDir) problems.push('tsconfig declarationDir 缺失');
  if (!pkg.types || !exists(pkg.types.replace(/^\.\//, ''))) problems.push(`types 指向的文件不存在：${pkg.types}`);
  for (const file of ['lib/types/index.d.ts', 'lib/types/plugin.d.ts', 'lib/types/core/index.d.ts', 'lib/types/core/installer.d.ts']) {
    if (!exists(file)) problems.push(`${file} 缺失`);
  }
  return 'declaration 产物齐全，package.json#types 指向有效文件';
});

gate('G0-8', '许可证与运行时依赖', (problems) => {
  if (pkg.license !== 'MIT') problems.push(`license 应为 MIT（实际 ${pkg.license}）`);
  if (!exists('LICENSE')) problems.push('LICENSE 缺失');
  else if (!/MIT License/i.test(read('LICENSE'))) problems.push('LICENSE 内容未声明 MIT License');
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push('禁止打包运行时 dependencies；应只保留 peer/dev');
  return 'MIT 许可证齐备，零运行时依赖（仅 peer/dev）';
});

gate('G0-9', '构建产物入库', (problems) => {
  const required = [
    'lib/index.js', 'lib/plugin.js', 'lib/client.js', 'lib/snapshot.json', 'lib/icon.svg',
    'lib/core/index.js', 'lib/core/conflicts.js', 'lib/core/install-types.js', 'lib/core/installer.js',
    'lib/core/parse.js', 'lib/core/reader.js', 'lib/core/render.js', 'lib/core/seam.js', 'lib/core/types.js',
  ];
  for (const file of required) if (!exists(file)) problems.push(`${file} 缺失`);
  if (!pkg.files?.includes('lib')) problems.push('package.json#files 未包含 lib');
  if (exists('lib/snapshot.json')) {
    const snapshot = parse('lib/snapshot.json');
    if (snapshot.schemaVersion !== 1) problems.push('lib/snapshot.json schemaVersion 应为 1');
    if (!Array.isArray(snapshot.groups) || snapshot.groups.length !== 6) problems.push('lib/snapshot.json 应含 6 个组');
    if (read('lib/snapshot.json') !== read('src/snapshot.json')) problems.push('lib 与 src 的 snapshot.json 不一致');
  }
  return `${required.length} 个构建产物齐备，snapshot 与源同构`;
});

gate('G0-10', '三层测试存在性', (problems) => {
  const layers = [
    ['纯函数', ['test/reader.test.ts', 'test/render.test.ts', 'test/conflicts.test.ts']],
    ['装配层', ['test/wire.test.ts', 'test/install-wire.test.ts']],
    ['headless 冒烟', ['test/headless-smoke.test.mjs']],
  ];
  for (const [name, files] of layers) {
    if (!files.some((file) => exists(file))) problems.push(`${name}层测试缺失（${files.join(' / ')}）`);
  }
  const testScript = pkg.scripts?.test ?? '';
  if (!testScript.includes('test/*.test.ts') || !testScript.includes('test/*.test.mjs')) {
    problems.push('npm test 未覆盖 .test.ts 与 .test.mjs 两类测试');
  }
  return '纯函数 + 装配层 + headless 冒烟三层齐备，npm test 全覆盖';
});

const report = {
  milestone: 'M5 — 可发布门禁（本地等价实现）',
  generatedAt: new Date().toISOString(),
  note: '家族工具 dsh-family-tools/tools/verify-plugin.mjs 不在工作区；本结果按 DSH-MARKET-PLAN.md 记录的门禁语义给出等价断言。',
  gates,
  pass: gates.every((gate) => gate.ok),
};

const text = JSON.stringify(report, null, 2);
writeFileSync(join(ROOT, 'm5-gates.json'), text, 'utf8');
if (process.argv.includes('--json')) {
  console.log(text);
} else {
  for (const gate of gates) {
    console.log(`${gate.ok ? 'PASS' : 'FAIL'}  ${gate.id}  ${gate.title}`);
    for (const problem of gate.problems) console.log(`        - ${problem}`);
    if (gate.ok) console.log(`        ${gate.note}`);
  }
  console.log(report.pass ? '\nALL GATES PASS' : '\nGATES FAILED');
}

process.exit(report.pass ? 0 : 1);
