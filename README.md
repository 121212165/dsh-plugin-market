# dsh-plugin-market

dsh 插件市集插件。已实现 **M1（只读市场）+ M2（一键安装闭环）+ M3（conversation.view 卡片面板）+ M5（可发布门禁）+ F2（插件侧投票）+ F3（融合任务书/脚手架）+ F4（本地插件体检）+ F5（装后真回路）+ F6（组卸载回滚）**，共用 `src/snapshot.json` 数据契约。M4 与 F1/F7/F8 的数据站/门禁在 `../dsh-market-data/`。所有 F 分支已合并进本仓 `main`。

## M1 — 只读市场

入口：`/market`、`/market group <id>`，以及只读工具 `market_list`。

四层读兜底（前三层即计划中的"三层兜底"）：

```
raw.githubusercontent.com/index.json   ← 第一优先
cdn.jsdelivr.net/gh/<repo>@main/...     ← 国内镜像
~/.dsh/market/index.json               ← 本地缓存（24h）
src/snapshot.json                      ← 内置快照，随包发布
```

规则：
- 每次展示都带 `generatedAt`；超过 24h 标"快照"，不拿旧数据冒充实时。
- 网络与文件系统通过 `RuntimeDeps` 注入，测试可屏蔽主机、删除缓存。
- 读路径永不抛错；空/坏数据降级为空市集并给出友好提示。
- 投稿走 `dsh-market-data` 的 Issue Form（F1）；投票（F2）已开放，见下文；融合（F3）已开放，见下文。

源码：
- `src/core/` — 纯函数：types / reader（兜底链）/ render（含快照时间、空数据安全）/ parse / install-types（四态与报告）/ conflicts（冲突预检）/ seam（宿主能力探测与降级）/ installer（安装状态机与生效校验）/ uninstall（组回滚）/ fuse（能力矩阵、重叠、复用清单、来源表）/ vote（GitHub 身份探测与 👍 reaction）/ doctor（P0/P1/P2 体检）
- `src/plugin.ts` — dsh 装配层，命令与工具注册；`apply(ctx, config, deps?)` 的 `deps` 是测试缝
- `src/snapshot.json` — 由 `dsh-market-data` 的 `build-index` 生成，与 `data/index.json` 同构

## M2 — 一键安装闭环

入口（同一个 `/market` 命令的子命令，另有模型工具 `market_install` / `market_verify`）：

```
/market install <groupId>                     # 预检 → 按 members 顺序装 → 四态校验
/market install <groupId> --without <成员id>   # 跳过冲突成员
/market install <groupId> --reinstall          # 重装已存在成员
/market uninstall <groupId>                   # 按 members 逆序卸载回滚（幂等）
/market verify <groupId>                      # 只校验，不安装
/market vote <plugin-id>                      # 投票（未登录只读 + gh auth login 指引）
/market fuse <a,b> [--apply]                  # 融合任务书 / 脚手架
/market doctor <本地插件仓路径>               # 本地插件体检（P0/P1/P2，只读）
/market seams                                 # 查看 plugin_manager seam 与降级说明
```

F6 组安装冲突矩阵 / 组卸载回滚：

