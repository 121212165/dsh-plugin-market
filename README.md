# dsh-plugin-market

dsh 插件市集插件。已实现 **M1（只读市场）+ M2（一键安装闭环）+ M3（conversation.view 卡片面板）+ M5（可发布门禁）**，四者共用 `src/snapshot.json` 数据契约。M4 的数据站/门禁在 `../dsh-market-data/`。

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
- 投票/投稿/融合属于 F1–F3，尚未开放。

源码：
- `src/core/` — 纯函数：types / reader（兜底链）/ render（含快照时间、空数据安全）/ parse / install-types（四态与报告）/ conflicts（冲突预检）/ seam（宿主能力探测与降级）/ installer（安装状态机与生效校验）
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
/market seams                                 # 查看 plugin_manager seam 与降级说明
```

F6 组安装冲突矩阵 / 组卸载回滚：

- **三类冲突提前告警**：命令名（`entries` 中 `/` 开头）、slot（`slots` 或 `slot:<name>` / 已知 slot）、npm 包名（`npm`）两两撞车，或与宿主已注册命令/slot、已装 bundle/插件撞车，都在调用安装器之前阻断并给出可复制修复建议。两个成员都声明 `/health` 时同样在预检阶段阻断，而不是等宿主启动时报 `command already registered`。
- **组卸载**：`/market uninstall <groupId>` 只移除当前确实已安装的成员，严格按 `members` **逆序**调用 `plugin_manager.removeBundle(spec)`，把清单恢复到安装前状态。重复执行是幂等的（没有已安装成员直接返回成功，不调宿主）。模型工具 `market_uninstall` 与命令共用同一套 core 逻辑。
- **失败保护**：卸载前快照 profile 的 `package.json` / `pnpm-lock.yaml`；任一步失败就恢复原始清单，并给出逐成员重新 `dsh plugin --profile <p> add ...` 的恢复命令和 `dsh plugin --profile <p> list` 排查步骤。宿主没有 `removeBundle` 时降级为手动命令，绝不假装卸载成功。
- 卸载报告沿用与安装/F5 装后回路相同的 `application` 四态（`applied` / `restart-required` / `overridden` / `failed`），不改 F5 已定文案。真机验证请用独立 profile（`DSH_HOME` 指向隔离目录），不要碰现有环境。

流程与纪律：

1. **Seam 先探测**：按 `ctx.pluginManager` → `ctx.remotes.pluginManager` → `ctx.remote.pluginManager` → `ctx.services.pluginManager` 顺序核实 `installBundle/listPlugins/listBundles`。不可用就返回降级报告 + `dsh plugin --profile <p> add ...` / `dump-config` / `/market verify` 三步手动命令；绝不假装装成功。
2. **装前预检**：组内命令名（`entries` 中 `/` 开头）、工具名、slot、npm 包名撞车；与宿主已注册命令、已装 bundle/插件撞车；组成员在数据中缺失。每条冲突自带可复制的修复建议（`--without`、改名命令、移除旧层、同步 index.json）。阻断类冲突会在调用安装器之前停下。
3. **调用宿主**：`plugin_manager.installBundle(spec, { enabled: true })`，按 `members` 顺序逐个调用；任何异常收敛成可读失败步骤 + 下一步，handler 永不抛栈。
4. **四态校验**：`applied` 成功；`restart-required` 成功但明确提示"重启 web 后开新会话再 verify"；`overridden` 视为失败并提示更高优先级层；`failed/cancelled` 给出按错误码分类的修复建议（含 logPath）。装完再用 `listPlugins` 逐成员核对 `enabled` / `fiberPhase` 与命令可见性。
5. **模型工具**：`market_install` / `market_verify` 与命令同一套 core 逻辑，带 generic presentCall/presentResult 卡片。

测试：`test/conflicts.test.ts`（纯预检）、`test/installer.test.ts`（假 seam 状态机 + 干净 profile 归档链 + 冲突修复）、`test/install-wire.test.ts`（真实 apply 装配层，含降级与冲突路径），共 61 条全绿（`npm run check`）。

## M3 — conversation.view 卡片面板（既有实现）

- `src/client.tsx` — 纯 JS 工厂体（沿用 .tsx 扩展名但不含 JSX/TS 语法），由 `scripts/build.mjs` 包成 `lib/client.js`
- `test/client.test.mjs` — 面板验收测试；`preview.html` / `verify-m3.py` / `m3-report.json` 为验证产物
- 面板展示 5 张精选卡；第 6 组（生态雷达）在 M1 的 `/market` 全量列表中

## M5 — 可发布门禁

- `scripts/vendor/verify-plugin.mjs` — 家族官方门禁原样 vendor（来源与 SHA 见 `m5-gates.json#gateSource`），`npm run verify:plugin` 直接跑它；`scripts/verify-plugin.mjs` 保留为本地等价快速检查（`npm run verify:local`），逐条断言 G0-5/6/7/8/9/10。
- `src/locales/zh-CN.json` — 本地化资源，经 `package.json#exports["./locales/*"]` 声明并在构建时拷入 `lib/locales/`（G0-6）。
- `test/headless-smoke.test.mjs` — 第三层测试：直接加载构建产物 `lib/plugin.js`，在无 dsh 运行时/无网络/无缓存的全新 profile 上走真实 seam 探测 → 装「归档链」→ 四态校验 → 调用 3 个成员声明的全部 4 个入口；证据写 `m5-smoke-evidence.json`。
- `verify-m5.py` — 汇总验收：build → gates → typecheck → 61 条测试 → 三层结构 → 实装实调一致性 → lib 入库，产出 `m5-report.json`。

