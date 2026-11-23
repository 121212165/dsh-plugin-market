# F3 融合实样证据（quota + cost-ledger）

数据时间：2026-11-21T12:09:28.869Z；数据层：内置 snapshot。全部内容由 `node scripts/make-fuse-evidence.mjs` 现场生成。

## 1. 融合任务书（原文，落盘前输出）

# 融合任务书

> 本任务书只在会话中输出，**不落盘**。确认后运行 `/market fuse <ids> --apply` 才写脚手架。

选中插件：dsh-plugin-quota, dsh-plugin-cost-ledger（2 个）
License 白名单：MIT / Apache-2.0；GPL 等传染性许可一律拒绝。

## 1. 选中的插件

| id | 名称 | 许可 | 入口 |
| --- | --- | --- | --- |
| dsh-plugin-quota | 用量仪表 | MIT | /qm, /qm-top, quota_meter |
| dsh-plugin-cost-ledger | 成本台账 | MIT | /ledger |

## 2. 能力矩阵

| 能力 | 来源字段 | 用量仪表 | 成本台账 |
| --- | --- | --- | --- |
| /qm | entries 入口声明 | ✓ | — |
| /qm-top | entries 入口声明 | ✓ | — |
| quota_meter | entries 入口声明 | ✓ | — |
| 宿主 tools | requires 宿主依赖 | ✓ | ✓ |
| 宿主 systemPrompt | requires 宿主依赖 | ✓ | ✓ |
| 宿主 sessionProjections | requires 宿主依赖 | ✓ | ✓ |
| 钱与用量 | category 分类 | ✓ | ✓ |
| token 计量 | oneLiner 能力描述 | ✓ | — |
| 花费/成本 | oneLiner 能力描述 | ✓ | ✓ |
| 用量/额度 | oneLiner 能力描述 | ✓ | — |
| 预算刹车 | oneLiner 能力描述 | ✓ | — |
| 预测/趋势 | oneLiner 能力描述 | ✓ | ✓ |
| 实时仪表 | oneLiner 能力描述 | ✓ | — |
| /ledger | entries 入口声明 | — | ✓ |
| 持久化/导出 | oneLiner 能力描述 | — | ✓ |

## 3. 重叠冲突

- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 tools」（requires 宿主依赖）；融合产物只实现一次「宿主 tools」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 systemPrompt」（requires 宿主依赖）；融合产物只实现一次「宿主 systemPrompt」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 sessionProjections」（requires 宿主依赖）；融合产物只实现一次「宿主 sessionProjections」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「钱与用量」（category 分类）；融合产物只实现一次「钱与用量」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「花费/成本」（oneLiner 能力描述）；融合产物只实现一次「花费/成本」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「预测/趋势」（oneLiner 能力描述）；融合产物只实现一次「预测/趋势」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写

## 4. 复用不重写清单

- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 tools（req:tools）— 融合产物只实现一次「宿主 tools」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 systemPrompt（req:systemPrompt）— 融合产物只实现一次「宿主 systemPrompt」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 sessionProjections（req:sessionProjections）— 融合产物只实现一次「宿主 sessionProjections」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：钱与用量（cat:钱与用量）— 融合产物只实现一次「钱与用量」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：花费/成本（data:cost）— 融合产物只实现一次「花费/成本」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：预测/趋势（data:forecast）— 融合产物只实现一次「预测/趋势」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写

## 5. 借鉴来源与差异（§8 强制，不得省略）

| 来源插件 | 仓库 | 许可 | 上游借鉴 | 差异 / 不重写项 | 署名方式 |
| --- | --- | --- | --- | --- | --- |
| 用量仪表 | 121212165/dsh-plugin-quota | MIT | 无 | 作为「宿主 tools、宿主 systemPrompt、宿主 sessionProjections、钱与用量、花费/成本、预测/趋势」的复用基准实现 | 保留 MIT LICENSE，在 BORROWED.md 引用 121212165/dsh-plugin-quota@2026-11-21 |
| 成本台账 | 121212165/dsh-plugin-cost-ledger | MIT | 无 | 作为「成本台账」的复用基准实现；不重写「宿主 tools」，改为复用 dsh-plugin-quota；不重写「宿主 systemPrompt」，改为复用 dsh-plugin-quota；不重写「宿主 sessionProjections」，改为复用 dsh-plugin-quota；不重写「钱与用量」，改为复用 dsh-plugin-quota；不重写「花费/成本」，改为复用 dsh-plugin-quota；不重写「预测/趋势」，改为复用 dsh-plugin-quota | 保留 MIT LICENSE，在 BORROWED.md 引用 121212165/dsh-plugin-cost-ledger@2026-11-21 |

