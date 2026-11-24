/** Assembly-layer M2 tests: drive the real apply() through /market subcommands
 * and the model-facing tools with a fake host seam. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type RuntimeDeps } from '../src/plugin.ts';
import { quoteShellArgument } from '../src/core/index.ts';
import type { ChangeResultLike, InstallSeam, InstalledBundle, InstalledRow, MarketIndex } from '../src/core/index.ts';
import { freshIndex, SNAPSHOT_TEXT, snapshotIndex } from './helpers.ts';

interface CtxHarness {
  ctx: unknown;
  command(name: string): (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
  tool(name: string): { execute: (args: Record<string, unknown>) => Promise<string>; presentCall?: (args: Record<string, unknown>) => unknown };
}

function makeCtx(): CtxHarness {
  const commands = new Map<string, { handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }> }>();
  const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<string>; presentCall?: (args: Record<string, unknown>) => unknown }>();
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    commands: { register: (definition: { name: string; handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }> }) => commands.set(definition.name, definition) },
    tools: { register: (definition: { name: string; execute: (args: Record<string, unknown>) => Promise<string>; presentCall?: (args: Record<string, unknown>) => unknown }) => tools.set(definition.name, definition) },
  };
  return {
    ctx,
    command(name: string) {
      const found = commands.get(name);
      assert.ok(found, `command ${name} not registered`);
      return found.handler;
    },
    tool(name: string) {
      const found = tools.get(name);
      assert.ok(found, `tool ${name} not registered`);
      return found;
    },
  };
}

function seamFixture(): InstallSeam & { calls: string[] } {
  const calls: string[] = [];
  const rows: InstalledRow[] = [];
  return {
    kind: 'fake', source: 'harness ctx.pluginManager', calls,
    async installBundle(spec: string): Promise<ChangeResultLike> {
      calls.push(spec);
      rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: 'active' });
      return { changed: true, application: 'applied', stage: 'install', target: spec, enabled: true };
    },
    async listPlugins() { return rows; },
    async listBundles() { return []; },
  };
}

const baseDeps = (overrides: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  fetchText: async () => { throw new Error('offline'); },
  readCache: async () => null,
  writeCache: async () => {},
  embedded: SNAPSHOT_TEXT,
  now: () => Date.parse('2026-11-21T12:00:00.000Z'),
  ...overrides,
});

test('/market install <id> installs the group and reports the four states', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'success', result.text);
  assert.equal(seam.calls.length, 3);
  assert.match(result.text, /安装报告 · archive-chain/);
  assert.match(result.text, /已挂载、enabled、active/);
  assert.match(result.text, /验收通过/);
  assert.match(result.text, /宿主 slot 检测：无法检测/);
  assert.match(result.text, /下一步/);
});

test('/market verify <id> only verifies; it never calls installBundle', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));
  const result = await wired.command('market')({ rawInput: 'verify archive-chain' });
  assert.equal(result.kind, 'success');
  assert.equal(seam.calls.length, 0);
  assert.match(result.text, /生效校验 · archive-chain/);
  assert.match(result.text, /未在安装清单中出现/);
});

test('/market seams shows the probed seam and fallback commands', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { enabled: true }, baseDeps());
  const offline = await wired.command('market')({ rawInput: 'seams' });
  assert.equal(offline.kind, 'success');
  assert.match(offline.text, /不可用/);
  assert.match(offline.text, /dsh plugin --profile 'web' add/);

  const online = makeCtx();
  const seam = seamFixture();
  apply(online.ctx as never, { enabled: true }, baseDeps({ seam, seamProbe: { available: true, source: 'ctx.pluginManager', checked: ['ctx.pluginManager'], methods: ['installBundle'], note: 'ok' } }));
  const result = await online.command('market')({ rawInput: 'seams' });
  assert.match(result.text, /可用/);
  assert.match(result.text, /ctx\.pluginManager/);
});

test('a live command collision returns an executable fix, not a stack trace', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam,
    registeredCommands: () => ['/archive'],
  }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'error');
  assert.equal(seam.calls.length, 0);
  assert.match(result.text, /修复建议/);
  assert.match(result.text, /--without/);
  assert.doesNotMatch(result.text, /TypeError|at apply|stack/i);
});

test('--without drops the colliding member and proceeds with the rest', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam,
    registeredCommands: () => ['/archive'],
  }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain --without dsh-plugin-obsidian-push' });
  assert.equal(result.kind, 'success', result.text);
  assert.equal(seam.calls.length, 2);
  assert.match(result.text, /已安装 2\/3 个组成员（部分安装）/);
  assert.match(result.text, /验收通过：2\/3 个纳入校验的成员/);
  assert.match(result.text, /按要求跳过 dsh-plugin-obsidian-push/);
  assert.doesNotMatch(result.text, /dsh-plugin-obsidian-push：/);
});

test('excluding every member fails safely without calling installBundle', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain --without dsh-plugin-transcript,dsh-plugin-obsidian-push,dsh-plugin-transcript-search' });
  assert.equal(result.kind, 'error', result.text);
  assert.equal(seam.calls.length, 0);
  assert.match(result.text, /已安装 0\/3 个成员/);
  assert.match(result.text, /全部被排除/);
  assert.match(result.text, /不是完整安装/);
  assert.match(result.text, /至少保留一个成员/);
});

test('degraded mode: install returns manual commands and does not pretend success', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { enabled: true }, baseDeps());
  const result = await wired.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /降级模式/);
  assert.match(result.text, /未执行任何安装/);
  assert.match(result.text, /dsh plugin --profile 'web' add/);
  assert.match(result.text, /\/market verify archive-chain/);
});

test('market_install and market_verify tools are wired to the same flow', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam, fetchText: async () => JSON.stringify(freshIndex()) }));
  const report = await wired.tool('market_install').execute({ groupId: 'archive-chain', without: '' });
  assert.equal(seam.calls.length, 3);
  assert.match(report, /安装报告 · archive-chain/);
  const verify = await wired.tool('market_verify').execute({ groupId: 'archive-chain' });
  assert.match(verify, /生效校验 · archive-chain/);
  assert.match(verify, /已挂载、enabled、active/);
});

test('a handler-level exception is rendered as a readable error with next steps', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam: {
      kind: 'fake', source: 'throwing',
      async installBundle() { throw new Error('boom'); },
      async listPlugins() { throw new Error('boom'); },
    },
  }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /读取宿主安装清单失败|下一步/);
  assert.doesNotMatch(result.text, /\n\s+at /);
});

/* --------------------------- F6 uninstall / rollback ---------------------- */