- **冲突预检范围**：组内命令/工具/slot/npm 包冲突，以及宿主已注册命令、已装 bundle/插件可在调用安装器之前阻断。**当前宿主已占用 slot 无法检测**：slot registry 是浏览器 `ctx.slots`（有 `snapshot()`），而市集安装预检运行在 server plugin_manager 上下文，宿主未向该上下文暴露它。成功/失败报告都会说明这一限制；不会把 pure-function 的手工注入测试说成运行时覆盖。两个组成员都声明 `/health` 时仍会在预检阶段阻断。
- **组卸载**：`/market uninstall <groupId>` 按 plugin id 查找唯一、已安装且可卸载的 `listBundles().name`，再严格按 `members` **逆序**把这个实际 dependency 名传给 `plugin_manager.removeBundle(name)`；不把 `github:owner/repo` 安装 spec 误传给宿主。无唯一匹配时整组安全停止，不做猜测性卸载。重复执行是幂等的（没有已安装成员直接返回成功，不调宿主）。模型工具 `market_uninstall` 与命令共用同一套 core 逻辑。
- **部分安装**：`--without` 后仅校验纳入的成员，报告显示已安装数/组成员总数、跳过成员和“部分安装”；全部排除时不调用安装器并返回失败，不会报成完整安装。
- **降级复制命令**：按本机平台生成 PowerShell（Windows）或 POSIX shell 命令，对 profile/spec 做 shell-safe 引用；不会把 PowerShell quoting 当 POSIX 命令，也不会输出未引用的值。
- **失败保护**：卸载前快照 profile 的 `package.json` / `pnpm-lock.yaml`；任一步失败就恢复原始清单，并给出逐成员重新 `dsh plugin --profile <p> add ...` 的恢复命令和 `dsh plugin --profile <p> list` 排查步骤。宿主没有 `removeBundle` 时降级为手动命令，绝不假装卸载成功。
- 卸载报告沿用与安装/F5 装后回路相同的 `application` 四态（`applied` / `restart-required` / `overridden` / `failed`），不改 F5 已定文案。真机验证请用独立 profile（`DSH_HOME` 指向隔离目录），不要碰现有环境。

流程与纪律：

1. **Seam 先探测**：按 `ctx.pluginManager` → `ctx.remotes.pluginManager` → `ctx.remote.pluginManager` → `ctx.services.pluginManager` 顺序核实 `installBundle/listPlugins/listBundles`。不可用就返回降级报告 + `dsh plugin --profile <p> add ...` / `dump-config` / `/market verify` 三步手动命令；绝不假装装成功。
2. **装前预检**：组内命令名（`entries` 中 `/` 开头）、工具名、slot、npm 包名撞车；与宿主已注册命令、已装 bundle/插件撞车；组成员在数据中缺失。当前宿主占用的 slot 明确标为无法检测（见上方原因）。每条可检测冲突自带可复制修复建议（`--without`、改名命令、移除旧层、同步 index.json）。阻断类冲突会在调用安装器之前停下。
3. **调用宿主**：`plugin_manager.installBundle(spec, { enabled: true })`，按 `members` 顺序逐个调用；任何异常收敛成可读失败步骤 + 下一步，handler 永不抛栈。
4. **四态校验**：`applied` 成功；`restart-required` 成功但明确提示"重启 web 后开新会话再 verify"；`overridden` 视为失败并提示更高优先级层；`failed/cancelled` 给出按错误码分类的修复建议（含 logPath）。装完再用 `listPlugins` 逐成员核对 `enabled` / `fiberPhase` 与命令可见性。
5. **模型工具**：`market_install` / `market_verify` 与命令同一套 core 逻辑，带 generic presentCall/presentResult 卡片。

测试：`test/conflicts.test.ts`（纯预检）、`test/installer.test.ts`（假 seam 状态机 + 干净 profile 归档链 + 冲突修复）、`test/install-wire.test.ts`（真实 apply 装配层，含降级与冲突路径）、`test/fuse.test.ts`（F3 融合）、`test/vote.test.ts`（F2 投票）、`test/doctor.test.ts`（F4 体检）、`test/live-loop.test.ts`（F5 装后回路），本轮复审补强后共 100 条（以当前 `npm test` 实测为准）。

## F3 — 融合（任务书先行，脚手架两步落盘）

入口（命令与模型工具共用 `src/core/fuse.ts` 同一套纯逻辑）：

```
/market fuse <id1,id2[,...]>           # 第一步：输出 # 融合任务书，不落盘
/market fuse <id1,id2[,...]> --apply   # 第二步：确认后写脚手架到配置目录
market_fuse { ids, apply }              # 模型工具，present 卡片沿用 install 风格
```

规则：