诚实声明：官方门禁已 vendor 并按 SHA 实跑（0 FAIL / 0 WARN）；真实 dsh 运行时的安装回路证据见 `m2-live-evidence.json`（`evidenceType: live`），headless 证据为 `mock`，门禁为 `static`，三者不混用。当前真机进展（attempt 4，2026-11-23）：**M2 / M3 均已在真实 dsh 0.2.0-rc.2 web 上验证通过**。

- M2：`/market`、`/market group`、`/market seams` 命令真实注册并执行；`/market install archive-chain` 后三名成员全部挂载、enabled、active，声明命令可见；`/market verify archive-chain` 报「验收通过」。证据 `m2-live-evidence.json`（`attempt: 4`）；测试 profile 把 `plugin-manager.githubConnectionTimeoutMs` 调到 30000、`idleTimeoutMs` 调到 1800000 以避开本机 GitHub 网络抖动。
- M3：`dsh-market-groups` 标签真实出现在 `conversation.view`，`[data-market-panel]` 节点数 1，5 张精选卡与「数据 2026-11-21 · 快照」标注正常渲染，零控制台错误。证据 `m3-live-evidence.json`；截图 `.screenshots/m3-live-market-panel.png`。
- 真机发现并修复的缺陷：client 面板原先直接读 `ctx.market`，cordis 抛 `cannot get property "market" without inject`，导致第一次点标签时面板崩溃；已改为 `reflect.get('market')` + try/catch 并重建 `lib/client.js`（61 条测试全绿）。另有一项宿主侧真实缺陷：重已装成员时 pnpm 的 `Already up to date` 被判定为 `ambiguous-install`，但四态实际为 `applied`，不影响验收结论，留待宿主修复。

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

- 插件数据在 `dsh-market-data` 的 `scripts/catalog.source.json`（`plugins` / `groups`），改完提 PR；门禁会校验占位字段、`why`、`verify`、`UNKNOWN_MEMBER`、`DUPLICATE_ID`。
- 插件本仓先过官方门禁 `node scripts/vendor/verify-plugin.mjs .`，再提数据 PR；组条目要写清 `why` 与可执行的 `verify`。

## 命令

```bash
npm run typecheck    # tsc --noEmit
npm test             # node:test：纯函数 + 装配层 + headless 冒烟（61 条）
npm run build        # tsc → lib/ + 拷贝 snapshot.json/icon.svg/locales
npm run build:client # src/client.tsx → lib/client.js
npm run build:all    # 全部构建
npm run verify:plugin # 官方门禁（scripts/vendor/verify-plugin.mjs）
npm run verify:local  # G0-5/6/7/8/9/10 本地等价断言
npm run verify:m5     # 全部门禁 + 三层测试 + 实装实调 → m5-report.json
npm run check        # typecheck + test + build:all + verify:plugin
```
