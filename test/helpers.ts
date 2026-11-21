import { readFileSync } from 'node:fs';
import type { MarketIndex } from '../src/core/index.ts';

export const SNAPSHOT_TEXT = readFileSync(new URL('../src/snapshot.json', import.meta.url), 'utf8');

export function snapshotIndex(): MarketIndex {
  return JSON.parse(SNAPSHOT_TEXT) as MarketIndex;
}

export function freshIndex(): MarketIndex {
  const index = snapshotIndex();
  return { ...index, generatedAt: new Date().toISOString() };
}

export function emptyIndex(): MarketIndex {
  return { schemaVersion: 1, generatedAt: '', plugins: [], groups: [] };
}
