import {
  cleanReleaseNotes,
  createGithubRelease,
  deleteGithubAsset,
  deleteGithubRelease,
  fetchGithubRelease,
  latestFor,
  listAdminReleases,
  readReleaseMetadata,
  repoName,
  updateGithubRelease,
  uploadGithubAsset,
  UpstreamError,
} from './github';
import type { Env, Platform, UpdateRelease } from './types';
import { adminReleaseView } from './view';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

const MAX_UPLOAD = 95 * 1024 * 1024;
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

function normalizePlatform(value: unknown): Platform | null {
  const platform = String(value || '').toLowerCase();
  return platform === 'android' || platform === 'windows' ? platform : null;
}

function platformSummary(releases: UpdateRelease[], origin: string): Record<string, unknown> {
  const published = releases.filter((release) => !release.draft);
  const result: Record<string, unknown> = {};
  for (const platform of ['android', 'windows'] as Platform[]) {
    const stable = latestFor(published, platform, 'stable');
    const beta = latestFor(published, platform, 'beta');
    result[platform] = {
      latest: stable ? adminReleaseView(stable, origin) : null,
      beta: beta ? adminReleaseView(beta, origin) : null,
    };
  }
  return result;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (_) {
    throw new UpstreamError('请求内容不是合法的 JSON', 400);
  }
}

function cleanName(value: unknown): string {
  return String(value || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
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
    repo: repoName(env),
    writeConfigured: Boolean(env.GITHUB_TOKEN),
    maxUploadMB: Math.floor(MAX_UPLOAD / 1024 / 1024),
  });
}

async function handleState(request: Request, env: Env, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  const releases = await listAdminReleases(env);
  return json({
    ok: true,
    repo: repoName(env),
    writeConfigured: Boolean(env.GITHUB_TOKEN),
    maxUploadMB: Math.floor(MAX_UPLOAD / 1024 / 1024),
    releases: releases.map((release) => adminReleaseView(release, origin)),
    platforms: platformSummary(releases, origin),
    checkedAt: new Date().toISOString(),
  });
}

interface ReleaseInput {
  notes: string;
  force: boolean;
  prerelease: boolean;
  draft: boolean;
  versionCode: number | null;
  title: string | null;
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
  const tag = `${platform}-v${version}`;
  const existing = await listAdminReleases(env);
  if (existing.some((release) => release.tag.toLowerCase() === tag.toLowerCase())) {
    return fail(409, `版本 ${tag} 已存在，请直接编辑或先删除旧版本`);
  }

  const versionCodeValue = Number(body.versionCode);
  const input: ReleaseInput & { tag: string } = {
    tag,
    notes: String(body.notes || '').slice(0, 20000),
    force: body.force === true,
    prerelease: body.prerelease === true,
    draft: body.draft === true,
    versionCode:
      platform === 'android' && Number.isFinite(versionCodeValue) && versionCodeValue > 0
        ? Math.floor(versionCodeValue)
        : null,
    title: String(body.title || '').trim().slice(0, 200) || null,
  };
  if (platform === 'android' && !input.versionCode) {
    return fail(400, 'Android 版本必须填写 versionCode（例如 14）');
  }

  const created = await createGithubRelease(env, {
    ...input,
    name: input.title || `${platform === 'android' ? 'Android' : 'Windows'} ${version}`,
  });
  return json({
    ok: true,
    release: { id: created.id, tag: created.tag_name, pageUrl: created.html_url },
  }, 201);
}

async function handlePatchRelease(request: Request, env: Env, id: number, origin: string): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const body = await readJsonBody(request);
  const raw = await fetchGithubRelease(env, id);
  const current = readReleaseMetadata(raw.body);
  const notes = body.notes === undefined ? cleanReleaseNotes(raw.body) : String(body.notes).slice(0, 20000);
  const force = body.force === undefined ? current.force : body.force === true;
  const prerelease = body.prerelease === undefined ? Boolean(raw.prerelease) : body.prerelease === true;
  const draft = body.draft === undefined ? Boolean(raw.draft) : body.draft === true;
  const versionCodeValue = Number(body.versionCode);
  const versionCode =
    body.versionCode === undefined
      ? current.versionCode
      : Number.isFinite(versionCodeValue) && versionCodeValue > 0
        ? Math.floor(versionCodeValue)
        : null;
  const title = body.title === undefined ? raw.name : String(body.title).trim().slice(0, 200) || raw.name;

  await updateGithubRelease(env, id, {
    notes,
    force,
    prerelease,
    versionCode,
    name: title || raw.tag_name,
    draft,
  });

  const releases = await listAdminReleases(env);
  const updated = releases.find((release) => release.id === id);
  return json({ ok: true, release: updated ? adminReleaseView(updated, origin) : null });
}

async function handleDeleteRelease(request: Request, env: Env, id: number): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  await deleteGithubRelease(env, id);
  return json({ ok: true, deleted: id });
}

async function handleUpload(request: Request, env: Env, id: number, url: URL): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;

  const name = cleanName(url.searchParams.get('name'));
  if (!name) return fail(400, '缺少安装包文件名');
  const sizeHeader = request.headers.get('content-length') || url.searchParams.get('size') || '';
  const size = Number(sizeHeader);
  if (!Number.isFinite(size) || size <= 0) return fail(411, '缺少安装包大小（Content-Length）');
  if (size > MAX_UPLOAD) {
    return fail(
      413,
      `安装包 ${(size / 1024 / 1024).toFixed(1)} MB 超过 ${Math.floor(MAX_UPLOAD / 1024 / 1024)} MB 上限，请先在 GitHub 网页版上传，再回到本页管理`,
    );
  }
  if (!request.body) return fail(400, '安装包内容为空');

  if (url.searchParams.get('replace') === '1') {
    const raw = await fetchGithubRelease(env, id);
    for (const asset of raw.assets) {
      if (asset.name.toLowerCase() === name.toLowerCase()) {
        await deleteGithubAsset(env, asset.id);
      }
    }
  }

  const asset = await uploadGithubAsset(
    env,
    id,
    name,
    request.body,
    request.headers.get('content-type') || 'application/octet-stream',
    String(size),
  );
  return json({ ok: true, asset }, 201);
}

async function handleDeleteAsset(request: Request, env: Env, assetId: number): Promise<Response> {
  const denied = checkToken(request, env);
  if (denied) return denied;
  await deleteGithubAsset(env, assetId);
  return json({ ok: true, deleted: assetId });
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
      return await handleCreateRelease(request, env);
    }

    const assetMatch = path.match(/^\/api\/v1\/admin\/releases\/(\d+)\/assets\/?$/);
    if (assetMatch && request.method === 'POST') {
      return await handleUpload(request, env, Number(assetMatch[1]), url);
    }

    const releaseMatch = path.match(/^\/api\/v1\/admin\/releases\/(\d+)\/?$/);
    if (releaseMatch) {
      const id = Number(releaseMatch[1]);
      if (request.method === 'PATCH') return await handlePatchRelease(request, env, id, origin);
      if (request.method === 'DELETE') return await handleDeleteRelease(request, env, id);
      return fail(405, '不支持的请求方法');
    }

    const deleteAssetMatch = path.match(/^\/api\/v1\/admin\/assets\/(\d+)\/?$/);
    if (deleteAssetMatch && request.method === 'DELETE') {
      return await handleDeleteAsset(request, env, Number(deleteAssetMatch[1]));
    }

    return fail(404, '管理接口不存在');
  } catch (error) {
    if (error instanceof UpstreamError) return fail(error.status, error.message);
    return fail(500, error instanceof Error ? error.message : '管理操作失败');
  }
}
