/** F6 — group uninstall / rollback. Removes the installed members of a group
 * in reverse `members` order, skipping anything not present so a second run is
 * a no-op. A failed removal restores the pre-uninstall manifest and returns
 * copy-pasteable recovery commands. Never throws; every path is a report. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { specFor } from './conflicts.ts';
import { manualInstallCommands, quoteShellArgument } from './seam.ts';
import type {
  ApplicationState,
  InstallSeam,
  InstalledBundle,
  InstalledRow,
  ManifestFiles,
  ManifestStore,
  UninstallReport,
  UninstallStepResult,
} from './install-types.ts';
import type { MarketIndex, PluginEntry } from './types.ts';

export interface UninstallInput {
  groupId: string;
  index: MarketIndex;
  seam: InstallSeam | null;
  profile?: string;
  now?: (() => number) | undefined;
  /** Manifest snapshot/restore hook. Omit → host manifest is left untouched. */
  manifest?: ManifestStore | undefined;
  onProgress?: (line: string) => void;
}

const stamp = (now?: () => number): string => new Date((now ?? Date.now)()).toISOString();
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const safeDiagnosticText = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);

/** Production manifest IO. `DSH_HOME` lets real-device runs point at an
 * isolated profile; every read is best-effort, writes only restore a snapshot. */
