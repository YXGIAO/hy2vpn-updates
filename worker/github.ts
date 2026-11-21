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
    .filter((line) => !/^\s*(force|versionCode|latest|preview)\s*[:=]/i.test(line) && !/^\s*\[force\]\s*$/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metadata(body: string, key: string): string {
  const match = body.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

export function readReleaseMetadata(body: string | null): { force: boolean; versionCode: number | null } {
  const text = body || '';
  const forceValue = metadata(text, 'force').toLowerCase();
  return {
    force: forceValue === 'true' || forceValue === '1' || forceValue === 'yes' || /\[force\]/i.test(text),
    versionCode: Number(metadata(text, 'versionCode')) || null,
  };
}

export function cleanReleaseNotes(body: string | null): string {
  return stripMetadata(body || '');
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

function toRelease(raw: GhRelease, includeDrafts = false): UpdateRelease | null {
  if (raw.draft && !includeDrafts) return null;
  const tag = String(raw.tag_name || '').trim();
  const match = tag.match(/^(android|windows)-(.+)$/i);
  if (!match) return null;
  const platform = match[1].toLowerCase() as Platform;
  const version = match[2].replace(/^v/i, '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null;

  const body = raw.body || '';
  const flags = readReleaseMetadata(body);
  const assets: UpdateAsset[] = raw.assets.map((asset) => ({
    id: asset.id,
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
    draft: Boolean(raw.draft),
    force: flags.force,
    versionCode: flags.versionCode,
    pageUrl: raw.html_url,
    assets,
    primary: primary
      ? {
          id: primary.id,
          name: primary.name,
          size: primary.size,
          url: primary.browser_download_url,
        }
      : null,
  };
}

function sortReleases(list: UpdateRelease[]): UpdateRelease[] {
  return [...list].sort((left, right) => {
    const diff = compareVersions(right.version, left.version);
    if (diff !== 0) return diff;
    return (right.publishedAt || '').localeCompare(left.publishedAt || '');
  });
}

function cacheKey(env: Env): Request {
  return new Request(`https://hy2vpn-updates.internal/releases/${repoName(env)}`);
}

export async function clearReleasesCache(env: Env): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.default.delete(cacheKey(env));
}

export async function listReleases(env: Env): Promise<UpdateRelease[]> {
  const repo = repoName(env);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = cacheKey(env);
  const cached = cache ? await cache.match(key) : null;
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
    const list = sortReleases(raw.map((item) => toRelease(item)).filter((item): item is UpdateRelease => item !== null));
    if (cache) {
      await cache.put(
        key,
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

export interface RawGithubRelease {
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

export async function listAdminReleases(env: Env): Promise<UpdateRelease[]> {
  if (!env.GITHUB_TOKEN) {
    throw new UpstreamError('未配置 GITHUB_TOKEN，管理页面无法读写版本', 503);
  }
  const raw = await githubJson<RawGithubRelease[]>(env, `/repos/${repoName(env)}/releases?per_page=100`);
  return sortReleases(
    raw.map((item) => toRelease(item, true)).filter((item): item is UpdateRelease => item !== null),
  );
}

export async function fetchGithubRelease(env: Env, id: number): Promise<RawGithubRelease> {
  return githubJson<RawGithubRelease>(env, `/repos/${repoName(env)}/releases/${id}`);
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

export async function githubJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.GITHUB_TOKEN) {
    throw new UpstreamError('未配置 GITHUB_TOKEN，无法执行管理操作', 503);
  }
  const token = env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'HY2VPN-Updates/1.0',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `GitHub API 返回 ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch (_) { /* ignore */ }
    if (response.status === 401) message = 'GITHUB_TOKEN 无效或权限不足';
    if (response.status === 404) message = '仓库或版本不存在';
    throw new UpstreamError(message, response.status === 422 ? 400 : 502);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export function composeReleaseBody(notes: string, force: boolean, versionCode: number | null): string {
  const parts = [String(notes || '').trim()];
  if (force) parts.push('force=true');
  if (versionCode && versionCode > 0) parts.push(`versionCode=${versionCode}`);
  return parts.filter(Boolean).join('\n\n');
}

interface ReleaseWriteInput {
  notes: string;
  force: boolean;
  prerelease: boolean;
  versionCode: number | null;
  name: string;
  draft?: boolean;
}

export async function createGithubRelease(
  env: Env,
  input: ReleaseWriteInput & { tag: string },
): Promise<{ id: number; html_url: string; tag_name: string }> {
  const release = await githubJson<{ id: number; html_url: string; tag_name: string }>(
    env,
    `/repos/${repoName(env)}/releases`,
    {
      method: 'POST',
      body: JSON.stringify({
        tag_name: input.tag,
        target_commitish: 'main',
        name: input.name,
        body: composeReleaseBody(input.notes, input.force, input.versionCode),
        draft: input.draft === true,
        prerelease: input.prerelease,
      }),
    },
  );
  await clearReleasesCache(env);
  return release;
}

export async function updateGithubRelease(
  env: Env,
  id: number,
  input: ReleaseWriteInput,
): Promise<void> {
  await githubJson(env, `/repos/${repoName(env)}/releases/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: input.name,
      body: composeReleaseBody(input.notes, input.force, input.versionCode),
      prerelease: input.prerelease,
      ...(input.draft === undefined ? {} : { draft: input.draft }),
    }),
  });
  await clearReleasesCache(env);
}

export async function deleteGithubRelease(env: Env, id: number): Promise<void> {
  const repo = repoName(env);
  const release = await githubJson<{ tag_name: string }>(env, `/repos/${repo}/releases/${id}`);
  await githubJson(env, `/repos/${repo}/releases/${id}`, { method: 'DELETE' });
  if (release && release.tag_name) {
    await fetch(`https://api.github.com/repos/${repo}/git/refs/tags/${encodeURIComponent(release.tag_name)}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'HY2VPN-Updates/1.0',
        'x-github-api-version': '2022-11-28',
      },
    }).catch(() => null);
  }
  await clearReleasesCache(env);
}

export async function deleteGithubAsset(env: Env, assetId: number): Promise<void> {
  await githubJson(env, `/repos/${repoName(env)}/releases/assets/${assetId}`, { method: 'DELETE' });
  await clearReleasesCache(env);
}

export async function uploadGithubAsset(
  env: Env,
  releaseId: number,
  name: string,
  body: ReadableStream | null,
  contentType: string,
  contentLength: string,
): Promise<{ id: number; name: string; size: number }> {
  if (!env.GITHUB_TOKEN) {
    throw new UpstreamError('未配置 GITHUB_TOKEN，无法上传安装包', 503);
  }
  const url = `https://uploads.github.com/repos/${repoName(env)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'content-type': contentType || 'application/octet-stream',
    'user-agent': 'HY2VPN-Updates/1.0',
  };
  if (contentLength) headers['content-length'] = contentLength;
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    let message = `上传失败（${response.status}）`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch (_) { /* ignore */ }
    if (response.status === 422) message = '该版本已存在同名安装包，请先删除旧文件';
    throw new UpstreamError(message, 502);
  }
  await clearReleasesCache(env);
  return JSON.parse(text) as { id: number; name: string; size: number };
}
