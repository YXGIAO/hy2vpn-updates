import type { Catalog, CatalogRelease, Env, Platform } from './types';

export const CATALOG_KEY = 'catalog.json';

export class StorageError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

export function store(env: Env): KVNamespace {
  if (!env.CATALOG) {
    throw new StorageError('未绑定 KV 命名空间，请在 Pages 设置中添加 CATALOG 绑定', 503);
  }
  return env.CATALOG;
}

function normalize(catalog: Catalog): Catalog {
  if (!Array.isArray(catalog.releases)) catalog.releases = [];
  for (const release of catalog.releases) {
    release.notes = String(release.notes || '');
    release.versionCode = Number(release.versionCode) || null;
    release.downloadUrl = String(release.downloadUrl || '');
    release.force = Boolean(release.force);
    release.prerelease = Boolean(release.prerelease);
    release.draft = Boolean(release.draft);
  }
  return catalog;
}

export async function readCatalog(env: Env): Promise<Catalog> {
  const raw = await store(env).get(CATALOG_KEY);
  let catalog: Catalog = { updatedAt: '', releases: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Catalog;
      if (parsed && Array.isArray(parsed.releases)) catalog = parsed;
    } catch (_) {
      catalog = { updatedAt: '', releases: [] };
    }
  }
  return normalize(catalog);
}

export async function writeCatalog(env: Env, catalog: Catalog): Promise<void> {
  catalog.updatedAt = new Date().toISOString();
  await store(env).put(CATALOG_KEY, JSON.stringify(catalog));
}

function parseCore(version: string): { nums: number[]; pre: string } {
  const withoutBuild = version.split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const pre = dash >= 0 ? withoutBuild.slice(dash + 1) : '';
  return { nums: core.split('.').map((part) => Number(part) || 0), pre };
}

export function compareVersions(a: string, b: string): number {
  const left = parseCore(a);
  const right = parseCore(b);
  for (let index = 0; index < 3; index++) {
    const diff = (left.nums[index] || 0) - (right.nums[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

export function sortReleases(list: CatalogRelease[]): CatalogRelease[] {
  return [...list].sort((left, right) => {
    const diff = compareVersions(right.version, left.version);
    if (diff !== 0) return diff;
    return (right.publishedAt || '').localeCompare(left.publishedAt || '');
  });
}

export function latestFor(
  releases: CatalogRelease[],
  platform: Platform,
  channel: 'stable' | 'beta',
): CatalogRelease | null {
  const sorted = sortReleases(releases.filter((release) => release.platform === platform));
  for (const release of sorted) {
    if (release.draft || !release.downloadUrl) continue;
    if (channel === 'stable' && release.prerelease) continue;
    return release;
  }
  return null;
}

export function normalizeDownloadUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function normalizePlatform(value: unknown): Platform | null {
  const platform = String(value || '').toLowerCase();
  return platform === 'android' || platform === 'windows' ? platform : null;
}
