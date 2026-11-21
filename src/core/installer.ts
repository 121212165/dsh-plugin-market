/** M2 orchestration: pre-check → ordered install → four-state verification.
 * The orchestrator never throws: every failure becomes a visible report with
 * an executable next step. */
import { planGroupInstall, renderConflicts, specFor } from './conflicts.ts';
import { manualInstallCommands } from './seam.ts';
import type {
  ApplicationState,
  ChangeResultLike,
  Conflict,
  InstallReport,
  InstallSeam,
  InstallStepResult,
  InstalledRow,
  VerificationMember,
  VerificationReport,
} from './install-types.ts';
import type { MarketIndex, PluginEntry } from './types.ts';

export interface InstallInput {
  groupId: string;
  index: MarketIndex;
  seam: InstallSeam | null;
  profile?: string;
  excluded?: string[] | undefined;
  reinstall?: boolean | undefined;
  registeredCommands?: string[] | undefined;
  now?: (() => number) | undefined;
  onProgress?: (line: string) => void;
}

export interface VerifyInput {
  groupId: string;
  index: MarketIndex;
  seam: InstallSeam | null;
  applicationByMember?: Record<string, ApplicationState>;
  registeredCommands?: string[] | undefined;
  profile?: string;
  now?: (() => number) | undefined;
}

const stamp = (now?: () => number): string => new Date((now ?? Date.now)()).toISOString();

function pluginOf(index: MarketIndex, id: string): PluginEntry | undefined {
  return index.plugins.find((plugin) => plugin.id === id);
}

function memberKeys(plugin: PluginEntry | undefined, id: string): string[] {
  return [id, plugin?.npm ?? '', plugin?.repo ?? '', plugin?.repo.split('/').pop() ?? '']
    .filter(Boolean).map((value) => value.toLowerCase());
}

function findRow(rows: InstalledRow[], plugin: PluginEntry | undefined, id: string): InstalledRow | undefined {
  const keys = new Set(memberKeys(plugin, id));
  return rows.find((row) => [row.id, row.moduleName ?? '', ...String(row.id).split(':')]
    .filter(Boolean).some((value) => keys.has(String(value).toLowerCase())));
}

/** Map a host failure code to a step the user can actually take. */
export function nextStepsFor(result: ChangeResultLike, spec: string, profile: string): string[] {
  const code = result.error?.code ?? result.packageResult?.kind ?? 'operation-error';
  const diagnostic = result.error?.diagnostic ? `（${result.error.diagnostic.slice(0, 160)}）` : '';
  switch (code) {
    case 'incompatible-version':
      return [`当前 dsh 版本拒绝该插件的 peer 范围${diagnostic}；升级 dsh 或换用兼容版本`, `/market seams 查看当前 host 信息；dsh --version 确认版本`];
    case 'not-found':
    case 'no-matching-version':
    case 'invalid-spec':
      return [`包名/仓库地址无效${diagnostic}；先 npm view ${spec} version 确认包存在`, `修正市集数据后重试：/market install <id>`];
    case 'network':
    case 'timeout':
      return [`网络或 registry 不可达${diagnostic}；检查代理后重试`, `重试 /market install <id>（安装失败不会写坏 profile）`];
    case 'build-blocked':
      return [`构建脚本未获批准${diagnostic}；确认可信后再传入 approvedBuilds`, `dsh plugin --profile ${profile} list 查看 pendingBuilds`];
    case 'pendingBuilds':
      return [`有待批准构建脚本：${(result.pendingBuilds ?? []).join(', ') || '见输出'}；确认后重试`, `/market seams 查看 seam 是否支持 approvedBuilds`];
    case 'management-required':
    case 'unaddressable':
      return [`该层受管理策略保护${diagnostic}；需管理员或更高权限安装`, `用 /market seams 查看当前 profile 与层，再决定是否切换 profile`];
    case 'overridden':
      return [`被更高优先级层覆盖${diagnostic}；运行 dsh plugin --profile ${profile} list 检查 patch 顺序`, `确认要保留哪一层后，用 /market install <id> --without <冲突成员> 或移除旧层`];
    case 'cancelled':
      return ['安装已取消，profile 文件已回滚；确认后重新运行 /market install <id>'];
    default:
      return [
        `安装失败：${code}${diagnostic}`,
        result.packageResult?.logPath ? `查看完整日志：${result.packageResult.logPath}` : `手动安装：${manualInstallCommands(spec, profile, '该组').join(' → ')}`,
        '/market seams 检查 seam；/market group <id> 复核成员与协同点',
      ];
  }
}

