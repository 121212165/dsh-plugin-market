# TASK F5 — 装后真回路（dump-config + 入口调用 + 四态）

> 仓库：`dsh-plugin-market`（有远程）  
> 分支：`task/f5-live-loop`（worktree `wt-f5-live-loop`）  
> 基线：`main @ 20181d7`（已含真机 attempt 4 与 client inject 修复）  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F5  
> 依赖：M2 / M5 已完成（基线满足）；**必须早于 F6**  
> 可并行：F1、F2（不同仓库）

## 目标
安装完自动 `dump-config` + 调一次成员入口 + 报告 `application` 四态；`overridden` 必须明确提示"被更高优先级层覆盖"，不能笼统报失败。

## 交付物
- `src/core/installer.ts` / `src/core/seam.ts`：安装后自动触发一次生效回路（dump-config → 入口探测 → 四态报告）
- 四态文案：`applied` / `restart-required` / `overridden` / `failed(cancelled)` 各自带下一步
- `overridden` 专门文案："被更高优先级层覆盖"
- `test/install-wire.test.ts` 或新测试：四态各一条 + overridden 文案断言
- 真机证据更新：`m2-live-evidence.json` 增 `attempt: 5`，含 `application` 四态原始输出

## 验收证据（计划原文）
`overridden` 能明确提示"被更高优先级层覆盖"而不是笼统失败

## 实施建议
1. 复用现有 `runVerify` / `verifyGroup`，不要重写四态语义。
2. 真机复验沿用 attempt 4 的 profile 方案（独立 profile + `githubConnectionTimeoutMs=30000`）。
3. 已知宿主缺陷：重已装成员时 `Already up to date` 被判 `ambiguous-install`，四态实为 `applied`；本分支不要试图在插件侧掩盖，如实展示。

## 边界
- 不做组卸载/回滚（F6）
- 不改投稿/投票/融合

## 完成判定
`npm run check` 全绿；四态测试通过；真机 `overridden` 用例有原始输出；提交信息 `feat(f5): post-install live loop and four-state report`。
