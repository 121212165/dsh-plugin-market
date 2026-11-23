# TASK F6 — 组安装冲突矩阵 / 组卸载回滚

> 仓库：`dsh-plugin-market`（有远程）  
> 分支：`task/f6-rollback`（worktree `wt-f6-rollback`）  
> 基线：`main @ 20181d7`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F6  
> 依赖：**F5 先合并**；开工前 `git rebase origin/main`（确保含 F5 的装后回路）  
> 合并顺序：F5 → F6 → F3/F4

## 目标
安装前算冲突矩阵（命令名 / slot / 包名），支持组卸载/回滚；冲突提前告警而不是启动时炸。

## 交付物
- `src/core/conflicts.ts`：扩展冲突矩阵，覆盖命令名、slot、npm 包名三类；两个成员都声明 `/health` 时必须提前告警
- `/market uninstall <groupId>`（或等价命令）+ 回滚到安装前清单（按 members 逆序）
- `test/conflicts.test.ts` + `test/install-wire.test.ts`：同 `/health` 冲突用例、卸载回滚用例
- README 补命令说明

## 验收证据（计划原文）
两个都用 `/health` 的插件同装时提前告警，而不是启动炸

## 实施建议
1. 卸载/回滚必须幂等；失败时保留原始 `package.json` / `pnpm-lock.yaml`，给出可复制的恢复命令。
2. 与 F5 的装后回路共用 `application` 四态，但不要改 F5 已定的文案。
3. 真机用独立 profile，不碰现有环境（沿用 TASK.md 纪律）。

## 边界
- 不做融合（F3）、体检（F4）
- 不改投稿/投票/治理/贡献分

## 完成判定
`npm run check` 全绿；同 `/health` 冲突被阻断且给修复建议；卸载后清单恢复原状；提交信息 `feat(f6): group install conflicts and rollback`。
