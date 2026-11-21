const commandKey = (entry) => entry.startsWith('/') ? `cmd:${entry}` : `tool:${entry}`;
function installedKey(row) {
    return [row.id, row.moduleName ?? '', ...String(row.id).split(':')].filter(Boolean).map((value) => value.toLowerCase());
}
function isActive(row) {
    return row.enabled !== false && (row.fiberPhase === 'active' || row.fiberPhase === 'pending' || row.fiberPhase == null);
}
/** Check collisions inside the group and against the live host inventory. */
export function planGroupInstall(input) {
    const { group, index } = input;
    const profile = input.profile || 'web';
    const excluded = new Set(input.excluded ?? []);
    const byId = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));
    const conflicts = [];
    const members = group.members.filter((id) => !excluded.has(id));
    // 1. Every member must exist in the catalog, or the group is a marketing pile.
    for (const id of members) {
        if (byId.has(id))
            continue;
        conflicts.push({
            kind: 'missing-member', key: id, members: [id], severity: 'blocking',
            detail: `组 ${group.id} 的成员 ${id} 不在市集数据中`,
            fix: `先运行 npm run build 同步 index.json；若该插件尚未收录，用 /market submit 投稿后再安装`,
        });
    }
    const present = members.map((id) => byId.get(id)).filter((plugin) => Boolean(plugin));
    const installedRows = input.inventory?.plugins ?? [];
    const installedBundles = input.inventory?.bundles ?? [];
    const liveKeys = new Set(installedRows.flatMap(installedKey));
    const liveCommands = new Set((input.registeredCommands ?? []).map((name) => name.startsWith('/') ? name : `/${name}`));
    // 2. Command / tool collisions between group members.
    const claimed = new Map();
    for (const plugin of present) {
        for (const entry of plugin.entries) {
            const key = commandKey(entry);
            const owner = claimed.get(key);
            if (owner && owner !== plugin.id) {
                conflicts.push({
                    kind: entry.startsWith('/') ? 'command' : 'tool', key: entry, members: [owner, plugin.id],
                    severity: 'blocking',
                    detail: `${owner} 与 ${plugin.id} 都声明了 ${entry}，同时装会导致 command already registered 启动失败`,
                    fix: `运行 /market install ${group.id} --without ${plugin.id} 只装不冲突的成员；或在 ${plugin.repo} 把 ${entry} 改名后重新投稿（两个都改也行）`,
                });
            }
            else if (!owner) {
                claimed.set(key, plugin.id);
            }
        }
    }
    // 3. Collisions with capabilities already registered in the host. Commands
    // owned by an already-installed member of this same group are expected.
    const memberInstalled = (plugin) => {
        const keys = new Set([plugin.id, plugin.npm ?? '', plugin.repo.split('/').pop() ?? '']
            .filter(Boolean).map((value) => value.toLowerCase()));
        return installedRows.some((row) => [row.id, row.moduleName ?? '', ...String(row.id).split(':')]
            .filter(Boolean).some((value) => keys.has(String(value).toLowerCase())));
    };
    for (const plugin of present) {
        if (memberInstalled(plugin))
            continue;
        for (const entry of plugin.entries) {
            if (!entry.startsWith('/') || !liveCommands.has(entry))
                continue;
            conflicts.push({
                kind: 'command', key: entry, members: [plugin.id], severity: 'blocking',
                detail: `${plugin.id} 的 ${entry} 已被当前 profile 中其他插件占用`,
                fix: `先查占用者：/market seams 看当前层；然后运行 /market install ${group.id} --without ${plugin.id}，或 dsh plugin --profile ${profile} list 找到旧插件后移除`,
            });
        }
    }
    // 4. Package / bundle collisions with the installed profile.
    const seenPackages = new Map();
    for (const plugin of present) {
        if (!plugin.npm)
            continue;
        const key = plugin.npm.toLowerCase();
        const owner = seenPackages.get(key);
        if (owner) {
            conflicts.push({
                kind: 'package', key, members: [owner, plugin.id], severity: 'blocking',
                detail: `${owner} 与 ${plugin.id} 指向同一个包 ${key}，重复安装会覆盖 bundle 层`,
                fix: `二选一：/market install ${group.id} --without ${plugin.id}（保留 ${owner}）`,
            });
        }
        else {
            seenPackages.set(key, plugin.id);
        }
        const live = installedRows.find((row) => liveKeys.has(key) && installedKey(row).includes(key));
        if (live && isActive(live) && !input.reinstall) {
            conflicts.push({
                kind: 'already-installed', key, members: [plugin.id], severity: 'warn',
                detail: `${plugin.id}（${key}）已安装在当前 profile：${live.fiberPhase ?? 'active'}`,
                fix: `保持现状即可；如需重装先 dsh plugin --profile ${profile} remove ${key}，再 /market install ${group.id} --reinstall`,
            });
        }
    }
    for (const bundle of installedBundles) {
        const key = bundle.name.toLowerCase();
        if (seenPackages.has(key) && bundle.enabled) {
            const pluginId = seenPackages.get(key);
            conflicts.push({
                kind: 'package', key, members: [pluginId], severity: 'warn',
                detail: `${key} 已作为 bundle 安装（enabled=${bundle.enabled}），安装器会复用该层`,
                fix: `无需重复安装；运行 /market verify ${group.id} 确认生效，或 dsh plugin --profile ${profile} list 查看`,
            });
        }
    }
    const steps = [];
    for (const id of group.members) {
        if (excluded.has(id)) {
            steps.push({ member: id, spec: specFor(byId.get(id)), action: 'skip-excluded', reason: '--without' });
            continue;
        }
        const plugin = byId.get(id);
        if (!plugin) {
            steps.push({ member: id, spec: id, action: 'install', reason: '数据缺失，预检已阻止安装' });
            continue;
        }
        const already = plugin.npm ? liveKeys.has(plugin.npm.toLowerCase()) : false;
        const skip = Boolean(already && !input.reinstall);
        steps.push({
            member: id,
            spec: specFor(plugin),
            action: skip ? 'skip-installed' : 'install',
            ...(skip ? { reason: '已安装且活跃' } : {}),
        });
    }
    return {
        groupId: group.id,
        steps,
        conflicts,
        blocked: conflicts.some((conflict) => conflict.severity === 'blocking'),
    };
}
/** Install spec: local fixture paths win (clean-profile tests), then the GitHub
 * repo (the `npm` names in the catalog were never published — installing them
 * 404s), npm only as a last resort. */
export function specFor(plugin) {
    if (!plugin)
        return '';
    const local = plugin.localPath;
    if (local)
        return local;
    const repo = plugin.repo.trim().replace(/\.git$/, '');
    if (repo)
        return `github:${repo}`;
    return plugin.npm ?? '';
}
/** Human-readable pre-check block, reused by the command and the tool. */
export function renderConflicts(plan) {
    if (!plan.conflicts.length)
        return '  冲突预检：通过（未发现命令/工具/包名撞车）';
    const lines = ['  冲突预检：'];
    for (const conflict of plan.conflicts) {
        const tag = conflict.severity === 'blocking' ? '阻断' : '提示';
        lines.push(`  [${tag}] ${conflict.detail}`);
        lines.push(`         修复建议：${conflict.fix}`);
    }
    return lines.join('\n');
}
