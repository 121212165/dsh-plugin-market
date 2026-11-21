/** Seam timing / proxy-safety tests.
 *
 * A cordis Context is a proxy: reading a service that was not declared in
 * `inject` throws (`pluginManager without inject`). The probe must therefore
 * never touch `ctx.pluginManager` unguarded, and must re-probe per call so a
 * host that registers plugin_manager after this plugin mounts still works. */
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

const fakeService = (calls: string[], rows: InstalledRow[]): HostService => ({
  async installBundle(spec: string): Promise<ChangeResultLike> {
    calls.push(spec);
    rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: 'active' });
    return { changed: true, application: 'applied', stage: 'install', target: spec, enabled: true };
  },
  async listPlugins() { return rows; },
  async listBundles() { return []; },
});

/** Emulates a real cordis ctx: undeclared service reads throw, `reflect.get`
 * returns undefined for services that are not provided yet. `strict: false`
 * gives a plain object (non-proxy test hosts). */
function makeHost(options: { strict?: boolean; reflect?: boolean } = {}) {
  const { strict = true, reflect = true } = options;
  const commands = new Map<string, { name: string; handler: CommandHandler }>();
  const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>();
  const calls: string[] = [];
  const rows: InstalledRow[] = [];
  const provided = new Map<string, unknown>();
  const base: Record<string, unknown> = {
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
  if (reflect) {
    base.reflect = { get: (name: string) => provided.get(name) };
  }
  const ctx: Record<string, unknown> = strict
    ? new Proxy(base, {
        get(target, prop, receiver) {
          if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
          throw new Error(`${String(prop)} without inject`);
        },
      })
    : base;
  return {
    ctx,
    calls,
    rows,
    service: fakeService(calls, rows),
    provide(name: string, value: unknown) { provided.set(name, value); },
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

test('cordis proxy without plugin_manager: probe never throws and degrades', async () => {
  const host = makeHost();
  assert.doesNotThrow(() => apply(host.ctx as never, { enabled: true }, baseDeps()));

  const seams = await host.command('market')({ rawInput: 'seams' });
  assert.match(seams.text, /不可用/);
  assert.match(seams.text, /手动安装模板/);

  const install = await host.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(install.kind, 'error', install.text);
  assert.equal(host.calls.length, 0, 'installBundle must not be called without a seam');
  assert.match(install.text, /dsh plugin --profile web add/);
  assert.doesNotMatch(install.text, /without inject|TypeError/);
});

test('plugin_manager provided later through ctx.reflect: the same instance installs', async () => {
  const host = makeHost();
  apply(host.ctx as never, { enabled: true }, baseDeps());
  assert.match((await host.command('market')({ rawInput: 'seams' })).text, /不可用/);

  // Late registration: reflect.get starts returning the service after apply().
  host.provide('pluginManager', host.service);

  const seams = await host.command('market')({ rawInput: 'seams' });
  assert.match(seams.text, /状态：可用/);
  assert.match(seams.text, /reflect\.get/);
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

test('plain-object hosts still fall back to a late ctx.pluginManager', async () => {
  const host = makeHost({ strict: false, reflect: false });
  apply(host.ctx as never, { enabled: true }, baseDeps());

  host.ctx.pluginManager = host.service;

  const seams = await host.command('market')({ rawInput: 'seams' });
  assert.match(seams.text, /状态：可用/);
  assert.match(seams.text, /ctx\.pluginManager/);

  const installed = await host.command('market')({ rawInput: 'install archive-chain' });
  assert.equal(installed.kind, 'success', installed.text);
  assert.equal(host.calls.length, archiveChain().members.length);
});

test('service absent everywhere: commands return actionable fallback, never throw', async () => {
  const host = makeHost({ reflect: false });
  assert.doesNotThrow(() => apply(host.ctx as never, { enabled: true }, baseDeps()));

  // Awaiting each handler is the assertion: a thrown error fails the test.
  const install = await host.command('market')({ rawInput: 'install archive-chain' });
  const verify = await host.command('market')({ rawInput: 'verify archive-chain' });
  const seams = await host.command('market')({ rawInput: 'seams' });

  for (const result of [install, verify, seams]) {
    assert.doesNotMatch(result.text, /without inject|TypeError|is not a function|\n\s+at /);
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