- 选 2–5 个插件；License 白名单仅 MIT / Apache-2.0，GPL / AGPL / 复合或未知许可一律拒绝（拒绝时零产物、零落盘）。
- 任务书含：能力矩阵、重叠字段（宿主 `requires`、`category`、`oneLiner` 数据域、同名入口冲突）、**复用不重写**清单、强制的**借鉴来源与差异**表（§8）。
- 脚手架是一份可被家族门禁验收的插件骨架（`package.json` / `src` / `lib` / `test` / `tsconfig` / `BORROWED.md` 等），落盘后需自行 `npm run check` + `node scripts/vendor/verify-plugin.mjs <产物目录>`。
- 实样证据：选 `dsh-plugin-quota` + `dsh-plugin-cost-ledger` 指出 6 个重叠字段（含 `data:cost`）与 6 条复用项；`f3-fuse-evidence.md` 为现场生成的任务书/重叠清单/来源表/门禁结果；由 `node scripts/make-fuse-evidence.mjs` 复现。
- 该真实融合事件（`fuse-quota-cost-ledger`）已同步到 `dsh-market-data/data/fusions.json`，供 F8 贡献分的「被融合」分项消费，不再用 fixture 占位。

## F2 — 插件侧投票

入口：`/market vote <plugin-id>` 与模型工具 `market_vote`（同一套 `src/core/vote.ts` 逻辑）。

- 写操作前先查 `gh auth status`。**未登录只读**：显示快照票数 + `gh auth login` 指引，不调用任何写 hook，绝不记本地假票。
- 已登录：定位 `Vote: <plugin-id>` 且带 `<!-- dsh-market-plugin-id: <id> -->` 稳定标记的 Discussion，写入真实的 👍 reaction。一人一票与账号龄 30 天门槛由数据仓 F2 快照判定，不在此处重复。
- 票数与 `generatedAt` 来自市集数据；投票后快照需等数据仓定时任务刷新，输出会明确说明该延迟。
- 身份探测、Discussion 定位与 reaction 写入均为 `RuntimeDeps` 注入缝，测试用假实现，不触碰真实 `~/.config/gh`。

## F4 — 本地插件体检

入口：`/market doctor <本地插件仓路径>` 与模型工具 `market_doctor`。

- 只读：复用 vendored 家族门禁输出，按 P0（发布阻断）/P1（应修）/P2（建议）分组，每条给出修改位置与建议代码。
- 额外断言 G0-6：家族门禁检查 `locale/` 布局，但家族插件发布链是 `src/locales` → `exports["./locales/*"]` → `lib/locales`；缺链时门禁静默通过，体检会点名 G0-6 并给出 `package.json#exports` 的编辑位置。

## M3 — conversation.view 卡片面板（既有实现）

- `src/client.tsx` — 纯 JS 工厂体（沿用 .tsx 扩展名但不含 JSX/TS 语法），由 `scripts/build.mjs` 包成 `lib/client.js`
- `test/client.test.mjs` — 面板验收测试；`preview.html` / `verify-m3.py` / `m3-report.json` 为验证产物
- 面板展示 5 张精选卡；第 6 组（生态雷达）在 M1 的 `/market` 全量列表中

## M5 — 可发布门禁

- `scripts/vendor/verify-plugin.mjs` — 家族官方门禁原样 vendor（来源与 SHA 见 `m5-gates.json#gateSource`），`npm run verify:plugin` 直接跑它；`scripts/verify-plugin.mjs` 保留为本地等价快速检查（`npm run verify:local`），逐条断言 G0-5/6/7/8/9/10。
- `src/locales/zh-CN.json` — 本地化资源，经 `package.json#exports["./locales/*"]` 声明并在构建时拷入 `lib/locales/`（G0-6）。
- `test/headless-smoke.test.mjs` — 第三层测试：直接加载构建产物 `lib/plugin.js`，在无 dsh 运行时/无网络/无缓存的全新 profile 上走真实 seam 探测 → 装「归档链」→ 四态校验 → 调用 3 个成员声明的全部 4 个入口；证据写 `m5-smoke-evidence.json`。
- `verify-m5.py` — 汇总验收：build → gates → typecheck → 当前 100 条测试 → 三层结构 → headless 实装实调一致性 → lib 入库，产出 `m5-report.json`；测试数由 `npm test` 输出解析，不再写死。

