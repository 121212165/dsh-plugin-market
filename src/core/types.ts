/** Read-contract types. Mirrors dsh-market-data/schema/*.json. No dsh imports — pure. */

export interface PluginEntry {
  id: string;
  repo: string;
  npm?: string;
  name: string;
  oneLiner: string;
  category: string;
  entries: string[];
  /** F6: host slots this plugin injects into (e.g. `conversation.view`).
   * Optional — older catalog entries predate slot declarations. Slot-like
   * entries (`slot:<name>` or well-known slot ids) are also recognized. */
  slots?: string[];
  requires: string[];
  dshRange: string;
  license: string;
  author: string;
  borrowedFrom: string[];
  verifiedAt: string;
  stars?: number;
  votes?: number;
}

export interface GroupEntry {
  id: string;
  name: string;
  oneLiner: string;
  members: string[];
  why: string[];
  installOrder: string;
  conflicts: string[];
  verify: string[];
  curator: 'editor' | 'community';
  updatedAt: string;
  votes?: number;
}

/** `data/index.json` and `src/snapshot.json` share this exact shape (同构). */
export interface MarketIndex {
  schemaVersion: number;
  generatedAt: string;
  source?: string;
  plugins: PluginEntry[];
  groups: GroupEntry[];
}

/** Which tier of the read fallback produced the data. */
export type ReadLayer = 'remote' | 'mirror' | 'cache' | 'snapshot' | 'empty';

export interface SnapshotMeta {
  generatedAt: string;
  layer: ReadLayer;
  stale: boolean;
  ageHours: number;
  /** Human source label, e.g. the URL or cache path that won. */
  origin: string;
}

export interface MarketRead {
  index: MarketIndex;
  meta: SnapshotMeta;
  /** Non-fatal diagnostics (failed tiers), safe to surface in logs. */
  notices: string[];
}

export const EMPTY_INDEX: MarketIndex = {
  schemaVersion: 1,
  generatedAt: '',
  plugins: [],
  groups: [],
};