function classify(result: ChangeResultLike, member: string, spec: string, profile: string): InstallStepResult {
  const application = result.application ?? 'failed';
  const base = { member, spec, application };
  const label: Record<ApplicationState, string> = {
    applied: '已生效', 'restart-required': '需重启后生效', overridden: '被更高优先级层覆盖', failed: '失败', cancelled: '已取消',
  };
  if (application === 'failed' || application === 'cancelled') {
    const detail = result.error?.diagnostic || result.packageResult?.output?.trim().split('\n').slice(-1)[0] || label[application];
    return { ...base, status: 'failed', detail: `${detail}（stage=${result.stage}, target=${result.target}）`, nextSteps: nextStepsFor(result, spec, profile) };
  }
  if (application === 'overridden') {
    return {
      ...base, status: 'failed', detail: `${member} 被更高优先级层覆盖，不要当作安装成功`,
      nextSteps: nextStepsFor({ ...result, error: { ...result.error, code: 'overridden' } }, spec, profile),
    };
  }
  if (application === 'restart-required') {
    return {
      ...base, status: 'done',
      detail: `${member} 已写入 profile，需重启 dsh web 后生效`,
      nextSteps: [`重启 web 后开新会话，运行 /market verify <groupId>`, `/market group <groupId> 查看可执行的验收步骤`],
    };
  }
  return {
    ...base, status: 'done', detail: `${member} 已安装并生效（stage=${result.stage}）`,
    nextSteps: ['/market verify <groupId> 复核四态与命令可见性'],
  };
}

/** Verify what actually mounted, not what we intended to mount. */
export async function verifyGroup(input: VerifyInput): Promise<VerificationReport> {
  const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
  if (!group) {
    return { groupId: input.groupId, members: [], ok: false, summary: `找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组` };
  }
  let rows: InstalledRow[] = [];
  try {
    rows = (await input.seam?.listPlugins?.()) ?? [];
  } catch {
    rows = [];
  }
  const liveCommands = new Set((input.registeredCommands ?? []).map((name) => name.startsWith('/') ? name : `/${name}`));
  const members: VerificationMember[] = group.members.map((id) => {
    const plugin = pluginOf(input.index, id);
    const row = findRow(rows, plugin, id);
    const application = input.applicationByMember?.[id];
    const present = Boolean(row);
    const enabled = row?.enabled === true;
    const active = row?.fiberPhase === 'active' || (row?.fiberPhase == null && present);
    const nextSteps: string[] = [];
    const detail: string[] = [];
    if (!present) {
      detail.push('未在安装清单中出现');
      nextSteps.push(`/market install ${group.id} --reinstall 重试 ${id}`);
    }
    if (!enabled) {
      detail.push('row 处于 disabled');
      nextSteps.push(`dsh plugin --profile ${input.profile ?? 'web'} set ${id} enabled`);
    }
    if (present && !active) {
      detail.push(`fiberPhase=${row?.fiberPhase ?? 'unknown'}`);
      nextSteps.push('重启 web 后开新会话再运行 /market verify');
    }
    if (application === 'overridden') {
      detail.push('application=overridden，被更高优先级层覆盖');
      nextSteps.push(`检查更高优先级 patch：dsh plugin --profile ${input.profile ?? 'web'} list`);
    }
    if (application === 'restart-required') {
      detail.push('application=restart-required');
      nextSteps.push('重启 web 后开新会话再验证');
    }
    const missingCommands = (plugin?.entries ?? []).filter((entry) => entry.startsWith('/') && !liveCommands.has(entry));
    if (liveCommands.size && missingCommands.length && present && active) {
      detail.push(`命令未注册：${missingCommands.join(' ')}`);
      nextSteps.push('在新会话里让模型调用一次该命令；若仍不可见，检查 profile 是否 restart-required');
    }
    if (!detail.length) detail.push('已挂载、enabled、active，声明的命令均可见');
    return { member: id, present, active, enabled, detail: detail.join('；'), nextSteps };
  });
  const ok = members.every((member) => member.present && member.active && member.enabled && !member.nextSteps.some((step) => step.includes('overridden')));
  return {
    groupId: group.id,
    members,
    ok,
    summary: ok
      ? `验收通过：${members.length} 个成员全部挂载且生效（用 /market group ${group.id} 查看业务验收步骤）`
      : `验收未通过：${members.filter((member) => !member.present || !member.active || !member.enabled).map((member) => member.member).join(', ') || '见各成员详情'}`,
  };
}

/** Full install flow. `seam === null` means degraded: we return manual steps
 * and never claim anything was installed. */