诚实声明：官方 vendored 门禁本地实跑（本仓等价门禁结果不是家族工具原始输出）；历史真实 dsh 运行回路见 `m2-live-evidence.json`（`evidenceType: live`），headless 证据为 `static`，门禁为 `static`，三者不混用。当前真机进展（attempt 4，2026-11-23；attempt 5 补 F5 装后回路）：M2 / M3 有历史真实 dsh 证据，但不是本轮修复 SHA 的新验证。F4 / F6 / 投票目前只有 fixture/fake 与构建证据，未重跑覆盖全部 F 变更的真机。

- M2：`/market`、`/market group`、`/market seams` 命令真实注册并执行；`/market install archive-chain` 后三名成员全部挂载、enabled、active，声明命令可见；`/market verify archive-chain` 报「验收通过」。证据 `m2-live-evidence.json`（`attempt: 4`）；测试 profile 把 `plugin-manager.githubConnectionTimeoutMs` 调到 30000、`idleTimeoutMs` 调到 1800000 以避开本机 GitHub 网络抖动。
- M3：`dsh-market-groups` 标签真实出现在 `conversation.view`，`[data-market-panel]` 节点数 1，5 张精选卡与「数据 2026-11-21 · 快照」标注正常渲染，零控制台错误。证据 `m3-live-evidence.json`；截图 `.screenshots/m3-live-market-panel.png`。
- 已修复的复制命令会按本机 PowerShell 或 POSIX shell 安全引用 profile/spec。历史 attempt 5 的宿主原始安装结果为 `failed`，同时清单显示成员 active；实现保留这两个事实，报告明确标注“宿主结果与清单不一致”，并建议修复宿主 package-manager 的 `Already up to date` / dependency diff 分类，不改写四态。当前 SHA 仍未真机重跑；`overridden` 的测试为 `built-artifact-code-path`，不是自然 live 分支。

## 安装 / 卸载 / 降级

安装（示例用独立 profile，避免污染现有环境）：

```bash
dsh plugin --profile market-audit add ./                       # 本地目录（开发）
dsh plugin --profile market-audit add github:121212165/dsh-plugin-market
dsh --profile market-audit --dump-config                       # 确认 id=market、enabled=true
```

卸载（参数是包名，不是插件 id）：

```bash
dsh plugin --profile market-audit remove dsh-plugin-market
```

降级：

- 依赖版本记录在 `profiles/<profile>/package.json` 与 `pnpm-lock.yaml`；先 `list` 确认当前版本。
- 回到旧版：`remove` 后用旧 tag/旧 spec 重新 `add`（如 `github:121212165/dsh-plugin-market#<tag>`），再重启 dsh。
- 市集自己的四层读兜底与内置快照保证断网也能浏览；降级不会动已装成员插件，成员仍需 `/market verify` 复核。

投稿：

- 走 `dsh-market-data` 的 Issue Form（`.github/ISSUE_TEMPLATE/plugin-submission.yml`），三个必填字段：`repo`、`license`、**借鉴来源表**；Action 校验后自动开 PR。
- 也可直接给数据仓提 PR：新插件加 `data/plugins/dsh-plugin-<id>.json`，新组合加 `data/groups/<id>.json`。**不改 `scripts/catalog.source.json`**：它是 `seed.mjs` 的种子输入，CI 不跑 seed，改它不会进 index。
- 门禁校验占位字段、`why`、`verify`、`UNKNOWN_MEMBER`、`DUPLICATE_ID`、`DUPLICATE_MEMBER` 等；插件本仓先过官方门禁 `node scripts/vendor/verify-plugin.mjs .`，再提数据 PR。

## 命令

```bash
npm run typecheck    # tsc --noEmit
npm test             # node:test：纯函数 + 装配层 + headless 冒烟（当前 100 条）
npm run build        # tsc → lib/ + 拷贝 snapshot.json/icon.svg/locales
npm run build:client # src/client.tsx → lib/client.js
npm run build:all    # 全部构建
npm run verify:plugin # 官方门禁（scripts/vendor/verify-plugin.mjs）
npm run verify:local  # G0-5/6/7/8/9/10 本地等价断言
npm run verify:m5     # 全部门禁 + 三层测试 + 实装实调 → m5-report.json
npm run check        # typecheck + test + build:all + verify:plugin
```
