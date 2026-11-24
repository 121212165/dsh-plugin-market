/** Pure M2 pre-check tests: every collision must carry an executable fix. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planGroupInstall, renderConflicts } from '../src/core/index.ts';
import { snapshotIndex } from './helpers.ts';

const index = snapshotIndex();

function group(id: string) {
  const found = index.groups.find((candidate) => candidate.id === id);
  assert.ok(found, `fixture group ${id} missing`);
  return found;
}

test('archive-chain has no internal command/package collision', () => {
  const plan = planGroupInstall({ group: group('archive-chain'), index });
  assert.equal(plan.blocked, false);
  assert.equal(plan.conflicts.length, 0, JSON.stringify(plan.conflicts));
  assert.deepEqual(plan.steps.map((step) => step.member), group('archive-chain').members);
});

test('a command name shared by two members is blocking and suggests --without + rename', () => {
  const original = group('archive-chain');
  const broken = { ...original, id: 'broken-chain', members: ['dsh-plugin-transcript', 'dsh-plugin-obsidian-push'] };
  const clash = index.plugins.find((plugin) => plugin.id === 'dsh-plugin-obsidian-push')!;
  const fixture = {
    ...index,
    plugins: index.plugins.map((plugin) => plugin.id === clash.id
      ? { ...plugin, entries: ['/transcript', 'obsidian_push'] }
      : plugin),
  };
  const plan = planGroupInstall({ group: broken, index: fixture });
  const conflict = plan.conflicts.find((item) => item.kind === 'command' && item.key === '/transcript');
  assert.ok(conflict, JSON.stringify(plan.conflicts));
  assert.equal(conflict.severity, 'blocking');
  assert.equal(plan.blocked, true);
  assert.match(conflict.fix, /--without dsh-plugin-obsidian-push/);
  assert.match(conflict.fix, /改名/);
  assert.match(renderConflicts(plan), /修复建议/);
});

test('a live host command collision suggests finding and removing the old plugin', () => {
  const plan = planGroupInstall({
    group: group('archive-chain'), index,
    registeredCommands: ['/archive', '/find'],
  });
  const conflict = plan.conflicts.find((item) => item.kind === 'command' && item.members.length === 1);
  assert.ok(conflict, JSON.stringify(plan.conflicts));
  assert.equal(conflict.severity, 'blocking');
  assert.match(conflict.fix, /dsh plugin --profile 'web' list/);
  assert.match(conflict.fix, /--without/);
});

test('an already-active member is a warning and is skipped, not reinstalled', () => {
  const transcript = index.plugins.find((plugin) => plugin.id === 'dsh-plugin-transcript')!;
  const plan = planGroupInstall({
    group: group('archive-chain'), index,
    inventory: { plugins: [{ id: transcript.npm!, moduleName: transcript.npm!, enabled: true, fiberPhase: 'active' }] },
  });
  assert.equal(plan.blocked, false);
  const warn = plan.conflicts.find((item) => item.kind === 'already-installed');
  assert.ok(warn);
  assert.equal(warn.severity, 'warn');
  assert.match(warn.fix, /dsh plugin --profile 'web' remove/);
  assert.equal(plan.steps.find((step) => step.member === 'dsh-plugin-transcript')?.action, 'skip-installed');
});

test('a missing group member blocks before any install is attempted', () => {
  const original = group('archive-chain');
  const plan = planGroupInstall({
    group: { ...original, members: [...original.members, 'dsh-plugin-nonexistent'] },
    index,
  });
  const conflict = plan.conflicts.find((item) => item.kind === 'missing-member');
  assert.ok(conflict);
  assert.equal(conflict.severity, 'blocking');
  assert.match(conflict.fix, /npm run build/);
});

test('--without removes the excluded member from the plan', () => {
  const plan = planGroupInstall({
    group: group('archive-chain'), index,
    excluded: ['dsh-plugin-obsidian-push'],
  });
  assert.deepEqual(plan.steps.map((step) => step.member), [
    'dsh-plugin-transcript', 'dsh-plugin-obsidian-push', 'dsh-plugin-transcript-search',
  ]);
  assert.equal(plan.steps[1]!.action, 'skip-excluded');
  assert.equal(plan.blocked, false);
});

test('--without with an unknown id blocks instead of silently installing the full group', () => {
  const plan = planGroupInstall({
    group: group('archive-chain'), index,
    excluded: ['dsh-plugin-transcript', 'dsh-plugin-typo'],
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.conflicts.some((item) => item.kind === 'invalid-exclusion' && item.key === 'dsh-plugin-typo'), true);
  assert.deepEqual(plan.steps.filter((step) => step.action === 'install').map((step) => step.member), [
    'dsh-plugin-obsidian-push', 'dsh-plugin-transcript-search',
  ]);
});

test('F6: two members both declaring /health block before install with a fix', () => {
  const original = group('saving-combo');
  const radar = index.plugins.find((plugin) => plugin.id === 'dsh-plugin-error-radar')!;
  const fixture = {
    ...index,
    plugins: [...index.plugins, radar],
    groups: [...index.groups, { ...original, id: 'health-clash', members: ['dsh-plugin-cache-guard', 'dsh-plugin-error-radar'] }],
  };
  const plan = planGroupInstall({
    group: fixture.groups.find((candidate) => candidate.id === 'health-clash')!, index: fixture,
  });
  const conflict = plan.conflicts.find((item) => item.kind === 'command' && item.key === '/health');
  assert.ok(conflict, JSON.stringify(plan.conflicts));
  assert.equal(conflict.severity, 'blocking');
  assert.equal(plan.blocked, true);
  assert.deepEqual(conflict.members, ['dsh-plugin-cache-guard', 'dsh-plugin-error-radar']);
  assert.match(conflict.detail, /都声明了 \/health/);
  assert.match(conflict.fix, /--without dsh-plugin-error-radar/);
  assert.match(conflict.fix, /改名/);
  assert.match(renderConflicts(plan), /\[阻断\].*\/health/);
});

test('F6: a slot claimed by two members blocks with a slot-specific fix', () => {
  const original = group('archive-chain');
  const broken = { ...original, id: 'slot-clash', members: ['dsh-plugin-transcript', 'dsh-plugin-obsidian-push'] };
  const fixture = {
    ...index,
    plugins: index.plugins.map((plugin) => {
      if (plugin.id === 'dsh-plugin-transcript') return { ...plugin, slots: ['conversation.view'] };
      if (plugin.id === 'dsh-plugin-obsidian-push') return { ...plugin, slots: ['conversation.view'] };
      return plugin;
    }),
  };
  const plan = planGroupInstall({ group: broken, index: fixture });
  const conflict = plan.conflicts.find((item) => item.kind === 'slot');
  assert.ok(conflict, JSON.stringify(plan.conflicts));
  assert.equal(conflict.severity, 'blocking');
  assert.equal(plan.blocked, true);
  assert.match(conflict.fix, /--without dsh-plugin-obsidian-push/);
  assert.match(conflict.fix, /slot/);
});

test('F6: a host-occupied slot blocks with guidance to remove the old layer', () => {
  const original = group('archive-chain');
  const fixture = {
    ...index,
    plugins: index.plugins.map((plugin) => plugin.id === 'dsh-plugin-transcript'
      ? { ...plugin, slots: ['conversation.view'] }
      : plugin),
  };
  const plan = planGroupInstall({
    group: original, index: fixture, registeredSlots: ['conversation.view'],
  });
  const conflict = plan.conflicts.find((item) => item.kind === 'slot' && item.members.length === 1);
  assert.ok(conflict, JSON.stringify(plan.conflicts));
  assert.equal(conflict.severity, 'blocking');
  assert.match(conflict.fix, /dsh plugin --profile 'web' list/);
});
