import type { Catalog, CatalogAsset, CatalogRelease, Env, Platform } from './types';

export const CATALOG_KEY = 'catalog.json';
export const ASSET_PREFIX = 'releases/';

export class StorageError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

export function bucket(env: Env): R2Bucket {
  if (!env.RELEASES) {
    throw new StorageError('未绑定 R2 存储桶，请在 Pages 设置中添加 RELEASES 绑定', 503);
  }
  return env.RELEASES;
}

const cacheRequest = new Request('https://hy2vpn-updates.internal/catalog/v2');
const CACHE_TTL = 120_000;

export async function clearCatalogCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.default.delete(cacheRequest);
}

function normalize(catalog: Catalog): Catalog {
  if (!Array.isArray(catalog.releases)) catalog.releases = [];
  for (const release of catalog.releases) {
    if (!release.asset || typeof release.asset.key !== 'string') release.asset = null;
    release.notes = String(release.notes || '');
    release.versionCode = Number(release.versionCode) || null;
    release.force = Boolean(release.force);
    release.prerelease = Boolean(release.prerelease);
    release.draft = Boolean(release.draft);
  }
  return catalog;
}

export async function readCatalog(env: Env, useCache = true): Promise<Catalog> {
  const store = bucket(env);
  const cache = useCache && typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheRequest);
    if (hit) {
      const payload = (await hit.json()) as { at: number; catalog: Catalog };
      if (Date.now() - payload.at < CACHE_TTL) return normalize(payload.catalog);
    }
  }

  const object = await store.get(CATALOG_KEY);
  let catalog: Catalog = { updatedAt: '', releases: [] };
  if (object) {
    try {
      catalog = (await object.json()) as Catalog;
    } catch (_) {
      catalog = { updatedAt: '', releases: [] };
    }
  }
  normalize(catalog);

  if (cache) {
    await cache.put(
      cacheRequest,
      new Response(JSON.stringify({ at: Date.now(), catalog }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' },
      }),
    );
  }
  return catalog;
}

export async function writeCatalog(env: Env, catalog: Catalog): Promise<void> {
  catalog.updatedAt = new Date().toISOString();
  await bucket(env).put(CATALOG_KEY, JSON.stringify(catalog, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await clearCatalogCache();
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
    if (release.draft) continue;
    if (channel === 'stable' && release.prerelease) continue;
    return release;
  }
  return null;
}

export function findRelease(
  releases: CatalogRelease[],
  platform: Platform,
  version: string,
): CatalogRelease | null {
  return releases.find((release) => release.platform === platform && release.version === version) || null;
}

export function safeFileName(value: unknown): string {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
}

export function assetKey(release: CatalogRelease, name: string): string {
  return `${ASSET_PREFIX}${release.platform}/${release.version}/${name}`;
}

export function assetContentType(name: string, provided?: string): string {
  if (provided && provided !== 'application/octet-stream') return provided;
  if (/\.apk$/i.test(name)) return 'application/vnd.android.package-archive';
  if (/\.exe$/i.test(name)) return 'application/vnd.microsoft.portable-executable';
  if (/\.zip$/i.test(name)) return 'application/zip';
  return 'application/octet-stream';
}

export function toAsset(object: R2Object, key: string, name: string, contentType: string): CatalogAsset {
  return { key, name, size: object.size, contentType };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function normalizePlatform(value: unknown): Platform | null {
  const platform = String(value || '').toLowerCase();
  return platform === 'android' || platform === 'windows' ? platform : null;
}
