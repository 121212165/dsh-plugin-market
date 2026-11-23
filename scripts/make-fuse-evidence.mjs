#!/usr/bin/env node
/** F3 acceptance evidence: generate the real quota + cost-ledger task book,
 * overlap/reuse/source-table data, and run the family gate on the generated
 * scaffold. Writes f3-fuse-evidence.md at the repo root. Offline: git init in
 * a temp dir only; no network and no writes into the repository tree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFusePlan, runFuse } from '../src/core/fuse.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const index = JSON.parse(readFileSync(join(root, 'src', 'snapshot.json'), 'utf8'));
const ids = ['dsh-plugin-quota', 'dsh-plugin-cost-ledger'];
const plan = buildFusePlan(index, ids);

const dir = mkdtempSync(join(tmpdir(), 'f3-fuse-evidence-'));
let gateOutput = '(gate not run)';
try {
  for (const file of runFuse(index, ids, true).files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.email=fuse@example.test', '-c', 'user.name=fuse', 'commit', '-q', '-m', 'fuse artifact']);
  const gate = spawnSync(process.execPath, [join(root, 'scripts', 'vendor', 'verify-plugin.mjs'), dir], {
    cwd: root, encoding: 'utf8',
  });
  gateOutput = `${gate.stdout ?? ''}${gate.stderr ?? ''}`.trim();
  if (gate.status !== 0) throw new Error(`verify-plugin gate failed:\n${gateOutput}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const overlapLines = plan.overlaps.map((overlap) =>
  `- [${overlap.severity === 'conflict' ? '冲突' : '重叠'}] \`${overlap.key}\` ${overlap.detail}\n  - 复用：${overlap.reuse}`,
);
const reuseLines = plan.reuseList.map((item) =>
  `- ${item.owner} → ${item.consumers.join('、') || '(全体)'}：${item.label}（\`${item.field}\`）— ${item.instruction}`,
);
const sourceLines = plan.sourceTable.map((row) =>
  `- ${row.name}（${row.pluginId}）· ${row.repo} · ${row.license} · 上游借鉴：${row.borrowedFrom.join('、') || '无'}\n  - 差异：${row.differences.join('；')}\n  - 署名：${row.attribution}`,
);

const evidence = [
  '# F3 融合实样证据（quota + cost-ledger）',
  '',
  `数据时间：${index.generatedAt}；数据层：内置 snapshot。全部内容由 \`node scripts/make-fuse-evidence.mjs\` 现场生成。`,
  '',
  '## 1. 融合任务书（原文，落盘前输出）',
  '',
  plan.taskBook,
  '',
  '## 2. 重叠字段清单',
  '',
  ...overlapLines,
  '',
  '## 3. 复用不重写清单',
  '',
  ...reuseLines,
  '',
  '## 4. 借鉴来源与差异表（§8 强制）',
  '',
  ...sourceLines,
  '',
  '## 5. 官方门禁结果',
  '',
  '产物脚手架写入临时目录，`git init` + commit 后执行 `node scripts/vendor/verify-plugin.mjs <产物目录>`：',
  '',
  '```text',
  gateOutput,
  '```',
  '',
].join('\n');

writeFileSync(join(root, 'f3-fuse-evidence.md'), evidence, 'utf8');
console.log(`f3-fuse-evidence.md written · ${plan.overlaps.length} overlaps · ${plan.reuseList.length} reuse items · gate OK`);
