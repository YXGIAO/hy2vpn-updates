import {
  assetContentType,
  assetKey,
  bucket,
  newId,
  normalizePlatform,
  readCatalog,
  safeFileName,
  sortReleases,
  StorageError,
  writeCatalog,
} from './catalog';
import type { CatalogRelease, Env, Platform } from './types';
import { adminReleaseView } from './view';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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

function summary(releases: CatalogRelease[], origin: string): Record<string, unknown> {
  const published = releases.filter((release) => !release.draft);
  const result: Record<string, unknown> = {};
  for (const platform of ['android', 'windows'] as Platform[]) {
    const platformReleases = sortReleases(published.filter((release) => release.platform === platform));
    const stable = platformReleases.find((release) => !release.prerelease) || null;
    const beta = platformReleases.find((release) => release.prerelease) || null;
    result[platform] = {
      latest: stable ? adminReleaseView(stable, origin) : null,
      beta: beta ? adminReleaseView(beta, origin) : null,
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
    storageBound: Boolean(env.RELEASES),
  });
}

async function handleState(request: Request, env: Env, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const releases = sortReleases(catalog.releases);
  return json({
    ok: true,
    storageBound: Boolean(env.RELEASES),
    releases: releases.map((release) => adminReleaseView(release, origin)),
    platforms: summary(releases, origin),
    updatedAt: catalog.updatedAt,
    checkedAt: new Date().toISOString(),
  });
}

interface ReleaseInput {
  notes: string;
  force: boolean;
  prerelease: boolean;
  draft: boolean;
  versionCode: number | null;
  title: string;
}

function parseVersionCode(value: unknown, platform: Platform | null): number | null {
  if (platform === 'windows') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

async function handleCreateRelease(request: Request, env: Env, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const body = await readJsonBody(request);
  const platform = normalizePlatform(body.platform);
  if (!platform) return fail(400, '请选择平台（android 或 windows）');
  const version = String(body.version || '').trim().replace(/^v/i, '');
  if (!VERSION_PATTERN.test(version)) {
    return fail(400, '版本号格式应为 1.2.3（可带 -beta.1 后缀）');
  }

  const catalog = await readCatalog(env, false);
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
    publishedAt: draft ? '' : now,
    createdAt: now,
    asset: null,
  };
  catalog.releases.push(release);
  await writeCatalog(env, catalog);
  return json({ ok: true, release: adminReleaseView(release, origin) }, 201);
}

async function handlePatchRelease(request: Request, env: Env, id: string, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const body = await readJsonBody(request);
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');

  if (body.notes !== undefined) release.notes = String(body.notes).slice(0, 20000);
  if (body.title !== undefined) {
    release.title = String(body.title).trim().slice(0, 200) || release.title;
  }
  if (body.force !== undefined) release.force = body.force === true;
  if (body.prerelease !== undefined) release.prerelease = body.prerelease === true;
  if (body.draft !== undefined) release.draft = body.draft === true;
  if (body.versionCode !== undefined) {
    release.versionCode = parseVersionCode(body.versionCode, release.platform);
  }
  if (!release.draft && !release.publishedAt) release.publishedAt = new Date().toISOString();

  await writeCatalog(env, catalog);
  return json({ ok: true, release: adminReleaseView(release, origin) });
}

async function handleDeleteRelease(request: Request, env: Env, id: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');
  if (release.asset) {
    await bucket(env).delete(release.asset.key);
  }
  catalog.releases = catalog.releases.filter((item) => item.id !== id);
  await writeCatalog(env, catalog);
  return json({ ok: true, deleted: id });
}

async function handleStartUpload(request: Request, env: Env, id: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');

  const body = await readJsonBody(request);
  const name = safeFileName(body.name);
  if (!name) return fail(400, '缺少安装包文件名');
  const contentType = assetContentType(name, String(body.contentType || ''));
  const key = assetKey(release, name);
  const upload = await bucket(env).createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: { releaseId: release.id },
  });
  return json({ ok: true, uploadId: upload.uploadId, name, key }, 201);
}

function uploadContext(env: Env, id: string, catalogRelease: CatalogRelease | undefined, url: URL) {
  if (!catalogRelease) throw new StorageError('版本不存在', 404);
  const name = safeFileName(url.searchParams.get('name'));
  if (!name) throw new StorageError('缺少安装包文件名', 400);
  return { name, key: assetKey(catalogRelease, name) };
}

