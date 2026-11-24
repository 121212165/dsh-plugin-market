/** M2 orchestration tests with a fake plugin_manager seam. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { manualInstallCommands, quoteShellArgument, runGroupInstall, verifyGroup } from '../src/core/index.ts';
import type {
  ApplicationState,
  ChangeResultLike,
  InstallSeam,
  InstalledRow,
} from '../src/core/index.ts';
import { snapshotIndex } from './helpers.ts';

const index = snapshotIndex();
const FIXED_NOW = () => Date.parse('2026-11-21T12:00:00.000Z');

interface FakeOptions {
  application?: ApplicationState | ((spec: string) => ApplicationState);
  errorCode?: string;
  throwOnInstall?: boolean;
  preinstalled?: string[];
  keepRowWhenFailed?: boolean;
}

function fakeSeam(options: FakeOptions = {}): InstallSeam & { calls: string[]; rows: InstalledRow[] } {
  const calls: string[] = [];
  const rows: InstalledRow[] = (options.preinstalled ?? []).map((id) => ({
    id, moduleName: id, enabled: true, fiberPhase: 'active',
  }));
  return {
    kind: 'fake',
    source: 'fake ctx.pluginManager',
    calls,
    rows,
    async listPlugins() { return rows; },
    async listBundles() { return []; },
    async installBundle(spec: string) {
      calls.push(spec);
      if (options.throwOnInstall) throw new TypeError('installBundle is not a function');
      const application = typeof options.application === 'function'
        ? options.application(spec)
        : options.application ?? 'applied';
      if (application === 'applied' || application === 'restart-required' || (options.keepRowWhenFailed && application === 'failed')) {
        rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: application === 'restart-required' ? 'pending' : 'active' });
      }
      const result: ChangeResultLike = {
        changed: true, application, stage: 'install', target: spec, enabled: true,
        ...(application === 'failed' || application === 'cancelled'
          ? { error: { code: options.errorCode ?? 'operation-error', diagnostic: 'fake diagnostic' } }
          : {}),
      };
      return result;
    },
  };
}

test('clean profile: archive-chain installs in member order and verifies all four states', async () => {
  const seam = fakeSeam();
  const report = await runGroupInstall({
    groupId: 'archive-chain', index, seam, now: FIXED_NOW,
    // A clean profile has no commands from these members yet.
    registeredCommands: [],
  });
  assert.equal(report.ok, true, report.summary);
  assert.equal(report.mode, 'live');
  assert.deepEqual(seam.calls, report.steps.filter((step) => step.status === 'done').map((step) => step.spec));
  assert.equal(seam.calls.length, 3);
  assert.deepEqual(report.steps.map((step) => step.member), index.groups.find((g) => g.id === 'archive-chain')!.members);
  assert.ok(report.steps.every((step) => step.application === 'applied'));
  assert.equal(report.verification?.ok, true);
  assert.match(report.summary, /归档链/);
  assert.match(report.summary, /生效/);
});

test('restart-required is a success with an explicit reboot step, not a silent failure', async () => {
  const seam = fakeSeam({ application: 'restart-required' });
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam, now: FIXED_NOW });
  assert.ok(report.steps.every((step) => step.status === 'done' && step.application === 'restart-required'));
  assert.ok(report.nextSteps.some((line) => line.includes('重启 web')));
});

test('overridden is reported as failed with a higher-priority-layer repair step', async () => {
  const seam = fakeSeam({ application: 'overridden' });
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam, now: FIXED_NOW });
  assert.equal(report.ok, false);
  assert.ok(report.steps.every((step) => step.status === 'failed'));
  assert.ok(report.nextSteps.some((line) => line.includes('更高优先级层')), report.nextSteps.join('\n'));
  assert.ok(report.nextSteps.some((line) => line.includes('dsh plugin --profile')));
});

test('a host error code produces a concrete next step and never a stack trace', async () => {
  const seam = fakeSeam({ application: 'failed', errorCode: 'incompatible-version' });
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam, now: FIXED_NOW });
  assert.equal(report.ok, false);
  assert.ok(!report.summary.includes('TypeError'));
  assert.ok(report.nextSteps.some((line) => line.includes('升级 dsh')), report.nextSteps.join('\n'));
  assert.ok(report.steps.every((step) => step.detail.includes('fake diagnostic')));
});

test('a seam signature change is converted into a readable failure with repair commands', async () => {
  const seam = fakeSeam({ throwOnInstall: true });
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam, now: FIXED_NOW });
  assert.equal(report.ok, false);
  assert.ok(report.steps.every((step) => step.status === 'failed'));
  assert.ok(report.nextSteps.some((line) => line.includes('/market seams')));
  assert.ok(report.nextSteps.some((line) => line.includes('dsh plugin --profile')));
});

test('blocking conflicts prevent every installBundle call', async () => {
  const seam = fakeSeam();
  const report = await runGroupInstall({
    groupId: 'archive-chain', index, seam, now: FIXED_NOW,
    registeredCommands: ['/archive'],
  });
  assert.equal(report.ok, false);
  assert.equal(seam.calls.length, 0);
  assert.ok(report.nextSteps.some((line) => line.includes('--without')));
  assert.ok(report.nextSteps.some((line) => line.includes("dsh plugin --profile 'web' list")));
});

test('--without verifies only included members and reports installed count against the full group', async () => {
  const seam = fakeSeam();
  const report = await runGroupInstall({
    groupId: 'archive-chain', index, seam, now: FIXED_NOW,
    excluded: ['dsh-plugin-obsidian-push'], registeredCommands: [],
  });
  assert.equal(report.ok, true, report.summary);
  assert.equal(report.verification?.members.length, 2);
  assert.match(report.summary, /已安装 2\/3 个组成员（部分安装）/);
  assert.match(report.summary, /按要求跳过 dsh-plugin-obsidian-push/);
  assert.doesNotMatch(report.verification!.members.map((member) => member.member).join(','), /obsidian-push/);
});

test('all --without members is a safe no-op, not a successful installation', async () => {
  const seam = fakeSeam();
  const report = await runGroupInstall({
    groupId: 'archive-chain', index, seam, now: FIXED_NOW,
    excluded: index.groups.find((group) => group.id === 'archive-chain')!.members,
  });
  assert.equal(report.ok, false);
  assert.equal(seam.calls.length, 0);
  assert.equal(report.steps.every((step) => step.status === 'skipped'), true);
  assert.match(report.summary, /已安装 0\/3 个成员/);
  assert.match(report.nextSteps[0]!, /至少保留一个成员/);
});

test('failed host result remains raw when the active installed row contradicts it', async () => {
  const seam = fakeSeam({
    application: (spec) => spec.endsWith('dsh-plugin-transcript') ? 'failed' : 'applied',
    keepRowWhenFailed: true,
  });
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam, now: FIXED_NOW, registeredCommands: [] });
  const step = report.steps.find((item) => item.member === 'dsh-plugin-transcript')!;
  const row = report.verification?.members.find((item) => item.member === 'dsh-plugin-transcript')!;
  assert.equal(step.application, 'failed', 'do not rewrite the host four-state result');
  assert.equal(row.present && row.active && row.enabled, true);
  assert.equal(row.hostResultMismatch, true);
  assert.equal(report.ok, false);
  assert.match(report.summary, /宿主结果与清单不一致/);
  assert.match(row.detail, /application=failed.*宿主结果与清单不一致/);
  assert.ok(row.nextSteps.some((item) => item.includes('Already up to date')));
});

test('manual commands quote hostile profile/specs for POSIX and PowerShell', () => {
  const profile = "web profile'; echo INJECTED; $(whoami) `whoami`";
  const spec = "pkg ' ; echo INJECTED; $(whoami) `whoami`";
  const posix = manualInstallCommands(spec, profile, 'archive-chain', 'posix');
  assert.equal(quoteShellArgument("a'b; $(touch x) `id`", 'posix'), "'a'\"'\"'b; $(touch x) `id`'");
  assert.match(posix[0]!, /^dsh plugin --profile 'web profile'"'"'; echo INJECTED; \$\(whoami\) `whoami`' add 'pkg '"'"' ; echo INJECTED;/);
  assert.match(posix[1]!, /grep -F -- 'pkg '"'"' ; echo INJECTED;/);

  const powershell = manualInstallCommands(spec, profile, 'archive-chain', 'powershell');
  assert.equal(quoteShellArgument("a'b; $(touch x) `id`", 'powershell'), "'a''b; $(touch x) `id`'");
  assert.match(powershell[0]!, /^dsh plugin --profile 'web profile''; echo INJECTED; \$\(whoami\) `whoami`' add 'pkg '' ; echo INJECTED;/);
  assert.match(powershell[1]!, /Select-String -SimpleMatch -Pattern 'pkg '' ; echo INJECTED;/);
  assert.throws(() => quoteShellArgument('profile\nsecond-line', 'posix'), /line breaks/);
});

test('degraded mode returns manual commands and never claims success', async () => {
  const report = await runGroupInstall({ groupId: 'archive-chain', index, seam: null, now: FIXED_NOW });
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'degraded');
  assert.equal(report.steps.length, 0);
  assert.equal(report.nextSteps.length, 9);
  assert.ok(report.nextSteps.every((line) => line.startsWith('dsh plugin') || line.includes('dump-config') || line.startsWith('/market verify')));
  assert.match(report.summary, /未执行任何安装/);
});

test('verify alone reports missing members and restart-required rows', async () => {
  const report = await verifyGroup({
    groupId: 'archive-chain', index, seam: null,
    applicationByMember: { 'dsh-plugin-transcript': 'restart-required' },
    now: FIXED_NOW,
  });
  assert.equal(report.ok, false);
  assert.ok(report.members.some((member) => member.detail.includes('未在安装清单中出现')));
  assert.ok(report.members.some((member) => member.detail.includes('restart-required')));
});
