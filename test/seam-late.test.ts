/** Seam timing tests: the host may register plugin_manager *after* this plugin
 * mounts, so apply() must re-probe at every install / verify / seams call.
 * A startup-only probe would pin the degraded path forever. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type RuntimeDeps } from '../src/plugin.ts';
import type { ChangeResultLike, InstalledRow } from '../src/core/index.ts';
import { SNAPSHOT_TEXT, snapshotIndex } from './helpers.ts';

type CommandHandler = (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }>;

interface HostService {
  installBundle(spec: string): Promise<ChangeResultLike>;
  listPlugins(): Promise<InstalledRow[]>;
  listBundles(): Promise<unknown[]>;
}

/** A cordis-like ctx whose pluginManager can be attached after apply(). */
function makeHost() {
  const commands = new Map<string, { name: string; handler: CommandHandler }>();
  const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>();
  const calls: string[] = [];
  const rows: InstalledRow[] = [];
  const service: HostService = {
    async installBundle(spec: string): Promise<ChangeResultLike> {
      calls.push(spec);
      rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: 'active' });
      return { changed: true, application: 'applied', stage: 'install', target: spec, enabled: true };
    },
    async listPlugins() { return rows; },
    async listBundles() { return []; },
  };
  const ctx: Record<string, unknown> = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    commands: {
      register(definition: { name: string; handler: CommandHandler }) { commands.set(definition.name, definition); },
    },
    tools: {
      register(definition: { name: string; execute: (args: Record<string, unknown>) => Promise<string> }) {
        tools.set(definition.name, definition);
      },
    },
  };
  return {
    ctx,
    service,
    calls,
    rows,
    command(name: string): CommandHandler {
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

const baseDeps = (overrides: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  fetchText: async () => { throw new Error('offline'); },
  readCache: async () => null,
  writeCache: async () => {},
  embedded: SNAPSHOT_TEXT,
  now: () => Date.parse('2026-11-21T12:00:00.000Z'),
  ...overrides,
});

const archiveChain = () => {
  const group = snapshotIndex().groups.find((candidate) => candidate.id === 'archive-chain');
  assert.ok(group, 'archive-chain must exist in the built-in snapshot');
  return group;
};

test('no plugin_manager at first call: degrades, installs nothing, never fakes success', async () => {
  const host = makeHost();
  apply(host.ctx as never, { enabled: true }, baseDeps());

  const result = await host.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(result.kind, 'error', result.text);
  assert.equal(host.calls.length, 0, 'installBundle must not be called without a seam');
  assert.match(result.text, /降级模式/);
  assert.match(result.text, /未执行任何安装/);
  assert.match(result.text, /dsh plugin --profile web add/);
  assert.match(result.text, /重启或重跑本命令/);
  assert.doesNotMatch(result.text, /验收通过|安装成功/);
});

test('plugin_manager registered later: the same instance installs with correct four states', async () => {
  const host = makeHost();
  apply(host.ctx as never, { enabled: true }, baseDeps());

  const degraded = await host.command('market')({ rawInput: 'seams' });
  assert.match(degraded.text, /不可用/);
  assert.match(degraded.text, /手动安装模板/);

  // Late registration: the service appears after apply() already ran.
  host.ctx.pluginManager = host.service;

  const seams = await host.command('market')({ rawInput: 'seams' });
  assert.match(seams.text, /状态：可用/);
  assert.match(seams.text, /ctx\.pluginManager/);
  assert.doesNotMatch(seams.text, /手动安装模板/);

  const group = archiveChain();
  const installed = await host.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(installed.kind, 'success', installed.text);
  assert.equal(host.calls.length, group.members.length);
  assert.equal(host.rows.length, group.members.length);
  assert.ok(host.rows.every((row) => row.enabled && row.fiberPhase === 'active'));
  assert.equal((installed.text.match(/\[applied\]/g) ?? []).length, group.members.length);
  assert.doesNotMatch(installed.text, /\[failed\]|降级模式/);
  assert.match(installed.text, /已挂载、enabled、active/);
  assert.match(installed.text, /验收通过/);

  const verified = await host.command('market')({ rawInput: 'verify archive-chain' });
  assert.equal(verified.kind, 'success', verified.text);
  assert.match(verified.text, /验收通过/);
  assert.equal(host.calls.length, group.members.length, 'verify must never install again');
});

test('without plugin_manager every command returns an actionable fallback, never an uncaught throw', async () => {
  const host = makeHost();
  apply(host.ctx as never, { enabled: true }, baseDeps());

  // Awaiting each handler is the assertion: a thrown error fails the test.
  const install = await host.command('market')({ rawInput: 'install archive-chain' });
  const verify = await host.command('market')({ rawInput: 'verify archive-chain' });
  const seams = await host.command('market')({ rawInput: 'seams' });

  for (const result of [install, verify, seams]) {
    assert.doesNotMatch(result.text, /TypeError|is not a function|\n\s+at /);
  }
  assert.equal(install.kind, 'error');
  assert.match(install.text, /dsh plugin --profile web add/);
  assert.match(install.text, /\/market verify archive-chain/);
  assert.match(install.text, /重启或重跑本命令/);
  assert.equal(host.calls.length, 0);

  assert.equal(verify.kind, 'success', verify.text);
  assert.match(verify.text, /未在安装清单中出现/);
  assert.match(verify.text, /\/market install archive-chain --reinstall/);

  assert.match(seams.text, /不可用/);
  assert.match(seams.text, /手动安装模板/);
  assert.match(seams.text, /重启或重跑本命令/);
});
