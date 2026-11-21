import {
  newId,
  normalizeDownloadUrl,
  normalizePlatform,
  readCatalog,
  sortReleases,
  StorageError,
  writeCatalog,
} from './catalog';
import type { CatalogRelease, Env, Platform } from './types';
import { adminReleaseView } from './view';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function bearer(request: Request): string {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

function checkToken(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return fail(503, '未配置 ADMIN_TOKEN，请先在 Pages 设置中添加管理口令');
  }
  if (!timingSafeEqual(bearer(request), env.ADMIN_TOKEN)) {
    return fail(401, '管理口令错误');
  }
  return null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (_) {
    throw new StorageError('请求内容不是合法的 JSON', 400);
  }
}

function summary(releases: CatalogRelease[]): Record<string, unknown> {
  const published = releases.filter((release) => !release.draft && release.downloadUrl);
  const result: Record<string, unknown> = {};
  for (const platform of ['android', 'windows'] as Platform[]) {
    const platformReleases = sortReleases(published.filter((release) => release.platform === platform));
    const stable = platformReleases.find((release) => !release.prerelease) || null;
    const beta = platformReleases.find((release) => release.prerelease) || null;
    result[platform] = {
      latest: stable ? adminReleaseView(stable) : null,
      beta: beta ? adminReleaseView(beta) : null,
    };
  }
  return result;
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  let token = '';
  try {
    const body = await readJsonBody(request);
    token = String(body.token || '').trim();
  } catch (_) {
    token = '';
  }
  if (!env.ADMIN_TOKEN) {
    return fail(503, '未配置 ADMIN_TOKEN，请先在 Pages 设置中添加管理口令');
  }
  if (!timingSafeEqual(token || bearer(request), env.ADMIN_TOKEN)) {
    return fail(401, '管理口令错误');
  }
  return json({
    ok: true,
    storageBound: Boolean(env.CATALOG),
  });
}

async function handleState(request: Request, env: Env): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env);
  const releases = sortReleases(catalog.releases);
  return json({
    ok: true,
    storageBound: Boolean(env.CATALOG),
    releases: releases.map((release) => adminReleaseView(release)),
    platforms: summary(releases),
    updatedAt: catalog.updatedAt,
    checkedAt: new Date().toISOString(),
  });
}

function parseVersionCode(value: unknown, platform: Platform | null): number | null {
  if (platform === 'windows') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

async function handleCreateRelease(request: Request, env: Env): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const body = await readJsonBody(request);
  const platform = normalizePlatform(body.platform);
  if (!platform) return fail(400, '请选择平台（android 或 windows）');
  const version = String(body.version || '').trim().replace(/^v/i, '');
  if (!VERSION_PATTERN.test(version)) {
    return fail(400, '版本号格式应为 1.2.3（可带 -beta.1 后缀）');
  }
  const downloadUrl = normalizeDownloadUrl(body.downloadUrl);
  if (!downloadUrl) {
    return fail(400, '请填写安装包下载链接（http:// 或 https:// 开头）');
  }

  const catalog = await readCatalog(env);
  if (catalog.releases.some((item) => item.platform === platform && item.version === version)) {
    return fail(409, `${platform} ${version} 已存在，请直接编辑或先删除旧版本`);
  }
  const versionCode = parseVersionCode(body.versionCode, platform);
  if (platform === 'android' && !versionCode) {
    return fail(400, 'Android 版本必须填写 versionCode（例如 14）');
  }

  const now = new Date().toISOString();
  const draft = body.draft === true;
  const release: CatalogRelease = {
    id: newId(),
    platform,
    version,
    title: String(body.title || '').trim().slice(0, 200) ||
      `${platform === 'android' ? 'Android' : 'Windows'} ${version}`,
    notes: String(body.notes || '').slice(0, 20000),
    force: body.force === true,
    versionCode,
    prerelease: body.prerelease === true,
    draft,
    downloadUrl,
    publishedAt: draft ? '' : now,
    createdAt: now,
  };
  catalog.releases.push(release);
  await writeCatalog(env, catalog);
  return json({ ok: true, release: adminReleaseView(release) }, 201);
}

async function handlePatchRelease(request: Request, env: Env, id: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const body = await readJsonBody(request);
  const catalog = await readCatalog(env);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');

  if (body.notes !== undefined) release.notes = String(body.notes).slice(0, 20000);
  if (body.title !== undefined) {
    release.title = String(body.title).trim().slice(0, 200) || release.title;
  }
  if (body.downloadUrl !== undefined) {
    const downloadUrl = normalizeDownloadUrl(body.downloadUrl);
    if (!downloadUrl) return fail(400, '下载链接格式不正确（http:// 或 https:// 开头）');
    release.downloadUrl = downloadUrl;
  }
  if (body.force !== undefined) release.force = body.force === true;
  if (body.prerelease !== undefined) release.prerelease = body.prerelease === true;
  if (body.draft !== undefined) release.draft = body.draft === true;
  if (body.versionCode !== undefined) {
    release.versionCode = parseVersionCode(body.versionCode, release.platform);
  }
  if (!release.draft && !release.publishedAt) release.publishedAt = new Date().toISOString();

  await writeCatalog(env, catalog);
  return json({ ok: true, release: adminReleaseView(release) });
}

async function handleDeleteRelease(request: Request, env: Env, id: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env);
  if (!catalog.releases.some((item) => item.id === id)) return fail(404, '版本不存在');
  catalog.releases = catalog.releases.filter((item) => item.id !== id);
  await writeCatalog(env, catalog);
  return json({ ok: true, deleted: id });
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/api/v1/admin/session' && request.method === 'POST') {
      return await handleSession(request, env);
    }
    if (path === '/api/v1/admin/state' && request.method === 'GET') {
      return await handleState(request, env);
    }
    if (path === '/api/v1/admin/releases' && request.method === 'POST') {
      return await handleCreateRelease(request, env);
    }

    const releaseMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/?$/);
    if (releaseMatch) {
      if (request.method === 'PATCH') return await handlePatchRelease(request, env, releaseMatch[1]);
      if (request.method === 'DELETE') return await handleDeleteRelease(request, env, releaseMatch[1]);
      return fail(405, '不支持的请求方法');
    }

    return fail(404, '管理接口不存在');
  } catch (error) {
    if (error instanceof StorageError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '管理操作失败');
  }
}
