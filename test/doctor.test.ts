/** F4 doctor: vendor-output mapping + two real fixtures (missing locale / healthy). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { apply } from '../src/plugin.ts';
import {
  parseVendorOutput,
  priorityFor,
  renderDoctorReport,
  runDoctor,
  type DoctorReport,
} from '../src/core/doctor.ts';

const VENDOR = fileURLToPath(new URL('../scripts/vendor/verify-plugin.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/doctor/', import.meta.url));

/** Copy a static fixture into a temp git repo: G0-7/G0-9 need real version control. */
function gitRepoFrom(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'market-doctor-'));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', [
    '-C', dir, '-c', 'user.name=Doctor', '-c', 'user.email=doctor@example.test',
    'commit', '-q', '-m', 'fixture',
  ], { stdio: 'pipe' });
  return dir;
}

test('vendor output parsing keeps codes and maps FAIL/WARN to P0/P1/P2', () => {
  const parsed = parseVendorOutput([
    'FAIL:',
    '  fixture: G0-6: locale/zh.json 缺键 market.title（en.json 有）',
    '  fixture: SDS-1b: tsconfig.json 缺 noUnusedLocals',
    'WARN:',
    '  fixture: SDS-3: sideEffects 未显式 false',
    '结果: 1 插件 / 2 FAIL / 1 WARN',
  ].join('\n'));
  assert.deepEqual(parsed.map((line) => [line.severity, line.code]), [
    ['FAIL', 'G0-6'],
    ['FAIL', 'SDS-1b'],
    ['WARN', 'SDS-3'],
  ]);
  assert.equal(priorityFor('FAIL', 'G0-6'), 'P0');
  assert.equal(priorityFor('FAIL', 'SDS-1b'), 'P1');
  assert.equal(priorityFor('WARN', 'SDS-3'), 'P2');
});

test('acceptance: a plugin missing locale resources is named G0-6 with the exports edit location', async (t) => {
  const target = gitRepoFrom('missing-locale');
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const report = await runDoctor({ target, vendorScript: VENDOR });
  const g06 = report.issues.filter((issue) => issue.code === 'G0-6');
  assert.equal(g06.length, 1, `expected one local G0-6, got: ${JSON.stringify(report.issues)}`);
  assert.equal(g06[0]!.priority, 'P0');
  assert.equal(g06[0]!.severity, 'FAIL');
  assert.equal(report.ok, false);
  assert.equal(report.counts.P0, 1);
  assert.ok(g06[0]!.message.includes('exports'), g06[0]!.message);
  assert.ok(g06[0]!.message.includes('lib/locales'), g06[0]!.message);

  const text = renderDoctorReport(report);
  assert.ok(text.includes('P0 发布阻断'), text);
  assert.ok(text.includes('[G0-6]'), text);
  assert.ok(text.includes('package.json#exports["./locales/*"]'), text);
  assert.ok(text.includes('lib/locales/'), text);
  assert.ok(text.includes('copyFileSync'), text);
  assert.ok(text.includes('不通过'), text);
});

test('a healthy plugin passes the doctor with no P0/P1/P2 issues', async (t) => {
  const target = gitRepoFrom('healthy');
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const report = await runDoctor({ target, vendorScript: VENDOR });
  assert.equal(report.ok, true, renderDoctorReport(report));
  assert.deepEqual(report.counts, { P0: 0, P1: 0, P2: 0 });
  assert.equal(report.issues.some((issue) => issue.code === 'G0-6'), false);
  assert.ok(renderDoctorReport(report).includes('可发布'));
});

test('missing path argument yields an actionable P0 instead of throwing', async () => {
  const report = await runDoctor({ target: '   ' });
  assert.equal(report.ok, false);
  assert.equal(report.issues[0]!.code, 'ARGS');
  assert.ok(renderDoctorReport(report).includes('/market doctor <path>'));
});

test('/market doctor and market_doctor share one runner and the present-card pattern', async () => {
  const fake: DoctorReport = {
    target: 'C:\\plugins\\foo',
    ok: false,
    counts: { P0: 1, P1: 1, P2: 1 },
    issues: [
      {
        code: 'G0-6',
        priority: 'P0',
        severity: 'FAIL',
        message: '缺 locale 资源',
        location: 'package.json#exports["./locales/*"]',
        fix: '"exports": { "./locales/*": "./lib/locales/*" }',
      },
      {
        code: 'SDS-1b',
        priority: 'P1',
        severity: 'FAIL',
        message: '缺 noUnusedLocals',
        location: 'tsconfig.json#compilerOptions',
        fix: '"noUnusedLocals": true',
      },
      {
        code: 'SDS-3',
        priority: 'P2',
        severity: 'WARN',
        message: 'sideEffects 未显式 false',
        location: 'package.json#sideEffects',
        fix: '"sideEffects": false',
      },
    ],
    gateSource: 'fake',
    note: 'fake report',
  };
  const calls: string[] = [];
  const commands: Array<{ name: string; handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }> }> = [];
  const tools: Array<{
    name: string;
    execute: (args: { path?: string }) => Promise<string>;
    presentCall?: (args: { path: string }) => { card: string; kind: string; rawInput?: string };
    presentResult?: (args: unknown, value: unknown) => { card: string; kind: string };
  }> = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    commands: { register: (definition: (typeof commands)[number]) => commands.push(definition) },
    tools: { register: (definition: (typeof tools)[number]) => tools.push(definition) },
  };
  apply(ctx as never, { enabled: true }, {
    embedded: '{}',
    fetchText: async () => { throw new Error('offline'); },
    readCache: async () => null,
    writeCache: async () => {},
    doctor: async (target) => { calls.push(target); return fake; },
  });

  const command = commands.find((candidate) => candidate.name === 'market');
  const tool = tools.find((candidate) => candidate.name === 'market_doctor');
  assert.ok(command, 'market command must be registered');
  assert.ok(tool, 'market_doctor tool must be registered');
  assert.equal(typeof tool!.presentCall, 'function');
  assert.equal(tool!.presentCall!({ path: 'x' }).card, 'generic');

  const fromCommand = await command!.handler({ rawInput: 'doctor C:\\plugins\\foo' });
  assert.equal(fromCommand.kind, 'error', fromCommand.text);
  assert.ok(fromCommand.text.includes('[G0-6]'), fromCommand.text);
  assert.ok(fromCommand.text.includes('package.json#exports["./locales/*"]'), fromCommand.text);

  const fromTool = await tool!.execute({ path: 'C:\\plugins\\foo' });
  assert.equal(fromTool, renderDoctorReport(fake));
  assert.deepEqual(calls, ['C:\\plugins\\foo', 'C:\\plugins\\foo']);

  const noPath = await command!.handler({ rawInput: 'doctor' });
  assert.equal(noPath.kind, 'error');
  assert.ok(noPath.text.includes('用法：/market doctor <本地插件仓路径>'));
});
