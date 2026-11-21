/**
 * Build the embedded offline snapshot for M1 from the data repository.
 * Uses the canonical 6 curated groups from DSH-MARKET-PLAN.md §4.3 and the 25
 * listed plugins from the family catalog. Writes src/snapshot.json (and lib/
 * when a built tree already exists). Runtime never imports this script.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(root, '..', 'dsh-market-data', 'data');

const CANONICAL_GROUPS = [
  'starter-three',
  'archive-chain',
  'saving-combo',
  'handoff-duo',
  'plugin-dev',
  'eco-radar',
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readAll = (folder) => readdirSync(join(dataRoot, folder))
  .filter((name) => name.endsWith('.json'))
  .map((name) => readJson(join(dataRoot, folder, name)));

const catalog = readJson(join(dataRoot, '..', 'scripts', 'catalog.source.json'));
const listedIds = new Set(catalog.plugins.filter((entry) => entry.listed !== false).map((entry) => entry.repo));

const selectedPlugins = readAll('plugins')
  .filter((plugin) => listedIds.has(plugin.id))
  .sort((a, b) => a.id.localeCompare(b.id));

const allGroups = readAll('groups');
const selectedGroups = CANONICAL_GROUPS
  .map((id) => allGroups.find((group) => group.id === id))
  .filter(Boolean);

const missing = CANONICAL_GROUPS.filter((id) => !selectedGroups.some((group) => group.id === id));
if (missing.length) throw new Error(`missing canonical groups: ${missing.join(', ')}`);
if (selectedPlugins.length !== 25) throw new Error(`expected 25 catalog plugins, found ${selectedPlugins.length}`);

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'dsh-market-data',
  plugins: selectedPlugins,
  groups: selectedGroups,
};

const write = (path) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
};
write(join(root, 'src', 'snapshot.json'));
const builtSnapshot = join(root, 'lib', 'snapshot.json');
if (existsSync(builtSnapshot)) write(builtSnapshot);
console.log(`make-snapshot: ${snapshot.plugins.length} plugins, ${snapshot.groups.length} groups → src/snapshot.json`);
