/** Pure renderers. Every path is empty-safe and includes the snapshot stamp. */
import type { MarketRead, SnapshotMeta } from './types.ts';
/** Always shown at the top of every market view. */
export declare function renderStamp(meta: SnapshotMeta): string;
/** `/market` — curated groups first, then the rest. Never throws on empty input. */
export declare function renderList(read: MarketRead): string;
/** `/market group <id>` — full detail; unknown id gets a helpful, non-crashing reply. */
export declare function renderGroup(read: MarketRead, id: string): string;
