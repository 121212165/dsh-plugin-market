/** F5 — post-install live loop: dump-config → one entry call → four-state report.
 *
 * Every state is asserted with its explicit next step, and `overridden` is
 * asserted to say "被更高优先级层覆盖" rather than a generic failure. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FOUR_STATE_GUIDANCE,
  renderFourStateLine,
  renderInstallReport,
  runGroupInstall,
  runPostInstallLoop,
} from '../src/core/index.ts';
import type {
  ApplicationState,
  ChangeResultLike,
  InstallSeam,
  InstalledRow,
} from '../src/core/index.ts';
import { apply, type RuntimeDeps } from '../src/plugin.ts';
import { freshIndex, SNAPSHOT_TEXT } from './helpers.ts';

const index = freshIndex();
const FIXED_NOW = () => Date.parse('2026-11-23T12:00:00.000Z');
const group = index.groups.find((candidate) => candidate.id === 'archive-chain')!;

interface SeamOptions {
  application?: ApplicationState | ((spec: string) => ApplicationState);
  /** Leave the installed row present even when overridden (a real shadow). */
  keepRowWhenOverridden?: boolean;
  /** Rows already in the inventory when the live loop reads it. */
  preinstalled?: string[];
}

function fakeSeam(options: SeamOptions = {}): InstallSeam & { calls: string[]; rows: InstalledRow[] } {
  const calls: string[] = [];
  const rows: InstalledRow[] = (options.preinstalled ?? []).map((id) => ({
    id, moduleName: id, enabled: true, fiberPhase: 'active',
  }));
  return {
    kind: 'fake',
    source: 'F5 harness',
    calls,
    rows,
    async installBundle(spec: string): Promise<ChangeResultLike> {
      calls.push(spec);
      const application = typeof options.application === 'function'
        ? options.application(spec)
        : options.application ?? 'applied';
      if (application === 'applied' || (options.keepRowWhenOverridden && application === 'overridden')) {
        rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: 'active' });
      }
      return {
        changed: true,
        application,
        stage: 'install',
        target: spec,
        enabled: true,
        ...(application === 'failed' || application === 'cancelled'
          ? { error: { code: 'operation-error', diagnostic: 'F5 diagnostic' } }
          : {}),
      };
    },
    async listPlugins() { return rows.map((row) => ({ ...row })); },
    async listBundles() { return rows.map((row) => ({ name: row.id, enabled: row.enabled })); },
  };
}

const dumpFixture = () => [
  '# == dsh-plugin-market',
  '- id: market',
  '  config:',
  '    enabled: true',
  '  members: dsh-plugin-transcript dsh-plugin-obsidian-push dsh-plugin-transcript-search',
].join('\n');

const entryProbe = (entry: string) => `${entry} 调用成功（F5 回路原始输出）`;

function loopFor(applicationByMember: Record<string, ApplicationState>, options: SeamOptions = {}) {
  const needsRows = Object.values(applicationByMember).every(
    (state) => state === 'applied' || (options.keepRowWhenOverridden && state === 'overridden'),
  );
  const seam = fakeSeam({
    ...options,
    preinstalled: needsRows ? group.members : options.preinstalled,
  });
  return {
    seam,
    promise: runPostInstallLoop({
      groupId: group.id,
      index,
      seam,
      applicationByMember,
      profile: 'market-audit4',
      registeredCommands: ['/transcript', '/obsidian-push', '/archive', '/find'],
      dumpConfig: dumpFixture,
      callEntry: entryProbe,
      now: FIXED_NOW,
    }),
  };
}

test('applied: four-state line carries the label and a concrete next step', async () => {
  const byMember = Object.fromEntries(group.members.map((id) => [id, 'applied' as ApplicationState]));
  const report = await loopFor(byMember).promise;
  assert.equal(report.ok, true, report.summary);
  assert.equal(report.states.length, 3);
  assert.ok(report.states.every((state) => state.label === 'applied · 已生效'));
  assert.ok(report.states.every((state) => state.nextStep.includes('/market verify')));
  assert.deepEqual(report.membersInDump, group.members);
  assert.equal(report.entry?.entry, '/transcript');
  assert.match(report.entry!.output, /调用成功/);
  assert.match(report.summary, /装后回路通过/);
});

