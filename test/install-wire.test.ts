/** Assembly-layer M2 tests: drive the real apply() through /market subcommands
 * and the model-facing tools with a fake host seam. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type RuntimeDeps } from '../src/plugin.ts';
import type { ChangeResultLike, InstallSeam, InstalledRow, MarketIndex } from '../src/core/index.ts';
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
  assert.match(offline.text, /dsh plugin --profile web add/);

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
  assert.equal(result.kind, 'error'); // transcript-search command isn't registered in this harness
  assert.equal(seam.calls.length, 2);
  assert.match(result.text, /dsh-plugin-transcript-search/);
});

test('degraded mode: install returns manual commands and does not pretend success', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { enabled: true }, baseDeps());
  const result = await wired.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /降级模式/);
  assert.match(result.text, /未执行任何安装/);
  assert.match(result.text, /dsh plugin --profile web add/);
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
    const spec = plugin.npm ?? id;
    return { id: spec, moduleName: spec, enabled: true, fiberPhase: 'active' as const };
  });
}

function rollbackSeam(
  rows: InstalledRow[],
  options: { failOn?: string; onRemoved?: (spec: string) => void } = {},
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
          error: { code: 'remove-failed', diagnostic: 'host refused removal' },
        };
      }
      const packageName = spec.split('/').pop()?.toLowerCase() ?? '';
      const at = rows.findIndex((row) => [row.id, row.moduleName ?? '']
        .some((value) => value.toLowerCase().includes(packageName)));
      if (at >= 0) rows.splice(at, 1);
      options.onRemoved?.(spec);
      return { changed: true, application: 'applied', stage: 'remove', target: spec };
    },
    async listPlugins() { return rows; },
    async listBundles() { return []; },
  } as InstallSeam & { calls: string[] };
}

function manifestFixture() {
  let files = { packageJson: '{"name":"original-pkg"}', pnpmLock: 'lock-original' };
  let writes = 0;
  return {
    store: {
      async read() { return { ...files }; },
      async write(next: { packageJson?: string; pnpmLock?: string }) { files = { ...next }; writes += 1; },
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
  const seam = rollbackSeam(rows);
  const manifest = manifestFixture();
  apply(wired.ctx as never, { enabled: true }, baseDeps({ seam, manifest: manifest.store }));

  const first = await wired.command('market')({ rawInput: 'uninstall archive-chain' });
  assert.equal(first.kind, 'success', first.text);
  assert.match(first.text, /卸载报告 · archive-chain/);
  assert.match(first.text, /逆序卸载 3 个成员/);
  assert.deepEqual([...seam.calls], [
    'github:121212165/dsh-plugin-transcript-search',
    'github:121212165/dsh-plugin-obsidian-push',
    'github:121212165/dsh-plugin-transcript',
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
  const seam = rollbackSeam(rows, {
    failOn: 'dsh-plugin-obsidian-push',
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
  assert.match(result.text, /dsh plugin --profile web add/);
  assert.match(result.text, /dsh plugin --profile web remove/);
  assert.match(result.text, /\[failed\]/);
  assert.doesNotMatch(result.text, /TypeError|at apply|stack/i);
});

test('market_uninstall tool shares the same rollback flow as the command', async () => {
  const wired = makeCtx();
  const index = snapshotIndex();
  const rows = installedRowsFor(index, 'archive-chain');
  const seam = rollbackSeam(rows);
  apply(wired.ctx as never, { enabled: true }, baseDeps({
    seam, manifest: manifestFixture().store, fetchText: async () => JSON.stringify(index),
  }));
  const report = await wired.tool('market_uninstall').execute({ groupId: 'archive-chain' });
  assert.match(report, /卸载报告 · archive-chain/);
  assert.match(report, /逆序卸载 3 个成员/);
  assert.deepEqual([...seam.calls], [
    'github:121212165/dsh-plugin-transcript-search',
    'github:121212165/dsh-plugin-obsidian-push',
    'github:121212165/dsh-plugin-transcript',
  ]);
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
