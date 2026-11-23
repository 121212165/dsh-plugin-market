/** Assembly-layer test: mount the real apply() against a scripted cordis ctx. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type Config, type RuntimeDeps } from '../src/plugin.ts';
import { isHostBlocked, type MarketRead } from '../src/core/index.ts';
import { freshIndex, SNAPSHOT_TEXT, snapshotIndex } from './helpers.ts';

const SNAPSHOT_TIME = Date.parse(snapshotIndex().generatedAt);

interface CapturedCommand {
  name: string;
  description?: string;
  handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
}
interface CapturedTool {
  name: string;
  execute: (args: { groupId?: string }) => Promise<string>;
  presentCall?: (...args: unknown[]) => unknown;
}

function makeCtx() {
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const logs: string[] = [];
  const ctx = {
    logger() {
      return { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message), debug() {} };
    },
    commands: { register(definition: CapturedCommand) { commands.push(definition); } },
    tools: { register(definition: CapturedTool) { tools.push(definition); } },
  };
  const command = (name: string): CapturedCommand => {
    const found = commands.find((candidate) => candidate.name === name);
    assert.ok(found, `command ${name} was never registered`);
    return found;
  };
  const tool = (name: string): CapturedTool => {
    const found = tools.find((candidate) => candidate.name === name);
    assert.ok(found, `tool ${name} was never registered`);
    return found;
  };
  return { ctx, commands, tools, logs, command, tool };
}

const config: Partial<Config> = {
  enabled: true,
  rawUrl: 'https://raw.githubusercontent.com/121212165/dsh-market-data/main/data/index.json',
  mirrorUrl: 'https://cdn.jsdelivr.net/gh/121212165/dsh-market-data@main/data/index.json',
};

/** Acceptance setup: raw + api + mirror all blocked, cache deleted, embedded snapshot present. */
const offlineDeps: RuntimeDeps = {
  fetchText: async (url: string) => {
    if (isHostBlocked(url, ['raw.githubusercontent.com', 'api.github.com', 'cdn.jsdelivr.net'])) {
      throw new Error(`network blocked: ${new URL(url).hostname}`);
    }
    throw new Error('unexpected network path');
  },
  readCache: async () => null,
  writeCache: async () => {},
  embedded: SNAPSHOT_TEXT,
  // Deterministic: 72h after the snapshot stamp → always shown as a stale snapshot.
  now: () => SNAPSHOT_TIME + 72 * 3_600_000,
};

test('disabled config mounts nothing', () => {
  const wired = makeCtx();
  apply(wired.ctx as never, { enabled: false }, offlineDeps);
  assert.equal(wired.commands.length, 0);
  assert.equal(wired.tools.length, 0);
  assert.ok(wired.logs.some((line) => line.includes('disabled by config')));
});

test('mount registers the market command and the read/install/uninstall/verify/fuse tools', () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, offlineDeps);
  assert.deepEqual(wired.commands.map((candidate) => candidate.name), ['market']);
  assert.deepEqual(wired.tools.map((candidate) => candidate.name), ['market_list', 'market_install', 'market_uninstall', 'market_verify', 'market_fuse']);
  assert.equal(typeof wired.tool('market_list').presentCall, 'function');
  assert.equal(typeof wired.tool('market_install').presentCall, 'function');
  assert.equal(typeof wired.tool('market_uninstall').presentCall, 'function');
  assert.equal(typeof wired.tool('market_verify').execute, 'function');
  assert.equal(typeof wired.tool('market_fuse').presentCall, 'function');
  assert.ok(wired.logs.some((line) => line.includes('install seam unavailable')), wired.logs.join('\n'));
});

test('acceptance: /market lists 6 groups from built-in snapshot with a visible snapshot stamp', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, offlineDeps);
  const result = await wired.command('market').handler({ rawInput: '' });
  assert.equal(result.kind, 'success', result.text);
  assert.ok(result.text.includes('数据 快照'), result.text);
  assert.ok(result.text.includes('built-in snapshot.json'), result.text);
  assert.equal((result.text.match(/• /g) ?? []).length, 6, result.text);
  assert.ok(result.text.includes('开局三件套'));
  assert.ok(result.text.includes('生态雷达'));
});

test('acceptance: /market group <id> renders real contracts and executable verify steps', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, offlineDeps);
  const result = await wired.command('market').handler({ rawInput: 'group starter-three' });
  assert.equal(result.kind, 'success', result.text);
  assert.ok(result.text.includes('summary.json'), result.text);
  assert.ok(result.text.includes('/qm 有输出'), result.text);
  assert.ok(result.text.includes('/market install starter-three'), result.text);
});

test('acceptance: empty built-in snapshot still yields a successful, friendly /market reply', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, {
    ...offlineDeps,
    embedded: '{"schemaVersion":1,"generatedAt":"","plugins":[],"groups":[]}',
  });
  const result = await wired.command('market').handler({ rawInput: '' });
  assert.equal(result.kind, 'success', result.text);
  assert.ok(result.text.includes('暂无可展示的插件组'), result.text);
  assert.ok(result.text.includes('数据 快照'), result.text);
});

test('tool execute returns snapshot stamp plus group detail', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, offlineDeps);
  const text = await wired.tool('market_list').execute({ groupId: 'archive-chain' });
  assert.ok(text.includes('数据 快照'), text);
  assert.ok(text.includes('归档链'), text);
  assert.ok(text.includes('sessions/*.jsonl') || text.includes('JSONL'), text);
});

test('cache write failure is non-fatal: a successful fetch still renders live data', async () => {
  const wired = makeCtx();
  apply(wired.ctx as never, config, {
    ...offlineDeps,
    fetchText: async () => JSON.stringify(freshIndex()),
    writeCache: async () => { throw new Error('disk full'); },
    now: () => Date.now(),
  });
  const result = await wired.command('market').handler({ rawInput: '' });
  assert.equal(result.kind, 'success', result.text);
  assert.ok(result.text.includes('数据 实时'), result.text);
  assert.ok(wired.logs.some((line) => line.includes('cache write failed')), wired.logs.join('\n'));
});
