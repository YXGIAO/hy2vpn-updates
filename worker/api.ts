import { handleAdmin } from './admin';
import {
  bucket,
  compareVersions,
  findRelease,
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
      reason: '更新服务尚未发布该平台的安装包',
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
    release: releaseView(release, url.origin),
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
    if (release.draft) return false;
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
  const catalog = await readCatalog(env);
  const platforms: Record<string, unknown> = {};
  for (const platform of PLATFORMS) {
    const stable = latestFor(catalog.releases, platform, 'stable');
    const beta = latestFor(catalog.releases, platform, 'beta');
    platforms[platform] = {
      latest: stable ? releaseView(stable, url.origin) : null,
      beta: beta ? releaseView(beta, url.origin) : null,
      checkUrl: `${url.origin}/api/v1/updates/latest?platform=${platform}&channel=stable&current=<当前版本>`,
    };
  }
  return json({
    ok: true,
    service: 'hy2vpn-updates',
    storage: 'Cloudflare R2',
    totalReleases: catalog.releases.filter((release) => !release.draft).length,
    platforms,
    conventions: {
      stable: '普通版本',
      beta: '预发布（Beta）',
      draft: '草稿，不对外可见',
      force: '在管理后台中开启「强制更新」',
      versionCode: 'Android 版本的 versionCode',
    },
    checkedAt: new Date().toISOString(),
  });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function handleDownload(env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/api\/v1\/updates\/download\/(android|windows)\/([^/]+)\/?$/i);
  if (!match) return fail(404, '下载地址不存在');
  const platform = match[1].toLowerCase() as Platform;
  const version = decodeURIComponent(match[2]);
  const catalog = await readCatalog(env);
  const release = version.toLowerCase() === 'latest'
    ? latestFor(catalog.releases, platform, 'stable')
    : findRelease(catalog.releases, platform, version);
  if (!release || release.draft) return fail(404, '没有找到对应版本');
  if (!release.asset) return fail(404, '该版本没有可下载的安装包');

  const object = await bucket(env).get(release.asset.key);
  if (!object) return fail(404, '安装包文件不存在，请重新上传');
  const headers: Record<string, string> = {
    ...CORS,
    'content-type': release.asset.contentType || 'application/octet-stream',
    'content-length': String(object.size),
    'content-disposition': contentDisposition(release.asset.name),
    'cache-control': 'public, max-age=3600',
    etag: object.httpEtag,
    'accept-ranges': 'none',
  };
  return new Response(object.body, { status: 200, headers });
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
        storage: env.RELEASES ? 'Cloudflare R2' : 'unbound',
        storageBound: Boolean(env.RELEASES),
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
    if (error instanceof StorageError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '更新服务异常');
  }
}
