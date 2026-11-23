/** F3 fuse: pure logic (matrix / overlaps / source table), license red line,
 * 2–5 boundaries, two-step task book vs scaffolding, assembly wiring, and the
 * generated artifact against the family verify-plugin gate. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, type Config, type RuntimeDeps } from '../src/plugin.ts';
import {
  FuseValidationError,
  buildFusePlan,
  detectOverlaps,
  normalizeLicense,
  runFuse,
  validateFuseSelection,
  type FuseFile,
} from '../src/core/fuse.ts';
import { SNAPSHOT_TEXT, snapshotIndex } from './helpers.ts';

const QUOTA = 'dsh-plugin-quota';
const LEDGER = 'dsh-plugin-cost-ledger';
const PAIR = `${QUOTA},${LEDGER}`;

test('license allowlist: MIT and Apache-2.0 pass, GPL / compound / blank rejected', () => {
  assert.equal(normalizeLicense('MIT'), 'MIT');
  assert.equal(normalizeLicense('Apache-2.0'), 'Apache-2.0');
  assert.equal(normalizeLicense(' Apache License 2.0 '), 'Apache-2.0');
  assert.equal(normalizeLicense('GPL-3.0'), null);
  assert.equal(normalizeLicense('AGPL-3.0'), null);
  assert.equal(normalizeLicense('MIT OR GPL-3.0'), null);
  assert.equal(normalizeLicense(''), null);
  assert.equal(normalizeLicense(undefined), null);
});

test('acceptance: quota + cost-ledger reveals shared fields and a reuse-not-rewrite list', () => {
  const plan = buildFusePlan(snapshotIndex(), PAIR);
  assert.equal(plan.validation.ok, true);
  assert.deepEqual(plan.ids, [QUOTA, LEDGER]);

  const matrixKeys = plan.matrix.rows.map((row) => row.key);
  for (const key of ['req:tools', 'req:systemPrompt', 'req:sessionProjections', 'cat:钱与用量', 'data:cost']) {
    assert.ok(matrixKeys.includes(key), `missing capability row ${key}: ${matrixKeys.join(', ')}`);
  }
  for (const row of plan.matrix.rows.filter((item) => item.key.startsWith('req:') || item.key === 'cat:钱与用量' || item.key === 'data:cost')) {
    assert.equal(row.cells[QUOTA], true, row.key);
    assert.equal(row.cells[LEDGER], true, row.key);
  }

  const keys = plan.overlaps.map((overlap) => overlap.key);
  assert.ok(keys.includes('req:systemPrompt'), keys.join(', '));
  assert.ok(keys.includes('cat:钱与用量'), keys.join(', '));
  assert.ok(keys.includes('data:cost'), keys.join(', '));

  const cost = plan.overlaps.find((overlap) => overlap.key === 'data:cost')!;
  assert.equal(cost.owner, QUOTA);
  assert.deepEqual(cost.members, [QUOTA, LEDGER]);
  assert.ok(cost.reuse.includes('不重写'), cost.reuse);

  assert.ok(plan.reuseList.length >= 5, `expected reuse list, got ${plan.reuseList.length}`);
  assert.ok(plan.reuseList.every((item) => item.instruction.includes('不重写')));
  assert.ok(detectOverlaps(plan.matrix).some((overlap) => overlap.severity === 'reuse'));
});

test('mandatory source table: every origin carries license, upstream and delta', () => {
  const plan = buildFusePlan(snapshotIndex(), PAIR);
  assert.equal(plan.sourceTable.length, 2);
  for (const row of plan.sourceTable) {
    assert.equal(row.license, 'MIT');
    assert.ok(row.repo.startsWith('121212165/'), row.repo);
    assert.ok(row.differences.length > 0, row.pluginId);
    assert.ok(row.differences.some((line) => line.includes('不重写') || line.includes('复用基准')), row.pluginId);
    assert.ok(row.attribution.includes('BORROWED.md'), row.pluginId);
  }
  assert.ok(plan.taskBook.startsWith('# 融合任务书'));
  assert.ok(plan.taskBook.includes('## 5. 借鉴来源与差异（§8 强制，不得省略）'));
  assert.ok(plan.taskBook.includes('## 4. 复用不重写清单'));
  assert.ok(plan.scaffolding.some((file) => file.path === 'BORROWED.md' && file.content.includes('借鉴来源与差异')));
});

test('GPL plugin is refused before any artifact is produced', () => {
  const index = snapshotIndex();
  const gplId = 'dsh-plugin-gpl-fragment';
  const polluted = {
    ...index,
    plugins: [...index.plugins, { ...index.plugins[0]!, id: gplId, name: 'GPL 片段', license: 'GPL-3.0' }],
  };
  const validation = validateFuseSelection([QUOTA, gplId], polluted);
  assert.equal(validation.ok, false);
  assert.ok(validation.rejected.some((item) => item.id === gplId && item.reason.includes('GPL')));
  assert.throws(
    () => buildFusePlan(polluted, [QUOTA, gplId]),
    (error: unknown) => error instanceof FuseValidationError && error.errors.some((line) => line.includes('GPL')),
  );
});

test('2/5 boundaries: 1 and 6 rejected, 2 and 5 accepted', () => {
  const index = snapshotIndex();
  const two = validateFuseSelection([QUOTA, LEDGER], index);
  assert.equal(two.ok, true);

  const one = validateFuseSelection([QUOTA], index);
  assert.equal(one.ok, false);
  assert.ok(one.errors.some((line) => line.includes('至少需要 2')));

  const fiveIds = [QUOTA, LEDGER, 'dsh-plugin-relay-quota', 'dsh-plugin-spend-forecast', 'dsh-plugin-price-aware'];
  assert.equal(validateFuseSelection(fiveIds, index).ok, true);
  assert.equal(buildFusePlan(index, fiveIds).plugins.length, 5);

  const six = validateFuseSelection([...fiveIds, 'dsh-plugin-token-telemetry'], index);
  assert.equal(six.ok, false);
  assert.ok(six.errors.some((line) => line.includes('最多选 5')));

  const duplicate = validateFuseSelection(`${QUOTA},${QUOTA},${LEDGER}`, index);
  assert.deepEqual(duplicate.ids, [QUOTA, LEDGER]);
});

const SNAPSHOT_TIME = Date.parse(snapshotIndex().generatedAt);
const config: Partial<Config> = { enabled: true };
const offlineDeps: RuntimeDeps = {
  fetchText: async () => { throw new Error('offline'); },
  readCache: async () => null,
  writeCache: async () => {},
  embedded: SNAPSHOT_TEXT,
  now: () => SNAPSHOT_TIME,
};

interface CapturedCommand {
  name: string;
  handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
}
interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
  presentCall?: (args: Record<string, unknown>) => Record<string, unknown>;
  presentResult?: (args: Record<string, unknown>, value: unknown) => Record<string, unknown>;
}

function makeCtx() {
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    commands: { register(definition: CapturedCommand) { commands.push(definition); } },
    tools: { register(definition: CapturedTool) { tools.push(definition); } },
  };
  const command = (name: string): CapturedCommand => commands.find((item) => item.name === name)!;
  const tool = (name: string): CapturedTool => tools.find((item) => item.name === name)!;
  return { ctx, command, tool };
}

test('two-step command: task book never writes; --apply writes the scaffold once', async () => {
  const wired = makeCtx();
  const writes: FuseFile[][] = [];
  apply(wired.ctx as never, config, {
    ...offlineDeps,
    fuseWriter: async (_root, files) => {
      writes.push(files);
      return files.map((file) => ({ path: file.path, action: 'written' }));
    },
  });

  const first = await wired.command('market').handler({ rawInput: `fuse ${PAIR}` });
  assert.equal(first.kind, 'success', first.text);
  assert.ok(first.text.startsWith('# 融合任务书'), first.text.slice(0, 80));
  assert.ok(first.text.includes('###') === false || first.text.includes('## 5. 借鉴来源与差异'));
  assert.equal(writes.length, 0, 'task book phase must not write anything');

  const second = await wired.command('market').handler({ rawInput: `fuse ${PAIR} --apply` });
  assert.equal(second.kind, 'success', second.text);
  assert.equal(writes.length, 1);
  assert.ok(writes[0]!.some((file) => file.path === 'BORROWED.md'));
  assert.ok(writes[0]!.some((file) => file.path === 'package.json'));
  assert.ok(second.text.includes('输出目录：'));

  const rejected = await wired.command('market').handler({ rawInput: `fuse ${QUOTA}` });
  assert.equal(rejected.kind, 'error');
  assert.ok(rejected.text.startsWith('# 融合任务书（已拒绝）'));
  assert.equal(writes.length, 1, 'a rejected fuse must not write');
});

test('market_fuse tool shares core logic and mirrors the install present-card pattern', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, offlineDeps);
  const tool = wired.tool('market_fuse');
  assert.ok(tool, 'market_fuse was never registered');

  assert.deepEqual(tool.presentCall?.({ ids: PAIR }), {
    card: 'generic', title: `融合任务书：${PAIR}`, kind: 'fetch',
  });
  const applyCard = tool.presentCall?.({ ids: PAIR, apply: true });
  assert.equal(applyCard?.['kind'], 'execute');
  assert.equal(applyCard?.['rawInput'], PAIR);
  assert.equal(tool.presentResult?.({ ids: PAIR, apply: false }, 'x')?.['kind'], 'fetch');
  assert.equal(tool.presentResult?.({ ids: PAIR, apply: true }, 'x')?.['kind'], 'execute');

  const text = await tool.execute({ ids: PAIR });
  assert.ok(text.startsWith('# 融合任务书'));
  assert.ok(text.includes('借鉴来源与差异'));
  assert.ok(text.includes('复用不重写清单'));

  const rejected = await tool.execute({ ids: QUOTA });
  assert.ok(rejected.includes('已拒绝'));
  assert.ok(rejected.includes('至少需要 2'));
});

const writeScaffold = (root: string, files: FuseFile[]): void => {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
};

test('generated artifact passes the family verify-plugin gate', () => {
  const scaffold = runFuse(snapshotIndex(), PAIR, true).files;
  const dir = mkdtempSync(join(tmpdir(), 'f3-fuse-artifact-'));
  try {
    writeScaffold(dir, scaffold);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    };
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.email=fuse@example.test', '-c', 'user.name=fuse', 'commit', '-q', '-m', 'fuse artifact']);

    const gate = fileURLToPath(new URL('../scripts/vendor/verify-plugin.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [gate, dir], { encoding: 'utf8' });
    assert.ok(output.includes('OK: all plugin specs pass'), output);
    assert.ok(output.includes('0 FAIL / 0 WARN'), output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