export function createProfileManifestStore(profile: string): ManifestStore {
  const home = process.env.DSH_HOME || homedir();
  const directory = join(home, '.dsh', 'profiles', profile || 'web');
  const paths: Record<keyof ManifestFiles, string> = {
    packageJson: join(directory, 'package.json'),
    pnpmLock: join(directory, 'pnpm-lock.yaml'),
  };
  return {
    async read(): Promise<ManifestFiles> {
      const files: ManifestFiles = { packageJson: null, pnpmLock: null };
      for (const key of ['packageJson', 'pnpmLock'] as const) {
        try {
          files[key] = await readFile(paths[key], 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          // Record confirmed absence so rollback can remove a file created by a failed host operation.
          files[key] = null;
        }
      }
      return files;
    },
    async write(files: ManifestFiles): Promise<void> {
      for (const key of ['packageJson', 'pnpmLock'] as const) {
        if (!Object.hasOwn(files, key)) throw new Error(`manifest snapshot is incomplete: ${key} missing`);
        const text = files[key];
        if (text === null) {
          await rm(paths[key], { force: true });
          continue;
        }
        if (text === undefined) throw new Error(`manifest snapshot is incomplete: ${key} undefined`);
        await mkdir(dirname(paths[key]), { recursive: true });
        await writeFile(paths[key], text, 'utf8');
      }
    },
  };
}

function pluginOf(index: MarketIndex, id: string): PluginEntry | undefined {
  return index.plugins.find((plugin) => plugin.id === id);
}

function memberKeys(plugin: PluginEntry | undefined, id: string): string[] {
  return [id, plugin?.npm ?? '', plugin?.repo ?? '', plugin?.repo.split('/').pop() ?? '']
    .filter(Boolean).map((value) => value.toLowerCase());
}

/** A member is removable only when the host inventory actually shows it.
 * This is the idempotency gate: nothing installed → nothing to remove. */
function isInstalled(id: string, plugin: PluginEntry | undefined, rows: InstalledRow[], bundles: InstalledBundle[]): boolean {
  const keys = new Set(memberKeys(plugin, id));
  // `entryId` is added by newer hosts; read it defensively so this module
  // works both before and after F5 without importing F5-only types.
  const rowHit = rows.some((row) => [row.id, (row as InstalledRow & { entryId?: string }).entryId ?? '', row.moduleName ?? '', ...String(row.id).split(':')]
    .filter(Boolean).some((value) => keys.has(String(value).toLowerCase())));
  if (rowHit) return true;
  return bundles.some((bundle) => keys.has(bundle.name.toLowerCase()) && bundle.installed !== false);
}

function manualUninstallCommands(bundleName: string, profile: string, groupId: string): string[] {
  const targetProfile = quoteShellArgument(profile || 'web');
  const targetName = quoteShellArgument(bundleName);
  const lookup = process.platform === 'win32'
    ? `Select-String -SimpleMatch -Pattern ${targetName}`
    : `grep -F -- ${targetName}`;
  return [
    `dsh plugin --profile ${targetProfile} remove ${targetName}`,
    `dsh --profile ${targetProfile} --dump-config | ${lookup}`,
    `/market verify ${groupId}`,
  ];
}

/** Shared four-state wording source: the same `application` values install/F5
 * use, with `APPLICATION_LABEL` semantics. F6 never rewrites F5's guidance. */
function applicationDetail(application: ApplicationState | undefined, member: string): string {
  switch (application) {
    case 'applied':
      return `${member} 已移除并生效`;
    case 'restart-required':
      return `${member} 已从 profile 移除，需重启 dsh web 后生效`;
    case 'overridden':
      return `${member} 被更高优先级层覆盖，移除可能未真正生效`;
    case 'cancelled':
      return `${member} 移除已取消`;
    case 'failed':
    default:
      return `${member} 移除失败`;
  }
}

function nextStepsForFailure(bundleName: string, profile: string, groupId: string, diagnostic?: string): string[] {
  const safeDiagnostic = diagnostic ? safeDiagnosticText(diagnostic) : '';
  return [
    `确认 profile 状态：dsh plugin --profile ${quoteShellArgument(profile)} list`,
    ...(safeDiagnostic ? [`宿主诊断（仅供参考，非命令）：${safeDiagnostic}`] : []),
    ...manualUninstallCommands(bundleName, profile, groupId),
    `/market seams 核实宿主 removeBundle 签名（F6 组卸载依赖该方法）`,
  ];
}

/** Roll a group back to its pre-install manifest, members in reverse order. */
export async function uninstallGroup(input: UninstallInput): Promise<UninstallReport> {
  const startedAt = stamp(input.now);
  const profile = input.profile || 'web';
  const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
  const empty = (
    summary: string,
    mode: 'live' | 'degraded' = input.seam ? 'live' : 'degraded',
  ): UninstallReport => ({
    groupId: input.groupId, mode, startedAt, finishedAt: stamp(input.now),
    ok: false, idempotent: false, manifestRestored: false,
    summary, steps: [], recovery: [], nextSteps: [],
  });

  if (!group) return empty(`找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组`);
  if (!input.seam || typeof input.seam.removeBundle !== 'function' || typeof input.seam.listBundles !== 'function') {
    return {
      ...empty(
        `plugin_manager 的 removeBundle 或 listBundles 清单能力不可用（${input.seam?.source || 'seam 不可用'}），无法安全确认可卸载 bundle，未执行任何卸载。请复制下面的命令手动移除成员，再用 /market verify 校验。`,
        'degraded',
      ),
      recovery: [...group.members].reverse().flatMap((id) => {
        const plugin = pluginOf(input.index, id);
        return manualUninstallCommands(plugin?.npm ?? specFor(plugin), profile, group.id);
      }),
      nextSteps: ['/market seams 查看宿主安装能力；若刚启用 plugin_manager，重启或重跑本命令'],
    };
  }

  let rows: InstalledRow[] = [];
  let bundles: InstalledBundle[] = [];
  try {
    rows = (await input.seam.listPlugins?.()) ?? [];
    bundles = (await input.seam.listBundles?.()) ?? [];
  } catch (error) {
    return empty(`读取宿主安装清单失败：${messageOf(error)}；为避免误删已停止`);
  }

  // Snapshot before touching anything. If the store is present but cannot give
  // a complete snapshot, fail closed rather than uninstall without rollback.
  let snapshot: ManifestFiles | undefined;
  try {
    snapshot = await input.manifest?.read();
  } catch {
    snapshot = undefined;
  }
  if (input.manifest && (!snapshot
    || !Object.hasOwn(snapshot, 'packageJson')
    || !Object.hasOwn(snapshot, 'pnpmLock')
    || snapshot.packageJson === undefined
    || snapshot.pnpmLock === undefined)) {
    return empty(`无法完整读取 profile manifest 快照；为保证失败可恢复，未调用任何 removeBundle`);
  }

  // Reverse `members` order — a group install went forward, rollback goes back.
  const reverseMembers = [...group.members].reverse();
  const installedMembers = reverseMembers
    .map((id) => ({ member: id, plugin: pluginOf(input.index, id) }))
    .filter(({ member, plugin }) => isInstalled(member, plugin, rows, bundles));

  const targets = installedMembers.map(({ member, plugin }) => {
    // GitHub installs use the package's actual manifest name; this can differ
    // from catalog.npm (for example a scoped published name vs repo basename).
    // Match only exact, catalog-derived aliases and still require one bundle.
    const aliases = new Set(memberKeys(plugin, member));
    const matches = plugin
      ? bundles.filter((bundle) => aliases.has(bundle.name.toLowerCase()))
      : [];
    const bundle = matches.length === 1 ? matches[0] : undefined;
    const problem = !plugin
      ? `市集成员 ${member} 不存在，无法映射到宿主 bundle`
      : matches.length !== 1
        ? `${member} 按 id/npm/repo 名（${[...aliases].join(', ')}）匹配到 ${matches.length} 个宿主 bundle（必须唯一）`
        : bundle?.installed !== true
          ? `宿主 bundle ${bundle?.name} 未确认安装在当前 profile`
          : bundle?.removable !== true
            ? `宿主 bundle ${bundle?.name} 标记为不可卸载${bundle?.error?.code ? `（${bundle.error.code}）` : ''}`
            : '';
    return { member, spec: specFor(plugin), bundleName: bundle?.name, problem };
  });

  const unresolved = targets.filter((target) => target.problem);
  if (unresolved.length) {
    const steps: UninstallStepResult[] = unresolved.map((target) => ({
      member: target.member,
      spec: target.spec,
      status: 'failed',
      application: 'failed',
      detail: `安全停止：${target.problem}；未调用宿主 removeBundle`,
      nextSteps: [
        `检查 dsh plugin --profile ${quoteShellArgument(profile)} list，并核对市集 npm 与 listBundles().name 是否唯一对应`,
        `/market seams 核实当前宿主 plugin_manager 与 removeBundle 能力`,
      ],
    }));
    return {
      ...empty(`组 ${group.id} 有 ${unresolved.length} 个成员无法唯一映射到可卸载 bundle；为避免猜测性卸载，未执行任何 removeBundle`),
      steps,
      nextSteps: [...new Set(steps.flatMap((step) => step.nextSteps))],
    };
  }

  if (!targets.length) {
    return {
      ...empty(`组 ${group.id} 没有已安装成员，无需卸载（幂等）`),
      ok: true,
      idempotent: true,
      nextSteps: [`/market verify ${group.id} 复核清单已恢复原状`],
    };
  }

  const steps: UninstallStepResult[] = [];
  for (const { member, spec, bundleName } of targets) {
    input.onProgress?.(`卸载 ${member} ← ${bundleName}`);
    try {
      const result = await input.seam.removeBundle(bundleName!);
      const application = result.application ?? 'failed';
      const failed = application === 'failed' || application === 'cancelled' || application === 'overridden';
      const rawDiagnostic = result.error?.diagnostic || result.packageResult?.output?.trim().split('\n').slice(-1)[0];
      const diagnostic = rawDiagnostic ? safeDiagnosticText(rawDiagnostic) : undefined;
      steps.push({
        member, spec, status: failed ? 'failed' : 'removed', application,
        detail: failed
          ? `${applicationDetail(application, member)}（stage=${result.stage}, target=${result.target}）${diagnostic ? `：${diagnostic.slice(0, 160)}` : ''}`
          : `${applicationDetail(application, member)}（stage=${result.stage}, target=${result.target}）`,
        nextSteps: failed ? nextStepsForFailure(bundleName!, profile, group.id, diagnostic) : [],
      });
    } catch (error) {
      steps.push({
        member, spec, status: 'failed', application: 'failed',
        detail: `调用 plugin_manager.removeBundle(${bundleName}) 失败：${messageOf(error)}`,
        nextSteps: nextStepsForFailure(bundleName!, profile, group.id, messageOf(error)),
      });
    }
  }

  const removed = steps.filter((step) => step.status === 'removed');
  const failed = steps.filter((step) => step.status === 'failed');
  let manifestRestored = false;
  if (failed.length && snapshot && input.manifest) {
    try {
      await input.manifest.write(snapshot);
      manifestRestored = true;
    } catch {
      // report the manual restore command below instead of throwing
    }
  }

  const recovery = failed.length
    ? [
        ...new Set([
          ...removed.flatMap((step) => manualInstallCommands(step.spec, profile, group.id)),
          ...failed.flatMap((step) => {
            const target = targets.find((item) => item.member === step.member);
            return manualUninstallCommands(target?.bundleName ?? step.spec, profile, group.id);
          }),
        ]),
        manifestRestored
          ? `已从快照恢复 ${profile} profile 的 package.json / pnpm-lock.yaml`
          : `手动恢复：核对 ${profile} profile 的 package.json / pnpm-lock.yaml 与 pnpm-lock.yaml`,
      ]
    : [];

  const ok = failed.length === 0;
  const manifestOutcome = failed.length
    ? manifestRestored
      ? '；原始 package.json / pnpm-lock.yaml 已恢复'
      : '；无法恢复或确认原始 manifest，请按恢复命令人工核对'
    : '';
  const summary = ok
    ? `组 ${group.id} 已按 members 逆序卸载 ${removed.length} 个成员，清单已恢复到安装前状态`
    : `组 ${group.id} 卸载未完成：${failed.length} 步失败${manifestOutcome}`;
  return {
    groupId: group.id,
    mode: 'live',
    startedAt,
    finishedAt: stamp(input.now),
    ok,
    idempotent: false,
    manifestRestored,
    summary,
    steps,
    recovery,
    nextSteps: ok
      ? [`/market verify ${group.id} 确认清单已恢复；如需重装运行 /market install ${group.id}`]
      : [...new Set(failed.flatMap((step) => step.nextSteps))],
  };
}

/** Human-readable report for both the command and the model-facing tool. */
export function renderUninstallReport(report: UninstallReport): string {
  const lines = [
    `卸载报告 · ${report.groupId} · ${report.mode === 'degraded' ? '降级模式' : '宿主卸载'}`,
    report.summary,
    `时间 ${report.startedAt} → ${report.finishedAt}`,
  ];
  if (report.idempotent) lines.push('幂等：没有已安装成员，未调用宿主卸载');
  lines.push('');
  for (const step of report.steps) {
    const mark = step.status === 'removed' ? '✓' : step.status === 'failed' ? '✗' : '·';
    lines.push(`${mark} ${step.member}  ${step.spec}`);
    lines.push(`    ${step.detail}${step.application ? ` [${step.application}]` : ''}`);
  }
  if (report.recovery.length) {
    lines.push('', '恢复命令（可直接复制）：');
    for (const command of report.recovery) lines.push(`  → ${command}`);
  }
  if (report.nextSteps.length) {
    lines.push('', '下一步：');
    for (const step of report.nextSteps) lines.push(`  → ${step}`);
  }
  return lines.join('\n');
}
