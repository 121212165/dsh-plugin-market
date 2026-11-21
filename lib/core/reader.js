/**
 * Three-layer read fallback (four tiers including the built-in snapshot).
 * The network and filesystem are injected so acceptance tests can block hosts
 * and delete the cache without touching the real machine.
 *
 * Order: raw.githubusercontent.com → cdn.jsdelivr.net → ~/.dsh/market cache →
 *        embedded snapshot.json → empty index (never throw, never crash).
 */
import { EMPTY_INDEX } from './types.js';
export const DEFAULT_RAW_URL = 'https://raw.githubusercontent.com/121212165/dsh-market-data/main/data/index.json';
export const DEFAULT_MIRROR_URL = 'https://cdn.jsdelivr.net/gh/121212165/dsh-market-data@main/data/index.json';
export const DEFAULT_TIMEOUT_MS = 1500;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Structural check: enough to trust the payload as a read contract. */
export function parseIndex(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return null;
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object')
            return null;
        if (!Array.isArray(value.plugins) || !Array.isArray(value.groups))
            return null;
        if (typeof value.generatedAt !== 'string')
            return null;
        return {
            schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
            generatedAt: value.generatedAt,
            ...(value.source ? { source: value.source } : {}),
            plugins: value.plugins,
            groups: value.groups,
        };
    }
    catch {
        return null;
    }
}
function buildMeta(index, layer, origin, now, staleAfterMs) {
    const stamp = Date.parse(index.generatedAt);
    const ageMs = Number.isFinite(stamp) ? Math.max(0, now - stamp) : Number.POSITIVE_INFINITY;
    return {
        generatedAt: index.generatedAt,
        layer,
        // No stamp, or older than 24h → must be labelled a snapshot, never passed off as live.
        stale: !Number.isFinite(ageMs) || ageMs > staleAfterMs,
        ageHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3_600_000) * 10) / 10 : -1,
        origin,
    };
}
/**
 * Walk the fallback chain and return a usable read. Always resolves.
 * An empty or malformed built-in snapshot degrades to an empty index instead
 * of throwing — "空数据不崩".
 */
export async function readMarket(deps) {
    const rawUrl = deps.rawUrl ?? DEFAULT_RAW_URL;
    const mirrorUrl = deps.mirrorUrl ?? DEFAULT_MIRROR_URL;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const now = (deps.now ?? Date.now)();
    const note = (message) => { deps.log?.(`[market] ${message}`); };
    const notices = [];
    const sources = [
        { url: rawUrl, layer: 'remote' },
        { url: mirrorUrl, layer: 'mirror' },
    ];
    for (const source of sources) {
        let text = null;
        try {
            text = await deps.fetchText(source.url, timeoutMs);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            notices.push(`${source.layer} unreachable: ${reason}`);
            note(`${source.layer} failed (${reason})`);
        }
        if (text) {
            const index = parseIndex(text);
            if (index) {
                // Cache is a best-effort accelerator; a write failure must be visible
                // but must not turn a successful read into a failure.
                try {
                    await deps.writeCache(text);
                }
                catch (error) {
                    note(`cache write failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                return { index, meta: buildMeta(index, source.layer, source.url, now, staleAfterMs), notices };
            }
            notices.push(`${source.layer} returned invalid data`);
            note(`${source.layer} returned invalid data`);
        }
    }
    let cached = null;
    try {
        cached = await deps.readCache();
    }
    catch (error) {
        notices.push(`cache read failed: ${error instanceof Error ? error.message : String(error)}`);
        note(`cache read failed: ${String(error)}`);
    }
    if (cached) {
        const index = parseIndex(cached);
        if (index) {
            return { index, meta: buildMeta(index, 'cache', 'local cache', now, staleAfterMs), notices };
        }
        notices.push('cache contained invalid data');
        note('cache contained invalid data');
    }
    else {
        notices.push('cache miss');
    }
    const embeddedIndex = parseIndex(deps.embedded);
    if (embeddedIndex) {
        note(`using embedded snapshot (${embeddedIndex.groups.length} groups)`);
        return { index: embeddedIndex, meta: buildMeta(embeddedIndex, 'snapshot', 'built-in snapshot.json', now, staleAfterMs), notices };
    }
    notices.push('built-in snapshot empty or invalid — serving empty market');
    note('built-in snapshot empty or invalid — serving empty market');
    return {
        index: EMPTY_INDEX,
        meta: buildMeta(EMPTY_INDEX, 'empty', 'none', now, staleAfterMs),
        notices,
    };
}
/** True when the network fetch should be bypassed (kept pure for callers/tests). */
export function isHostBlocked(url, blockedHosts) {
    try {
        const host = new URL(url).hostname;
        return blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
    }
    catch {
        return false;
    }
}
