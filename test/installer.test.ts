/** M2 orchestration tests with a fake plugin_manager seam. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { manualInstallCommands, runGroupInstall, verifyGroup } from '../src/core/index.ts';
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
      if (application === 'applied' || application === 'restart-required') {
        rows.push({ id: spec, moduleName: spec, enabled: true, fiberPhase: application === 'applied' ? 'active' : 'pending' });
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
  assert.ok(report.nextSteps.some((line) => line.includes('dsh plugin --profile web list')));
});

test('--without excludes a member from verification and reports the partial install clearly', async () => {
  const seam = fakeSeam();
  const report = await runGroupInstall({
    groupId: 'archive-chain', index, seam, now: FIXED_NOW,
    registeredCommands: [], excluded: ['dsh-plugin-obsidian-push'],
  });
  assert.equal(report.ok, true, report.summary);
  assert.equal(report.verification?.ok, true);
  assert.equal(report.verification?.members.length, 2);
  assert.match(report.summary, /按要求跳过 dsh-plugin-obsidian-push/);
});

test('manual install commands shell-quote catalog values and grep literally', () => {
  const commands = manualInstallCommands(`pkg'; touch /tmp/unexpected; echo '`, `web profile`, 'archive-chain');
  assert.equal(commands[0], `dsh plugin --profile 'web profile' add 'pkg'"'"'; touch /tmp/unexpected; echo '"'"''`);
  assert.equal(commands[1], `dsh --profile 'web profile' --dump-config | grep -F -- 'pkg'"'"'; touch /tmp/unexpected; echo '"'"''`);
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
