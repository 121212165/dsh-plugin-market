const LAYER_LABEL = {
    remote: '实时',
    mirror: '镜像',
    cache: '缓存',
    snapshot: '内置快照',
    empty: '空数据',
};
function formatDate(generatedAt) {
    if (!generatedAt)
        return '未知';
    const date = new Date(generatedAt);
    if (Number.isNaN(date.getTime()))
        return generatedAt;
    // Stable, locale-independent rendering for tests and terminals.
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
/** Always shown at the top of every market view. */
export function renderStamp(meta) {
    const stampLabel = meta.stale ? '快照' : LAYER_LABEL[meta.layer];
    const age = meta.ageHours >= 0 ? ` · ${meta.ageHours}h 前` : '';
    const source = meta.origin ? ` · 来源 ${meta.origin}` : '';
    return `数据 ${stampLabel} ${formatDate(meta.generatedAt)}${age}${source}`;
}
function memberNames(group, byId) {
    return group.members.map((id) => byId.get(id)?.name ?? id).join(' → ');
}
/** `/market` — curated groups first, then the rest. Never throws on empty input. */
export function renderList(read) {
    const { index, meta } = read;
    const header = ['插件市集 · 只读浏览', renderStamp(meta)];
    if (!index.groups.length) {
        return [
            ...header,
            '',
            '暂无可展示的插件组。数据层离线且没有内置快照；请检查网络连接后重试。',
            '（安装/投票/投稿将在后续检查点开放；当前版本只读，不会修改你的配置。）',
        ].join('\n');
    }
    const byId = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));
    const lines = [...header, '', `精选与社区共 ${index.groups.length} 组 · ${index.plugins.length} 个插件`, ''];
    const ordered = [...index.groups].sort((a, b) => (a.curator === b.curator ? 0 : a.curator === 'editor' ? -1 : 1));
    for (const group of ordered) {
        const tag = group.curator === 'editor' ? '编辑精选' : '社区投稿';
        lines.push(`• ${group.name}  [${group.id}] · ${tag}`);
        lines.push(`    ${group.oneLiner}`);
        lines.push(`    ${group.members.length} 个插件：${memberNames(group, byId)}`);
    }
    lines.push('');
    lines.push('用 /market group <id> 查看成员与协同点；用 /market install <id> 一键安装；/market seams 检查宿主安装能力。');
    return lines.join('\n');
}
/** `/market group <id>` — full detail; unknown id gets a helpful, non-crashing reply. */
export function renderGroup(read, id) {
    const { index, meta } = read;
    const header = ['插件组详情', renderStamp(meta), ''];
    if (!index.groups.length) {
        return [...header, '暂无插件组数据；用 /market 查看当前状态。'].join('\n');
    }
    const group = index.groups.find((candidate) => candidate.id === id);
    if (!group) {
        return [
            ...header,
            `找不到组 \`${id || '(空)'}\`。`,
            '',
            '可用组：',
            ...index.groups.map((candidate) => `  • ${candidate.id} — ${candidate.name}`),
            '',
            '用法：/market group <id>',
        ].join('\n');
    }
    const byId = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));
    const lines = [...header, `# ${group.name}  [${group.id}]`, group.oneLiner, ''];
    lines.push('成员（安装顺序）：');
    group.members.forEach((memberId, index0) => {
        const plugin = byId.get(memberId);
        const label = plugin ? `${plugin.name} · ${plugin.oneLiner}` : `${memberId}（数据缺失）`;
        lines.push(`  ${index0 + 1}. ${label}`);
        lines.push(`     ${memberId}`);
    });
    lines.push('', '为什么这样组（真实握手契约）：');
    for (const line of group.why)
        lines.push(`  • ${line}`);
    lines.push('', '安装顺序：', `  ${group.installOrder}`);
    lines.push('', '冲突预检：', group.conflicts.length ? group.conflicts.map((item) => `  ! ${item}`).join('\n') : '  无已知冲突');
    lines.push('', '验收步骤（可执行）：');
    for (const line of group.verify)
        lines.push(`  ✓ ${line}`);
    lines.push('', '一键安装（M2）：', `  /market install ${group.id}`);
    lines.push(`  /market install ${group.id} --without <成员id>   跳过冲突成员`);
    lines.push(`  /market install ${group.id} --reinstall           重新安装已装成员`);
    lines.push(`  /market verify ${group.id}                        只校验四态与命令可见性`);
    return lines.join('\n');
}