function installedRowsFor(index: MarketIndex, groupId: string): InstalledRow[] {
  const group = index.groups.find((candidate) => candidate.id === groupId)!;
  return group.members.map((id) => {
    const plugin = index.plugins.find((candidate) => candidate.id === id)!;
    const npm = plugin.npm ?? id;
    return { id: npm, moduleName: npm, enabled: true, fiberPhase: 'active' as const };
  });
}

function installedBundlesFor(index: MarketIndex, groupId: string): InstalledBundle[] {
  const group = index.groups.find((candidate) => candidate.id === groupId)!;
  return group.members.map((id) => ({
    name: index.plugins.find((plugin) => plugin.id === id)!.npm!,
    enabled: true, installed: true, removable: true,
    rows: [{ rowId: id, moduleName: index.plugins.find((plugin) => plugin.id === id)!.npm! }],
  }));
}

function rollbackSeam(
  rows: InstalledRow[],
  bundles: InstalledBundle[],
  options: { failOn?: string; diagnostic?: string; onRemoved?: (spec: string) => void } = {},
): InstallSeam & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'fake', source: 'harness removeBundle', calls,
    async installBundle(spec: string): Promise<ChangeResultLike> {
      throw new Error(`installBundle should not be called during uninstall: ${spec}`);
    },
    async removeBundle(spec: string): Promise<ChangeResultLike> {
      calls.push(spec);
      if (options.failOn && spec.includes(options.failOn)) {
        return {
          changed: false, application: 'failed', stage: 'remove', target: spec,
          error: { code: 'remove-failed', diagnostic: options.diagnostic ?? 'host refused removal' },
        };
      }
      const packageName = spec.split('/').pop()?.toLowerCase() ?? '';
      const at = rows.findIndex((row) => [row.id, row.moduleName ?? '']
        .some((value) => value.toLowerCase().includes(packageName)));
      if (at >= 0) rows.splice(at, 1);
      const bundleAt = bundles.findIndex((bundle) => bundle.name === spec);
      if (bundleAt >= 0) bundles.splice(bundleAt, 1);
      options.onRemoved?.(spec);
      return { changed: true, application: 'applied', stage: 'remove', target: spec };
    },
    async listPlugins() { return rows; },
    async listBundles() { return bundles; },
  } as InstallSeam & { calls: string[] };
}

function manifestFixture() {
  let files = { packageJson: '{"name":"original-pkg"}', pnpmLock: 'lock-original' };
  let writes = 0;
  return {
    store: {
      async read() { return { ...files }; },
      async write(next: { packageJson?: string | null; pnpmLock?: string | null }) {
        files = { packageJson: next.packageJson ?? null, pnpmLock: next.pnpmLock ?? null };
        writes += 1;
      },
    },
    mutate(next: { packageJson?: string; pnpmLock?: string }) { files = { ...next }; },
    get files() { return files; },
    get writes() { return writes; },
  };
}

