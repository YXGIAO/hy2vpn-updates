import type { Env, Platform, UpdateAsset, UpdateRelease } from './types';

export const DEFAULT_REPO = 'YXGIAO/hy2vpn-updates';

interface GhAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
  download_count: number;
}

interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  assets: GhAsset[];
}

export class UpstreamError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export function repoName(env: Env): string {
  return (env.GITHUB_REPO || DEFAULT_REPO).trim();
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

function stripMetadata(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(force|versionCode)\s*[:=]/i.test(line) && !/^\s*\[force\]\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metadata(body: string, key: string): string {
  const match = body.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

function pickAsset(platform: Platform, assets: GhAsset[]): GhAsset | null {
  if (platform === 'android') {
    return assets.find((asset) => /\.apk$/i.test(asset.name)) ?? null;
  }
  return (
    assets.find((asset) => /setup.*\.exe$/i.test(asset.name)) ??
    assets.find((asset) => /\.exe$/i.test(asset.name)) ??
    assets.find((asset) => /\.zip$/i.test(asset.name)) ??
    null
  );
}

function toRelease(raw: GhRelease): UpdateRelease | null {
  if (raw.draft) return null;
  const tag = String(raw.tag_name || '').trim();
  const match = tag.match(/^(android|windows)-(.+)$/i);
  if (!match) return null;
  const platform = match[1].toLowerCase() as Platform;
  const version = match[2].replace(/^v/i, '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null;

  const body = raw.body || '';
  const forceValue = metadata(body, 'force').toLowerCase();
  const versionCode = Number(metadata(body, 'versionCode')) || null;
  const assets: UpdateAsset[] = raw.assets.map((asset) => ({
    name: asset.name,
    size: asset.size,
    url: asset.browser_download_url,
  }));
  const primary = pickAsset(platform, raw.assets);

  return {
    id: raw.id,
    platform,
    version,
    tag,
    title: (raw.name || `${platform === 'android' ? 'Android' : 'Windows'} ${version}`).trim(),
    notes: stripMetadata(body),
    publishedAt: raw.published_at || '',
    prerelease: raw.prerelease || version.includes('-'),
    force: forceValue === 'true' || forceValue === '1' || forceValue === 'yes' || /\[force\]/i.test(body),
    versionCode,
    pageUrl: raw.html_url,
    assets,
    primary: primary ? { name: primary.name, size: primary.size, url: primary.browser_download_url } : null,
  };
}

function sortReleases(list: UpdateRelease[]): UpdateRelease[] {
  return [...list].sort((left, right) => {
    const diff = compareVersions(right.version, left.version);
    if (diff !== 0) return diff;
    return (right.publishedAt || '').localeCompare(left.publishedAt || '');
  });
}

export async function listReleases(env: Env): Promise<UpdateRelease[]> {
  const repo = repoName(env);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://hy2vpn-updates.internal/releases/${repo}`);
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) {
    const payload = (await cached.json()) as { at: number; list: UpdateRelease[] };
    if (Date.now() - payload.at < 120_000) return payload.list;
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'HY2VPN-Updates/1.0',
    'x-github-api-version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
    if (!response.ok) {
      const rateLimited = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
      if (rateLimited) {
        throw new UpstreamError('GitHub API 请求频率受限，请在 Pages 设置中配置 GITHUB_TOKEN', 502);
      }
      if (response.status === 404) throw new UpstreamError(`GitHub 仓库不存在：${repo}`, 502);
      if (response.status === 401) throw new UpstreamError('GITHUB_TOKEN 无效或已过期', 502);
      throw new UpstreamError(`GitHub API 返回 ${response.status}`, 502);
    }
    const raw = (await response.json()) as GhRelease[];
    const list = sortReleases(raw.map(toRelease).filter((item): item is UpdateRelease => item !== null));
    if (cache) {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify({ at: Date.now(), list }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' },
        }),
      );
    }
    return list;
  } catch (error) {
    if (cached) {
      const payload = (await cached.json()) as { at: number; list: UpdateRelease[] };
      return payload.list;
    }
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('无法连接 GitHub API，请稍后重试', 502);
  }
}

export function latestFor(
  releases: UpdateRelease[],
  platform: Platform,
  channel: 'stable' | 'beta',
): UpdateRelease | null {
  for (const release of releases) {
    if (release.platform !== platform) continue;
    if (channel === 'stable' && release.prerelease) continue;
    return release;
  }
  return null;
}
