const KNOWN = new Set(['list', 'group', 'install', 'verify', 'seams', 'doctor', 'vote', 'submit', 'fuse', 'help']);
export function parseMarketArgs(rawInput) {
    const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return { subcommand: 'list', target: '', rest: [] };
    const [head, ...tail] = tokens;
    if (KNOWN.has(head)) {
        return { subcommand: head, target: tail[0] ?? '', rest: tail.slice(1) };
    }
    // Unknown first token: treat it as a shortcut/filter on the list view.
    return { subcommand: 'list', target: head, rest: tail };
}