## 6. 脚手架落盘清单（仅 --apply 时写入）

- package.json / tsconfig.json / tsconfig.build.json / cordis.patch.yml
- src/index.ts / lib/index.js / lib/types/index.d.ts / test/smoke.test.mjs
- README.md / BORROWED.md（借鉴来源与差异）/ LICENSE / fuse-plan.json

## 7. License 合规声明

融合池仅含 MIT / Apache-2.0 插件；任何 GPL / AGPL / 未知许可片段都拒绝进入产物。
落盘后先 `npm run build && npm run check`，再用 `node scripts/vendor/verify-plugin.mjs <产物目录>` 过官方门禁。

## 2. 重叠字段清单

- [重叠] `req:tools` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 tools」（requires 宿主依赖）
  - 复用：融合产物只实现一次「宿主 tools」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] `req:systemPrompt` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 systemPrompt」（requires 宿主依赖）
  - 复用：融合产物只实现一次「宿主 systemPrompt」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] `req:sessionProjections` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「宿主 sessionProjections」（requires 宿主依赖）
  - 复用：融合产物只实现一次「宿主 sessionProjections」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] `cat:钱与用量` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「钱与用量」（category 分类）
  - 复用：融合产物只实现一次「钱与用量」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] `data:cost` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「花费/成本」（oneLiner 能力描述）
  - 复用：融合产物只实现一次「花费/成本」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- [重叠] `data:forecast` dsh-plugin-quota 与 dsh-plugin-cost-ledger 都用到「预测/趋势」（oneLiner 能力描述）
  - 复用：融合产物只实现一次「预测/趋势」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写

## 3. 复用不重写清单

- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 tools（`req:tools`）— 融合产物只实现一次「宿主 tools」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 systemPrompt（`req:systemPrompt`）— 融合产物只实现一次「宿主 systemPrompt」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：宿主 sessionProjections（`req:sessionProjections`）— 融合产物只实现一次「宿主 sessionProjections」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：钱与用量（`cat:钱与用量`）— 融合产物只实现一次「钱与用量」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：花费/成本（`data:cost`）— 融合产物只实现一次「花费/成本」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写
- dsh-plugin-quota → dsh-plugin-cost-ledger：预测/趋势（`data:forecast`）— 融合产物只实现一次「预测/趋势」，复用 dsh-plugin-quota 的实现与数据契约，dsh-plugin-cost-ledger 直接接入，不重写

## 4. 借鉴来源与差异表（§8 强制）

- 用量仪表（dsh-plugin-quota）· 121212165/dsh-plugin-quota · MIT · 上游借鉴：无
  - 差异：作为「宿主 tools、宿主 systemPrompt、宿主 sessionProjections、钱与用量、花费/成本、预测/趋势」的复用基准实现
  - 署名：保留 MIT LICENSE，在 BORROWED.md 引用 121212165/dsh-plugin-quota@2026-11-21
- 成本台账（dsh-plugin-cost-ledger）· 121212165/dsh-plugin-cost-ledger · MIT · 上游借鉴：无
  - 差异：作为「成本台账」的复用基准实现；不重写「宿主 tools」，改为复用 dsh-plugin-quota；不重写「宿主 systemPrompt」，改为复用 dsh-plugin-quota；不重写「宿主 sessionProjections」，改为复用 dsh-plugin-quota；不重写「钱与用量」，改为复用 dsh-plugin-quota；不重写「花费/成本」，改为复用 dsh-plugin-quota；不重写「预测/趋势」，改为复用 dsh-plugin-quota
  - 署名：保留 MIT LICENSE，在 BORROWED.md 引用 121212165/dsh-plugin-cost-ledger@2026-11-21

## 5. 官方门禁结果

产物脚手架写入临时目录，`git init` + commit 后执行 `node scripts/vendor/verify-plugin.mjs <产物目录>`：

```text
OK: all plugin specs pass

结果: 1 插件 / 0 FAIL / 0 WARN
```
