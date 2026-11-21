/** Assembly-layer M2 tests: drive the real apply() through /market subcommands
 * and the model-facing tools with a fake host seam. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type RuntimeDeps } from '../src/plugin.ts';
import type { ChangeResultLike, InstallSeam, InstalledRow } from '../src/core/index.ts';
import { freshIndex, SNAPSHOT_TEXT } from './helpers.ts';

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