test('/market uninstall <id> rolls back in reverse members order and is idempotent', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = rollbackSeam(rows, installedBundlesFor(index, 'archive-chain'));
  const manifest = manifestFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam, manifest: manifest.store }));

  const first = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(first.kind, 'success', first.text);
  assert.match(first.text, /卸载报告 · archive-chain/);
  assert.match(first.text, /逆序卸载 3 个成员/);
  assert.deepEqual([...seam.calls], [
    '@deepseek-ai/dsh-plugin-transcript-search',
    '@deepseek-ai/dsh-plugin-obsidian-push',
    '@deepseek-ai/dsh-plugin-transcript',
  ]);
  assert.equal(rows.length, 0, 'all installed members removed from the manifest');
  assert.equal(manifest.writes, 0, 'successful rollback never rewrites the manifest');

  const second = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(second.kind, 'success', second.text);
  assert.match(second.text, /幂等：没有已安装成员/);
  assert.equal(seam.calls.length, 3, 'second uninstall must not call the host again');
});

test('/market uninstall restores the original manifest and gives recovery commands on failure', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const manifest = manifestFixture();
  const seam = rollbackSeam(rows, installedBundlesFor(index, 'archive-chain'), {
    failOn: '@deepseek-ai/dsh-plugin-obsidian-push',
    onRemoved: () => manifest.mutate({ packageJson: '{"name":"mutated-pkg"}', pnpmLock: 'lock-mutated' }),
  });
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam, manifest: manifest.store }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.match(result.text, /卸载未完成：1 步失败/);
  assert.match(result.text, /原始 package\.json \/ pnpm-lock\.yaml 已恢复/);
  assert.deepEqual(manifest.files, { packageJson: '{"name":"original-pkg"}', pnpmLock: 'lock-original' });
  assert.equal(manifest.writes, 1, 'snapshot restored exactly once');
  assert.match(result.text, /恢复命令（可直接复制）/);
  assert.match(result.text, /dsh plugin --profile 'web' add/);
  assert.match(result.text, /dsh plugin --profile 'web' remove/);
  assert.match(result.text, /\[failed\]/);
  assert.doesNotMatch(result.text, /TypeError|at apply|stack/i);
});

test('market_uninstall tool shares the same rollback flow as the command', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = rollbackSeam(rows, installedBundlesFor(index, 'archive-chain'));
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam, manifest: manifestFixture().store, fetchText: async () => JSON.stringify(index),
  }));
  const report = await wired.tool('market_uninstall').execute({ groupId: 'archive-chain' });
  assert.match(report, /卸载报告 · archive-chain/);
  assert.match(report, /逆序卸载 3 个成员/);
  assert.deepEqual([...seam.calls], [
    '@deepseek-ai/dsh-plugin-transcript-search',
    '@deepseek-ai/dsh-plugin-obsidian-push',
    '@deepseek-ai/dsh-plugin-transcript',
  ]);
});

test('uninstall matches the installed GitHub package manifest name when it differs from catalog npm', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const bundles = installedBundlesFor(index, 'archive-chain').map((bundle) => {
    const plugin = index.plugins.find((entry) => entry.npm === bundle.name)!;
    return { ...bundle, name: plugin.repo.split('/').pop()! };
  });
  const seam = rollbackSeam(rows, bundles);
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'success', result.text);
  assert.deepEqual(seam.calls, [
    'dsh-plugin-transcript-search',
    'dsh-plugin-obsidian-push',
    'dsh-plugin-transcript',
  ]);
});

test('uninstall removes a disabled GitHub bundle even when no live plugin rows exist', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const bundles = installedBundlesFor(index, 'archive-chain').map((bundle) => {
    const plugin = index.plugins.find((entry) => entry.npm === bundle.name)!;
    return { ...bundle, name: plugin.repo.split('/').pop()!, enabled: false, rows: [] };
  });
  const seam = rollbackSeam([], bundles);
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'success', result.text);
  assert.deepEqual(seam.calls, [
    'dsh-plugin-transcript-search',
    'dsh-plugin-obsidian-push',
    'dsh-plugin-transcript',
  ]);
  assert.equal(bundles.length, 0);
});

test('--without with a typo blocks before installing any member', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));
  const result = await wired.command('market')({ rawInput: 'install archive-chain --without dsh-plugin-obisidian-push' });
  assert.equal(result.kind, 'error', result.text);
  assert.equal(seam.calls.length, 0);
  assert.match(result.text, /不是组 archive-chain 的成员/);
  assert.match(result.text, /精确 id/);
});