async function handleUploadPart(
  request: Request,
  env: Env,
  id: string,
  uploadId: string,
  partNumber: number,
  url: URL,
): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  const { key } = uploadContext(env, id, release, url);
  if (!partNumber || partNumber < 1 || partNumber > 10000) return fail(400, '分片序号无效');
  if (!request.body) return fail(400, '分片内容为空');

  try {
    const upload = bucket(env).resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
  } catch (_) {
    return fail(400, '上传会话不存在或已过期，请重新上传');
  }
}

async function handleCompleteUpload(
  request: Request,
  env: Env,
  id: string,
  uploadId: string,
  url: URL,
  origin: string,
): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const body = await readJsonBody(request);
  const parts = Array.isArray(body.parts)
    ? (body.parts as Array<{ partNumber: number; etag: string }>)
        .filter((part) => Number(part.partNumber) > 0 && typeof part.etag === 'string')
        .map((part) => ({ partNumber: Number(part.partNumber), etag: part.etag }))
    : [];
  if (!parts.length) return fail(400, '缺少分片信息');

  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  const { name, key } = uploadContext(env, id, release, url);
  if (!release) return fail(404, '版本不存在');

  try {
    const upload = bucket(env).resumeMultipartUpload(key, uploadId);
    await upload.complete(parts);
  } catch (_) {
    return fail(400, '合并安装包失败，请重新上传');
  }

  const object = await bucket(env).head(key);
  if (!object) return fail(502, '安装包合并后未找到文件，请重试');
  if (release.asset && release.asset.key !== key) {
    await bucket(env).delete(release.asset.key);
  }
  release.asset = {
    key,
    name,
    size: object.size,
    contentType: assetContentType(name, object.httpMetadata?.contentType),
  };
  await writeCatalog(env, catalog);
  return json({ ok: true, release: adminReleaseView(release, origin) });
}

async function handleAbortUpload(
  request: Request,
  env: Env,
  id: string,
  uploadId: string,
  url: URL,
): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');
  const name = safeFileName(url.searchParams.get('name'));
  if (name) {
    try {
      await bucket(env).resumeMultipartUpload(assetKey(release, name), uploadId).abort();
    } catch (_) { /* ignore */ }
  }
  return json({ ok: true });
}

async function handleDeleteAsset(request: Request, env: Env, id: string, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const catalog = await readCatalog(env, false);
  const release = catalog.releases.find((item) => item.id === id);
  if (!release) return fail(404, '版本不存在');
  if (release.asset) {
    await bucket(env).delete(release.asset.key);
    release.asset = null;
    await writeCatalog(env, catalog);
  }
  return json({ ok: true, release: adminReleaseView(release, origin) });
}

export async function handleAdmin(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/api/v1/admin/session' && request.method === 'POST') {
      return await handleSession(request, env);
    }
    if (path === '/api/v1/admin/state' && request.method === 'GET') {
      return await handleState(request, env, origin);
    }
    if (path === '/api/v1/admin/releases' && request.method === 'POST') {
      return await handleCreateRelease(request, env, origin);
    }

    const partMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/uploads\/([^/]+)\/parts\/(\d+)\/?$/);
    if (partMatch && request.method === 'PUT') {
      return await handleUploadPart(
        request,
        env,
        partMatch[1],
        decodeURIComponent(partMatch[2]),
        Number(partMatch[3]),
        url,
      );
    }

    const completeMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/uploads\/([^/]+)\/complete\/?$/);
    if (completeMatch && request.method === 'POST') {
      return await handleCompleteUpload(
        request,
        env,
        completeMatch[1],
        decodeURIComponent(completeMatch[2]),
        url,
        origin,
      );
    }

    const abortMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/uploads\/([^/]+)\/?$/);
    if (abortMatch && request.method === 'DELETE') {
      return await handleAbortUpload(request, env, abortMatch[1], decodeURIComponent(abortMatch[2]), url);
    }

    const uploadMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/uploads\/?$/);
    if (uploadMatch && request.method === 'POST') {
      return await handleStartUpload(request, env, uploadMatch[1]);
    }

    const assetMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/asset\/?$/);
    if (assetMatch && request.method === 'DELETE') {
      return await handleDeleteAsset(request, env, assetMatch[1], origin);
    }

    const releaseMatch = path.match(/^\/api\/v1\/admin\/releases\/([\w-]+)\/?$/);
    if (releaseMatch) {
      const id = releaseMatch[1];
      if (request.method === 'PATCH') return await handlePatchRelease(request, env, id, origin);
      if (request.method === 'DELETE') return await handleDeleteRelease(request, env, id);
      return fail(405, '不支持的请求方法');
    }

    return fail(404, '管理接口不存在');
  } catch (error) {
    if (error instanceof StorageError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '管理操作失败');
  }
}
