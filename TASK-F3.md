# TASK F3 — 融合（fuse：能力矩阵 / 重叠冲突 / 来源表）

> 仓库：`dsh-plugin-market`（有远程）  
> 分支：`task/f3-fuse`（worktree `wt-f3-fuse`）  
> 基线：`main @ 20181d7`  
> 计划：`../../DSH-MARKET-PLAN.md` §7 F3、§8 License 污染风险  
> 依赖：**F6 先合并**（计划顺序），F1 的 verify-plugin 门禁需可用（基线已 vendor）  
> 可并行：F4（同为插件仓新命令，互不改同一文件）

## 目标
`/market fuse a,b,c`：选 2–5 个插件，只收 MIT/Apache-2.0；产出能力矩阵、重叠冲突、借鉴来源表；先出任务书再落盘，产物过 verify-plugin。

## 交付物
- `src/core/fuse.ts`（新）：license 白名单校验、能力矩阵、重叠字段检测、"复用不重写"清单、来源表
- `/market fuse <ids>` 命令 + `market_fuse` 模型工具（同一套 core 逻辑，present 卡片）
- 任务书先行：落盘前输出 `# 融合任务书`，再写脚手架
- `test/fuse.test.ts`：quota + cost-ledger 重叠用例、GPL 插件被拒、2/5 边界
- 产物样本过 `node scripts/vendor/verify-plugin.mjs .`

## 验收证据（计划原文）
- 选 quota + cost-ledger 能指出重叠字段并给出"复用不重写"清单
- 产物通过 verify-plugin

## 实施建议
1. 融合池只放 MIT/Apache-2.0；GPL 片段一律拒绝，产物强制带"借鉴来源与差异"表（§8）。
2. 融合任务书与脚手架分两步调用，任务书不落盘。
3. 复用 `market_install` 的 present 卡片模式，保持 UI 一致。

## 边界
- 不做投稿/投票（F1/F2）、体检（F4）、装后回路（F5）、回滚（F6）

## 完成判定
`npm run check` 全绿；重叠清单与来源表实样；产物过官方门禁；提交信息 `feat(f3): fuse task book and scaffolding`。
