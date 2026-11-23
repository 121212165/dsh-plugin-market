/** M5 第三层：headless 冒烟。
 *
 * 不经 TS 加载器，直接加载构建产物 lib/plugin.js；在一个全新 profile（安装清单为空）
 * 上走真实 seam 探测 → 三组安装 → application 四态校验 → 调用成员入口。整个环境
 * 无 dsh 运行时、无网络、无磁盘缓存，证明「发布产物在干净环境能装、能验、能调用」。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

const built = await import('../lib/plugin.js');
const SNAPSHOT_TEXT = readFileSync(new URL('../lib/snapshot.json', import.meta.url), 'utf8');
const SNAPSHOT = JSON.parse(SNAPSHOT_TEXT);

/** 模拟全新 profile：plugin_manager 清单为空，安装后宿主注册成员声明的入口命令。 */
function freshProfileHost() {
  const rows = [];
  const callLog = [];
  const commands = [];
  const tools = [];

  const pluginManager = {
    async installBundle(spec) {
      const plugin = SNAPSHOT.plugins.find((p) => p.id === spec || p.npm === spec || `github:${p.repo}` === spec);
      const id = plugin?.id ?? spec;
      rows.push({ id, enabled: true, fiberPhase: 'active' });
      for (const entry of plugin?.entries ?? []) {
        commands.push({
          name: entry,
          async handler() {
            callLog.push({ member: id, entry });
            return `${entry} 调用成功`;
          },
        });
      }
      return { application: 'applied', stage: 'bundle', target: spec };
    },
    async listPlugins() {
      return rows.map((row) => ({ ...row }));
    },
    async listBundles() {
      return rows.map((row) => ({ name: row.id, enabled: row.enabled }));
    },
  };

  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    commands: {
      register(definition) { commands.push(definition); },
      list() { return commands; },
    },
    tools: { register(definition) { tools.push(definition); } },
    pluginManager,
  };
  return { ctx, commands, tools, rows, callLog };
}

/** 全离线：网络与缓存都失败，只靠随 lib/ 发布的内置快照。 */
const deps = {
  embedded: SNAPSHOT_TEXT,
  fetchText: async () => { throw new Error('offline: no network in headless smoke'); },
  readCache: async () => null,
  writeCache: async () => {},
  now: () => Date.now(),
};

test('headless smoke: built lib mounts, fresh-profile install, 4-state verify, entry call', async () => {
  const host = freshProfileHost();
  assert.equal(host.rows.length, 0, 'profile must start with an empty plugin inventory');

  // 1. 构建产物的 apply() 能在无 dsh 运行时的宿主上挂载
  built.apply(host.ctx, { enabled: true, allowInstall: true, profile: 'fresh-profile' }, deps);
  const market = host.commands.find((command) => command.name === 'market');
  assert.ok(market, 'built apply() must register the market command');
  assert.deepEqual(host.tools.map((tool) => tool.name).sort(), ['market_doctor', 'market_fuse', 'market_install', 'market_list', 'market_uninstall', 'market_verify']);

  // 2. 只读路径：断网 + 无缓存 → 内置快照列出 6 组
  const listed = await market.handler({ rawInput: '' });
  assert.equal(listed.kind, 'success', listed.text);
  assert.equal((listed.text.match(/• /g) ?? []).length, 6, listed.text);

  // 3. 全新 profile 一键安装「归档链」：按 members 顺序，四态 applied
  const installed = await market.handler({ rawInput: 'install archive-chain' });
  assert.equal(installed.kind, 'success', installed.text);
  const group = SNAPSHOT.groups.find((candidate) => candidate.id === 'archive-chain');
  assert.ok(group);
  assert.deepEqual(host.rows.map((row) => row.id), group.members, 'install must follow member order');
  assert.equal(host.rows.length, 3);
  assert.ok(host.rows.every((row) => row.enabled && row.fiberPhase === 'active'));
  assert.ok(installed.text.includes('归档链'), installed.text);

  // 4. 装后校验：逐成员已挂载、enabled、active、命令可见
  const verified = await market.handler({ rawInput: 'verify archive-chain' });
  assert.equal(verified.kind, 'success', verified.text);
  assert.ok(verified.text.includes('验收通过'), verified.text);

  // 5. 调用成功：宿主派发三个已装成员声明的入口，全部可执行
  const expectedEntries = group.members.flatMap((id) =>
    (SNAPSHOT.plugins.find((plugin) => plugin.id === id)?.entries ?? []).filter((entry) => entry.startsWith('/'))
  );
  const entries = host.commands.filter((command) => command.name.startsWith('/'));
  assert.equal(entries.length, expectedEntries.length, 'installed plugins should register all declared slash entries');
  for (const entry of entries) {
    const output = await entry.handler({ rawInput: '' });
    assert.ok(output.includes('调用成功'), output);
  }
  assert.equal(host.callLog.length, expectedEntries.length);
  assert.deepEqual(new Set(host.callLog.map((call) => call.member)), new Set(group.members));

  // 证据含运行时间戳，默认不落盘：否则每次 npm test 都会改写受版本控制的文件，
  // 让「构建产物与提交一致」的 git diff --exit-code 门禁永远为红。需要刷新证据时：
  // DSH_M5_EVIDENCE=1 npm test
  if (process.env.DSH_M5_EVIDENCE === '1') writeFileSync(new URL('../m5-smoke-evidence.json', import.meta.url), JSON.stringify({
    artifact: 'lib/plugin.js',
    profile: 'fresh-profile (empty inventory)',
    group: group.id,
    membersExpected: group.members,
    installOrder: host.rows.map((row) => row.id),
    applicationByMember: Object.fromEntries(host.rows.map((row) => [row.id, 'applied'])),
    verifyPassed: verified.text.includes('验收通过'),
    expectedEntryCount: expectedEntries.length,
    calls: host.callLog,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
});
