import { compareVersions, listReleases, latestFor, repoName, UpstreamError } from './github';
import { handleAdmin } from './admin';
import type { Env, Platform } from './types';
import { releaseView } from './view';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const PLATFORMS: Platform[] = ['android', 'windows'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
    },
  });
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function normalizePlatform(value: string | null): Platform | null {
  const platform = String(value || '').toLowerCase();
  return platform === 'android' || platform === 'windows' ? platform : null;
}

function normalizeChannel(value: string | null): 'stable' | 'beta' {
  return String(value || '').toLowerCase() === 'beta' ? 'beta' : 'stable';
}

async function handleLatest(env: Env, url: URL): Promise<Response> {
  const platform = normalizePlatform(url.searchParams.get('platform'));
  if (!platform) return fail(400, 'platform 仅支持 android 或 windows');
  const channel = normalizeChannel(url.searchParams.get('channel'));
  const current = String(url.searchParams.get('current') || '').trim().slice(0, 32);
  const releases = await listReleases(env);
  const release = latestFor(releases, platform, channel);
  if (!release) {
    return json({
      ok: true,
      platform,
      channel,
      current: current || null,
      updateAvailable: false,
      release: null,
      reason: '更新服务尚未发布该平台的安装包',
      checkedAt: new Date().toISOString(),
    });
  }
  const updateAvailable = current ? compareVersions(release.version, current) > 0 : true;
  const origin = url.origin;
  return json({
    ok: true,
    platform,
    channel,
    current: current || null,
    updateAvailable,
    release: releaseView(release, origin),
    checkedAt: new Date().toISOString(),
  });
}

async function handleReleases(env: Env, url: URL): Promise<Response> {
  const platformValue = String(url.searchParams.get('platform') || 'all').toLowerCase();
  if (platformValue !== 'all' && platformValue !== 'android' && platformValue !== 'windows') {
    return fail(400, 'platform 仅支持 all、android 或 windows');
  }
  const channelValue = String(url.searchParams.get('channel') || 'all').toLowerCase();
  if (channelValue !== 'all' && channelValue !== 'stable' && channelValue !== 'beta') {
    return fail(400, 'channel 仅支持 all、stable 或 beta');
  }
  const releases = await listReleases(env);
  const filtered = releases.filter((release) => {
    if (platformValue !== 'all' && release.platform !== platformValue) return false;
    if (channelValue === 'stable' && release.prerelease) return false;
    if (channelValue === 'beta' && !release.prerelease) return false;
    return true;
  });
  return json({
    ok: true,
    platform: platformValue,
    channel: channelValue,
    count: filtered.length,
    releases: filtered.map((release) => releaseView(release, url.origin)),
  });
}

async function handleInfo(env: Env, url: URL): Promise<Response> {
  const releases = await listReleases(env);
  const origin = url.origin;
  const platforms: Record<string, unknown> = {};
  for (const platform of PLATFORMS) {
    const stable = latestFor(releases, platform, 'stable');
    const beta = latestFor(releases, platform, 'beta');
    platforms[platform] = {
      latest: stable ? releaseView(stable, origin) : null,
      beta: beta ? releaseView(beta, origin) : null,
      checkUrl: `${origin}/api/v1/updates/latest?platform=${platform}&channel=stable&current=<当前版本>`,
    };
  }
  return json({
    ok: true,
    service: 'hy2vpn-updates',
    repo: repoName(env),
    totalReleases: releases.length,
    platforms,
    conventions: {
      androidTag: 'android-v1.9.0',
      windowsTag: 'windows-v1.4.0',
      stable: '普通 Release',
      beta: '勾选 Pre-release',
      force: '在 Release 说明中单独一行写 force=true',
      versionCode: '在 Release 说明中单独一行写 versionCode=13（Android）',
    },
    checkedAt: new Date().toISOString(),
  });
}

async function handleDownload(env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/api\/v1\/updates\/download\/(android|windows)\/([^/]+)\/?$/i);
  if (!match) return fail(404, '下载地址不存在');
  const platform = match[1].toLowerCase() as Platform;
  const version = decodeURIComponent(match[2]);
  const releases = await listReleases(env);
  const release = version.toLowerCase() === 'latest'
    ? latestFor(releases, platform, 'stable')
    : releases.find((item) => item.platform === platform && item.version === version) || null;
  if (!release) return fail(404, '没有找到对应版本');
  if (!release.primary) return fail(404, '该版本没有可下载的安装包');
  return new Response(null, {
    status: 302,
    headers: {
      ...CORS,
      location: release.primary.url,
      'cache-control': 'no-store',
    },
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/v1/admin/')) {
    return handleAdmin(request, env, url.origin);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, '不支持的请求方法');

  try {
    if (url.pathname === '/api/v1/updates/health') {
      return json({
        ok: true,
        service: 'hy2vpn-updates',
        repo: repoName(env),
        tokenConfigured: Boolean(env.GITHUB_TOKEN),
        adminConfigured: Boolean(env.ADMIN_TOKEN),
        serverTime: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/v1/updates/info') return await handleInfo(env, url);
    if (url.pathname === '/api/v1/updates/latest') return await handleLatest(env, url);
    if (url.pathname === '/api/v1/updates/releases') return await handleReleases(env, url);
    if (url.pathname.startsWith('/api/v1/updates/download/')) return await handleDownload(env, url);
    return fail(404, '接口不存在');
  } catch (error) {
    if (error instanceof UpstreamError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '更新服务异常');
  }
}
