/** F2 plugin-side vote: read-only guidance when not logged in, a real 👍
 * reaction when logged in, no local fake votes, and command/tool shared flow. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, type Config, type RuntimeDeps } from '../src/plugin.ts';
import { renderVoteReadOnly, renderVoteResult, type GhAuthStatus, type VoteCastResult, type VoteDiscussion } from '../src/core/vote.ts';
import { SNAPSHOT_TEXT, snapshotIndex } from './helpers.ts';

const ID = 'dsh-plugin-quota';

const SNAPSHOT_TIME = Date.parse(snapshotIndex().generatedAt);
const config: Partial<Config> = { enabled: true };

function embeddedWithVotes(votes = 7): string {
  const index = snapshotIndex();
  return JSON.stringify({
    ...index,
    plugins: index.plugins.map((plugin) => plugin.id === ID ? { ...plugin, votes } : plugin),
  });
}

const offlineDeps = (embedded = embeddedWithVotes()): RuntimeDeps => ({
  fetchText: async () => { throw new Error('offline'); },
  readCache: async () => null,
  writeCache: async () => {},
  embedded,
  now: () => SNAPSHOT_TIME,
});

interface CapturedCommand {
  name: string;
  handler: (arg: { rawInput?: string }) => Promise<{ kind: string; text: string }>;
}
interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
  presentCall?: (args: Record<string, unknown>) => Record<string, unknown>;
  presentResult?: (args: Record<string, unknown>, value: unknown) => Record<string, unknown>;
}

function makeCtx() {
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    commands: { register(definition: CapturedCommand) { commands.push(definition); } },
    tools: { register(definition: CapturedTool) { tools.push(definition); } },
  };
  const command = (name: string): CapturedCommand => commands.find((item) => item.name === name)!;
  const tool = (name: string): CapturedTool => tools.find((item) => item.name === name)!;
  return { ctx, command, tool };
}

const LOGGED_OUT: GhAuthStatus = {
  authenticated: false,
  note: '未检测到可用的 GitHub 身份；运行 `gh auth login` 登录后重试。当前只显示快照票数，不会在本地记假票。',
};
const LOGGED_IN: GhAuthStatus = { authenticated: true, login: 'alice', note: '已以 alice 身份登录 GitHub' };
const DISCUSSION: VoteDiscussion = {
  id: 'D_123',
  title: `Vote: ${ID}`,
  url: 'https://github.com/121212165/dsh-market-data/discussions/1',
  body: `<!-- dsh-market-plugin-id: ${ID} -->`,
};

test('renderVoteReadOnly: no login means read-only votes + gh auth login guidance', () => {
  const text = renderVoteReadOnly(ID, 7, LOGGED_OUT.note, '数据 快照 2026-11-21');
  assert.match(text, /当前有效票：7/);
  assert.match(text, /gh auth login/);
  assert.match(text, /不会在本地记假票/);
});

test('renderVoteResult: keeps the snapshot stamp and explains the refresh lag', () => {
  const result: VoteCastResult = { ok: true, message: '已写入 👍 reaction', discussionUrl: DISCUSSION.url };
  const text = renderVoteResult(ID, 7, result, '数据 快照 2026-11-21');
  assert.match(text, /快照有效票：7/);
  assert.match(text, /定时任务刷新/);
  assert.match(text, /discussions\/1/);
});

test('/market vote when logged out: read-only, never calls the vote writer', async () => {
  const wired = makeCtx();
  let finderCalls = 0;
  let writerCalls = 0;
  apply(wired.ctx as never, config, {
    ...offlineDeps(),
    ghAuthProbe: async () => LOGGED_OUT,
    voteFinder: async () => { finderCalls += 1; return DISCUSSION; },
    voteWriter: async () => { writerCalls += 1; return { ok: true, message: 'should not happen' }; },
  });
  const result = await wired.command('market').handler({ rawInput: `vote ${ID}` });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /当前有效票：7/);
  assert.match(result.text, /gh auth login/);
  assert.equal(finderCalls, 0);
  assert.equal(writerCalls, 0);
});

test('/market vote when logged in: writes the real 👍 reaction', async () => {
  const wired = makeCtx();
  const calls: string[] = [];
  apply(wired.ctx as never, config, {
    ...offlineDeps(),
    ghAuthProbe: async () => LOGGED_IN,
    voteFinder: async (pluginId) => { calls.push(`find:${pluginId}`); return DISCUSSION; },
    voteWriter: async (discussionId, pluginId) => {
      calls.push(`write:${discussionId}:${pluginId}`);
      return { ok: true, message: '已写入 👍 reaction（一人一票由数据仓快照去重）' };
    },
  });
  const result = await wired.command('market').handler({ rawInput: `vote ${ID}` });
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls, [`find:${ID}`, `write:${DISCUSSION.id}:${ID}`]);
  assert.match(result.text, /已写入 👍 reaction/);
  assert.match(result.text, /discussions\/1/);
});

test('/market vote with unknown id: error lists available ids, no auth probe', async () => {
  const wired = makeCtx();
  let probeCalls = 0;
  apply(wired.ctx as never, config, {
    ...offlineDeps(),
    ghAuthProbe: async () => { probeCalls += 1; return LOGGED_IN; },
  });
  const result = await wired.command('market').handler({ rawInput: 'vote dsh-plugin-does-not-exist' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /未知插件/);
  assert.match(result.text, new RegExp(ID));
  assert.equal(probeCalls, 0);
});

test('market_vote tool: present cards and execute share the command flow', async () => {
  const wired = makeCtx();
  const writes: string[] = [];
  apply(wired.ctx as never, config, {
    ...offlineDeps(),
    ghAuthProbe: async () => LOGGED_IN,
    voteFinder: async () => DISCUSSION,
    voteWriter: async (discussionId) => {
      writes.push(discussionId);
      return { ok: true, message: '已写入 👍 reaction' };
    },
  });
  const tool = wired.tool('market_vote');
  assert.ok(tool, 'market_vote must be registered');
  assert.deepEqual(tool.presentCall?.({ pluginId: ID }), {
    card: 'generic', title: `为插件投票：${ID}`, kind: 'execute', rawInput: ID,
  });
  assert.equal(tool.presentResult?.({ pluginId: ID }, 'x')?.['kind'], 'execute');
  const text = await tool.execute({ pluginId: ID });
  assert.deepEqual(writes, [DISCUSSION.id]);
  assert.match(text, /已写入 👍 reaction/);
});