test('uninstall fails closed when no unique removable bundle matches the plugin aliases', async () => {
  for (const mode of ['missing', 'ambiguous', 'alias-ambiguous'] as const) {
    const wired = makeCtx();
    const index = snapshotIndex();
    const rows = installedRowsFor(index, 'archive-chain');
    const bundles = installedBundlesFor(index, 'archive-chain');
    const transcriptNpm = index.plugins.find((plugin) => plugin.id === 'dsh-plugin-transcript')!.npm!;
    const transcriptBundle = bundles.find((bundle) => bundle.name === transcriptNpm)!;
    const inventory = mode === 'missing'
      ? bundles.filter((bundle) => bundle.name !== transcriptNpm)
      : [...bundles, {
        ...transcriptBundle,
        name: mode === 'alias-ambiguous' ? 'dsh-plugin-transcript' : transcriptNpm,
      }];
    const seam = rollbackSeam(rows, inventory);
    apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));

    const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
    assert.equal(result.kind, 'error', result.text);
    assert.equal(seam.calls.length, 0, `${mode} inventory must not trigger speculative removal`);
    assert.match(result.text, /无法唯一映射|匹配到 0 个|匹配到 2 个/);
    assert.match(result.text, /未调用宿主 removeBundle/);
    assert.match(result.text, /核对市集 npm 与 listBundles\(\)\.name/);
  }
});

test('uninstall fails closed when manifest snapshot is incomplete', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = rollbackSeam(rows, installedBundlesFor(index, 'archive-chain'));
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam,
    manifest: {
      async read() { return { packageJson: '{"name":"partial"}' }; },
      async write() {},
    },
  }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.equal(seam.calls.length, 0);
  assert.match(result.text, /manifest 快照.*未调用任何 removeBundle/);
});

test('uninstall fails closed if the host cannot enumerate bundle inventory', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = {
    kind: 'fake' as const,
    source: 'host without listBundles',
    async installBundle(spec: string) { return { changed: false, application: 'failed' as const, stage: 'install' as const, target: spec }; },
    async listPlugins() { return rows; },
    async removeBundle() { throw new Error('must not be called without bundle inventory'); },
  };
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.match(result.text, /listBundles 清单能力不可用/);
  assert.doesNotMatch(result.text, /幂等：没有已安装成员/);
});

test('uninstall recovery commands shell-quote hostile profile and bundle names', async () => {
  const wired = makeCtx();
  const base = snapshotIndex();
  const profile = "web profile'; echo INJECTED; $(whoami) `whoami`";
  const npm = "@scope/pkg ' ; echo INJECTED; $(whoami) `whoami`";
  const index: MarketIndex = {
    ...base,
    plugins: base.plugins.map((plugin) => plugin.id === 'dsh-plugin-obsidian-push' ? { ...plugin, npm } : plugin),
  };
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = rollbackSeam(rows, installedBundlesFor(index, 'archive-chain'), { failOn: npm });
  apply(wired.ctx as never, { enabled: true, profile }, baseDeps({ seam, embedded: JSON.stringify(index) }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.ok(result.text.includes(`--profile ${quoteShellArgument(profile)} remove ${quoteShellArgument(npm)}`), result.text);
  assert.ok(result.text.includes(`--profile ${quoteShellArgument(profile)} list`), result.text);
  assert.doesNotMatch(result.text, /--profile web profile'; echo INJECTED/);
});

test('host diagnostic is not appended to a copyable shell command', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const bundles = installedBundlesFor(index, 'archive-chain');
  const failedName = bundles.find((bundle) => bundle.name.includes('obsidian-push'))!.name;
  const seam = rollbackSeam(rows, bundles, {
    failOn: failedName,
    diagnostic: 'refused; echo INJECTED\r\nnext line',
  });
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam, manifest: manifestFixture().store }));

  const result = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.match(result.text, /宿主诊断（仅供参考，非命令）：refused; echo INJECTED\s+next line/);
  assert.doesNotMatch(result.text, /list; echo INJECTED/);
});

test('/market install blocks two /health members before calling the seam', async () => {
  const wired = makeCtx();
  const seam = seamFixture();
  const index = snapshotIndex();
  const radar = index.plugins.find((plugin) => plugin.id === 'dsh-plugin-error-radar')!;
  const healthClash: MarketIndex = {
    ...index,
    plugins: [...index.plugins, radar],
    groups: [...index.groups, {
      ...index.groups.find((group) => group.id === 'saving-combo')!,
      id: 'health-clash', members: ['dsh-plugin-cache-guard', 'dsh-plugin-error-radar'],
    }],
  };
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam, fetchText: async () => JSON.stringify(healthClash),
  }));
  const result = await wired.command('market')({ rawInput: 'install health-clash' });
  assert.equal(result.kind, 'error', result.text);
  assert.equal(seam.calls.length, 0, 'no member may be installed when /health collides');
  assert.match(result.text, /都声明了 \/health/);
  assert.match(result.text, /修复建议/);
  assert.match(result.text, /--without dsh-plugin-error-radar/);
  assert.match(result.text, /command already registered/);
});
