import { handleAdmin } from './admin';
import {
  compareVersions,
  latestFor,
  readCatalog,
  StorageError,
} from './catalog';
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
  const catalog = await readCatalog(env);
  const release = latestFor(catalog.releases, platform, channel);
  if (!release) {
    return json({
      ok: true,
      platform,
      channel,
      current: current || null,
      updateAvailable: false,
      release: null,
      reason: '更新服务尚未发布该平台的版本',
      checkedAt: new Date().toISOString(),
    });
  }
  const updateAvailable = current ? compareVersions(release.version, current) > 0 : true;
  return json({
    ok: true,
    platform,
    channel,
    current: current || null,
    updateAvailable,
    release: releaseView(release),
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
  const catalog = await readCatalog(env);
  const filtered = catalog.releases.filter((release) => {
    if (release.draft || !release.downloadUrl) return false;
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
    releases: filtered.map((release) => releaseView(release)),
  });
}

async function handleInfo(env: Env, url: URL): Promise<Response> {
  const catalog = await readCatalog(env);
  const platforms: Record<string, unknown> = {};
  for (const platform of PLATFORMS) {
    const stable = latestFor(catalog.releases, platform, 'stable');
    const beta = latestFor(catalog.releases, platform, 'beta');
    platforms[platform] = {
      latest: stable ? releaseView(stable) : null,
      beta: beta ? releaseView(beta) : null,
      checkUrl: `${url.origin}/api/v1/updates/latest?platform=${platform}&channel=stable&current=<当前版本>`,
    };
  }
  return json({
    ok: true,
    service: 'hy2vpn-updates',
    storage: 'KV 版本清单',
    totalReleases: catalog.releases.filter((release) => !release.draft && release.downloadUrl).length,
    platforms,
    conventions: {
      stable: '普通版本',
      beta: '预发布（Beta）',
      draft: '草稿，不对外可见',
      force: '在管理后台中开启「强制更新」',
      versionCode: 'Android 版本的 versionCode',
      downloadUrl: '后台手动填写的安装包直链',
    },
    checkedAt: new Date().toISOString(),
  });
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/v1/admin/')) {
    return handleAdmin(request, env);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, '不支持的请求方法');

  try {
    if (url.pathname === '/api/v1/updates/health') {
      return json({
        ok: true,
        service: 'hy2vpn-updates',
        storage: env.CATALOG ? 'KV 版本清单' : 'unbound',
        storageBound: Boolean(env.CATALOG),
        adminConfigured: Boolean(env.ADMIN_TOKEN),
        serverTime: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/v1/updates/info') return await handleInfo(env, url);
    if (url.pathname === '/api/v1/updates/latest') return await handleLatest(env, url);
    if (url.pathname === '/api/v1/updates/releases') return await handleReleases(env, url);
    return fail(404, '接口不存在');
  } catch (error) {
    if (error instanceof StorageError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '更新服务异常');
  }
}