test('restart-required: wording says reboot required with a reboot next step', async () => {
  const byMember = Object.fromEntries(group.members.map((id) => [id, 'restart-required' as ApplicationState]));
  const report = await loopFor(byMember).promise;
  assert.ok(report.states.every((state) => state.label === 'restart-required · 需重启后生效'));
  assert.ok(report.states.every((state) => state.nextStep.includes('重启 dsh web')));
});

test('overridden: explicitly says 被更高优先级层覆盖, never a generic failure', async () => {
  const byMember = Object.fromEntries(group.members.map((id) => [id, 'overridden' as ApplicationState]));
  const report = await loopFor(byMember, { keepRowWhenOverridden: true }).promise;
  // Even though every row is present/enabled/active, the live loop must fail.
  assert.equal(report.ok, false);
  assert.equal(report.verification.ok, false, 'overridden must not pass verification');
  assert.ok(report.states.every((state) => state.label === 'overridden · 被更高优先级层覆盖'));
  assert.ok(report.states.every((state) => state.nextStep.includes('被更高优先级层覆盖')));
  assert.match(report.summary, /被更高优先级层覆盖/);
  const rendered = renderInstallReport({
    groupId: group.id, mode: 'live', startedAt: report.startedAt, finishedAt: report.finishedAt,
    ok: false, summary: report.summary, conflicts: [], steps: [], verification: report.verification,
    nextSteps: [], liveLoop: report,
  });
  assert.match(rendered, /overridden · 被更高优先级层覆盖/);
  assert.match(rendered, /不要当作安装成功/);
});

test('failed and cancelled: each state has its own label and recovery step', async () => {
  const byMember: Record<string, ApplicationState> = {
    [group.members[0]!]: 'failed',
    [group.members[1]!]: 'cancelled',
    [group.members[2]!]: 'failed',
  };
  const report = await loopFor(byMember).promise;
  assert.equal(report.ok, false);
  assert.equal(report.states[0]!.label, 'failed · 失败');
  assert.match(report.states[0]!.nextStep, /日志/);
  assert.equal(report.states[1]!.label, 'cancelled · 已取消');
  assert.match(report.states[1]!.nextStep, /重新运行/);
});

test('overridden wording is a dedicated guidance entry, not an error-code fallback', () => {
  assert.equal(FOUR_STATE_GUIDANCE.overridden.label, 'overridden · 被更高优先级层覆盖');
  assert.match(FOUR_STATE_GUIDANCE.overridden.nextStep, /被更高优先级层覆盖/);
  const line = renderFourStateLine('overridden', group.members[0]!, 'higher-priority patch');
  assert.equal(line.application, 'overridden');
  assert.match(line.label, /被更高优先级层覆盖/);
  assert.match(line.detail, /higher-priority patch/);
});

test('/market install automatically runs the live loop with injected raw hooks', async () => {
  const commands = new Map<string, { handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }> }>();
  const tools = new Map<string, unknown>();
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    commands: {
      register: (definition: { name: string; handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }> }) => commands.set(definition.name, definition),
    },
    tools: { register: (definition: { name: string }) => tools.set(definition.name, definition) },
  };
  const seam = fakeSeam();
  let dumped = 0;
  const called: string[] = [];
  const deps: RuntimeDeps = {
    embedded: SNAPSHOT_TEXT,
    fetchText: async () => { throw new Error('offline'); },
    readCache: async () => null,
    writeCache: async () => {},
    now: FIXED_NOW,
    seam,
    dumpConfig: () => { dumped += 1; return dumpFixture(); },
    callEntry: (entry: string) => { called.push(entry); return entryProbe(entry); },
  };
  apply(ctx as never, { enabled: true }, deps);

  const installed = await commands.get('market')!.handler({ rawInput: 'install archive-chain' });
  assert.equal(installed.kind, 'success', installed.text);
  assert.equal(dumped, 1, 'dump-config must run exactly once per install');
  assert.equal(called.length, 1, 'one member entry must be invoked once');
  assert.match(installed.text, /装后生效回路（dump-config → 入口调用 → 四态）/);
  assert.match(installed.text, /applied · 已生效/);
  assert.equal(seam.calls.length, 3);
});