export async function runGroupInstall(input: InstallInput): Promise<InstallReport> {
  const startedAt = stamp(input.now);
  const group = input.index.groups.find((candidate) => candidate.id === input.groupId);
  const profile = input.profile || 'web';
  const empty = (summary: string, conflicts: Conflict[] = []): InstallReport => ({
    groupId: input.groupId,
    mode: input.seam ? 'live' : 'degraded',
    startedAt,
    finishedAt: stamp(input.now),
    ok: false,
    summary,
    conflicts,
    steps: [],
    verification: null,
    nextSteps: input.seam ? [] : (group?.members ?? []).flatMap((id) => manualInstallCommands(specFor(pluginOf(input.index, id)), profile, input.groupId)),
  });
  if (!group) return empty(`找不到组 ${input.groupId || '(空)'}；用 /market 查看可用组`);
  if (!input.seam) {
    return empty(
      `plugin_manager seam 不可用（已核实 ${input.index.groups.length} 组中的 ${group.id}），未执行任何安装。请复制下面的命令手动安装，再用 /market verify 校验。若刚启用 plugin_manager，重启或重跑本命令。`,
    );
  }

  let plugins: InstalledRow[] = [];
  let bundles: { name: string; enabled: boolean }[] = [];
  try {
    plugins = (await input.seam.listPlugins?.()) ?? [];
    bundles = (await input.seam.listBundles?.()) ?? [];
  } catch (error) {
    return empty(`读取宿主安装清单失败：${error instanceof Error ? error.message : String(error)}；为避免误装已停止`, []);
  }

  const plan = planGroupInstall({
    group, index: input.index, inventory: { plugins, bundles },
    registeredCommands: input.registeredCommands, excluded: input.excluded,
    profile, reinstall: input.reinstall,
  });
  if (plan.blocked) {
    const fixes = plan.conflicts.filter((conflict) => conflict.severity === 'blocking').map((conflict) => conflict.fix);
    return {
      ...empty(`安装前预检未通过：${plan.conflicts.filter((c) => c.severity === 'blocking').map((c) => c.detail).join('；')}`, plan.conflicts),
      nextSteps: [...new Set(fixes)],
    };
  }

  const steps: InstallStepResult[] = [];
  const applicationByMember: Record<string, ApplicationState> = {};
  for (const planned of plan.steps) {
    if (planned.action !== 'install') {
      steps.push({ member: planned.member, spec: planned.spec, status: 'skipped', detail: planned.reason ?? '跳过', nextSteps: [] });
      continue;
    }
    input.onProgress?.(`安装 ${planned.member} ← ${planned.spec}`);
    try {
      const result = await input.seam.installBundle(planned.spec, { enabled: true });
      applicationByMember[planned.member] = result.application ?? 'failed';
      steps.push(classify(result, planned.member, planned.spec, profile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      applicationByMember[planned.member] = 'failed';
      steps.push({
        member: planned.member, spec: planned.spec, status: 'failed',
        detail: `调用 plugin_manager.installBundle 失败：${message}`,
        nextSteps: [
          `/market seams 核实宿主的 installBundle 签名是否变化（${input.seam.source}）`,
          `手动安装：${manualInstallCommands(planned.spec, profile, group.id).join(' → ')}`,
        ],
      });
    }
  }

  const verification = await verifyGroup({
    groupId: group.id, index: input.index, seam: input.seam,
    applicationByMember, registeredCommands: input.registeredCommands, now: input.now, profile,
  });
  const failed = steps.filter((step) => step.status === 'failed');
  const nextSteps = [...new Set([
    ...steps.flatMap((step) => step.nextSteps),
    ...verification.members.flatMap((member) => member.nextSteps),
    ...(failed.length ? [] : [`按 /market group ${group.id} 的验收步骤做一次真回路`]),
  ])];
  const ok = failed.length === 0 && verification.ok;
  return {
    groupId: group.id,
    mode: 'live',
    startedAt,
    finishedAt: stamp(input.now),
    ok,
    summary: ok
      ? `${group.name}：${steps.filter((step) => step.status === 'done').length} 个成员安装成功，${verification.summary}`
      : `${group.name}：${failed.length} 步失败；${verification.summary}`,
    conflicts: plan.conflicts,
    steps,
    verification,
    nextSteps,
  };
}

/** Render the full report for both the command and the model-facing tool. */
export function renderInstallReport(report: InstallReport): string {
  const lines = [
    `安装报告 · ${report.groupId} · ${report.mode === 'degraded' ? '降级模式' : '宿主安装'}`,
    report.summary,
    `时间 ${report.startedAt} → ${report.finishedAt}`,
    '',
  ];
  if (report.conflicts.length) lines.push(renderConflicts({ groupId: report.groupId, steps: [], conflicts: report.conflicts, blocked: !report.ok }), '');
  for (const step of report.steps) {
    const mark = step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '·';
    lines.push(`${mark} ${step.member}  ${step.spec}`);
    lines.push(`    ${step.detail}${step.application ? ` [${step.application}]` : ''}`);
  }
  if (report.verification) {
    lines.push('', `生效校验：${report.verification.summary}`);
    for (const member of report.verification.members) lines.push(`  ${member.member}：${member.detail}`);
  }
  if (report.nextSteps.length) {
    lines.push('', '下一步：');
    for (const step of report.nextSteps) lines.push(`  → ${step}`);
  }
  return lines.join('\n');
}

/** Exposed so tests and the command can verify without reinstalling. */
export async function runVerify(input: VerifyInput & { profile?: string }): Promise<string> {
  const probe = await verifyGroup(input);
  return [
    `生效校验 · ${input.groupId}`,
    probe.summary,
    ...probe.members.map((member) => `  ${member.member}：${member.detail}${member.nextSteps.length ? ` → ${member.nextSteps.join(' | ')}` : ''}`),
  ].join('\n');
}
