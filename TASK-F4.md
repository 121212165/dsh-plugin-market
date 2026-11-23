# TASK F4 — 我的插件体检（doctor）

> 仓库：`dsh-plugin-market`（有远程）  
> 分支：`task/f4-doctor`（worktree `wt-f4-doctor`）  
> 基线：`main @ 20181d7`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F4  
> 依赖：**F6 先合并**（计划顺序）；verify-plugin 基线已 vendor  
> 可并行：F3（同为插件仓新命令，互不改同一文件）

## 目标
输入本地仓路径，跑 verify-plugin + 家族质量门，按 P0/P1/P2 出可执行清单。

## 交付物
- `src/core/doctor.ts`（新）：读取目标仓 `package.json`/`lib`/`exports`/license，逐条映射门禁错误码到 P0/P1/P2
- `/market doctor <path>` 命令 + `market_doctor` 模型工具
- 每条问题带"修改位置 + 建议代码"（如 G0-6 → `package.json#exports["./locales/*"]` + 构建拷贝到 `lib/locales/`）
- `test/doctor.test.ts`：故意缺 locale 的 fixture、正常 fixture 两类

## 验收证据（计划原文）
对一个故意缺 locale 的插件能点名 G0-6，并给出 exports 修改位置

## 实施建议
1. 复用 `scripts/vendor/verify-plugin.mjs` 的判定语义（可 `spawn` 调用并解析输出），不要另写一套门禁。
2. P0=发布阻断，P1=应修，P2=建议；每条必须可执行，禁止"建议改进"式空话。
3. 与 F3 共用 present 卡片模式，但不要改 F3 的文件。

## 边界
- 不做融合（F3）、投稿/投票（F1/F2）、装后回路（F5）、回滚（F6）

## 完成判定
`npm run check` 全绿；缺 locale fixture 命中 G0-6 且给出 exports 位置；提交信息 `feat(f4): local plugin doctor with P0/P1/P2 report`。
