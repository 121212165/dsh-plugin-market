/**
 * Three-layer read fallback (four tiers including the built-in snapshot).
 * The network and filesystem are injected so acceptance tests can block hosts
 * and delete the cache without touching the real machine.
 *
 * Order: raw.githubusercontent.com → cdn.jsdelivr.net → ~/.dsh/market cache →
 *        embedded snapshot.json → empty index (never throw, never crash).
 */
import { type MarketIndex, type MarketRead } from './types.ts';
export declare const DEFAULT_RAW_URL = "https://raw.githubusercontent.com/121212165/dsh-market-data/main/data/index.json";
export declare const DEFAULT_MIRROR_URL = "https://cdn.jsdelivr.net/gh/121212165/dsh-market-data@main/data/index.json";
export declare const DEFAULT_TIMEOUT_MS = 1500;
export declare const DEFAULT_CACHE_TTL_MS: number;
export declare const DEFAULT_STALE_AFTER_MS: number;
export interface ReaderDeps {
    /** Fetch text from a URL. Inject a host-blocking fetch in tests. */
    fetchText: (url: string, timeoutMs: number) => Promise<string>;
    /** Read the local cache file; return null when missing/expired. */
    readCache: () => Promise<string | null>;
    /** Persist a successful remote/mirror fetch to the cache. */
    writeCache: (text: string) => Promise<void>;
    /** The built-in snapshot.json serialized as text. */
    embedded: string;
    rawUrl?: string;
    mirrorUrl?: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
    staleAfterMs?: number;
    now?: () => number;
    log?: (message: string) => void;
}
/** Structural check: enough to trust the payload as a read contract. */
export declare function parseIndex(text: string): MarketIndex | null;
/**
 * Walk the fallback chain and return a usable read. Always resolves.
 * An empty or malformed built-in snapshot degrades to an empty index instead
 * of throwing — "空数据不崩".
 */
export declare function readMarket(deps: ReaderDeps): Promise<MarketRead>;
/** True when the network fetch should be bypassed (kept pure for callers/tests). */
export declare function isHostBlocked(url: string, blockedHosts: string[]): boolean;
