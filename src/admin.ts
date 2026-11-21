type Platform = 'android' | 'windows';

interface AdminAsset {
  name: string;
  size: number;
  contentType: string;
}

interface AdminRelease {
  id: string;
  platform: Platform;
  version: string;
  versionCode: number | null;
  title: string;
  notes: string;
  force: boolean;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string;
  size: number;
  assetName: string;
  downloadUrl: string;
  asset: AdminAsset | null;
}

interface PlatformInfo {
  latest: AdminRelease | null;
  beta: AdminRelease | null;
}

interface AdminState {
  ok: boolean;
  storageBound: boolean;
  releases: AdminRelease[];
  platforms: Record<Platform, PlatformInfo>;
  checkedAt: string;
}

interface UploadSession {
  uploadId: string;
  name: string;
  key: string;
}

const TOKEN_KEY = 'hy2up-admin-token';
const PART_SIZE = 32 * 1024 * 1024;

let token = '';
let state: AdminState | null = null;
let activePlatform: 'all' | Platform = 'all';
let editingId: string | null = null;
let uploadReleaseId: string | null = null;
let busy = false;
let uploading = false;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setBanner(text: string, kind: 'warn' | 'error' | '' = ''): void {
  const banner = el('banner');
  if (!text) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind}`.trim();
  banner.textContent = text;
}

let toastTimer = 0;
function toast(message: string, error = false): void {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };
  const response = await fetch(path, { ...init, headers });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 401) logout(true);
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error || `请求失败（${response.status}）`));
  }
  return data as T;
}

function logout(expired: boolean): void {
  token = '';
  state = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* ignore */ }
  el('login-view').hidden = false;
  el('dashboard').hidden = true;
  el('logout').hidden = true;
  el('repo-chip').textContent = '未登录';
  el('repo-chip').className = 'chip';
  if (expired) setBanner('登录已失效，请重新输入管理口令', 'warn');
}

async function login(password: string): Promise<void> {
  const response = await fetch('/api/v1/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: password }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.ok !== true) {
    throw new Error(String(data.error || '登录失败'));
  }
  token = password;
  try {
    sessionStorage.setItem(TOKEN_KEY, password);
  } catch (_) { /* ignore */ }
  el<HTMLInputElement>('token-input').value = '';
  await refresh();
}

async function refresh(): Promise<void> {
  if (!token) return;
  const next = await request<AdminState>('/api/v1/admin/state');
  state = next;
  el('login-view').hidden = true;
  el('dashboard').hidden = false;
  el('logout').hidden = false;
  el('repo-chip').textContent = next.storageBound ? 'R2 已连接' : 'R2 未绑定';
  el('repo-chip').className = `chip ${next.storageBound ? 'ok' : 'warn'}`;
  el('fact-storage').textContent = next.storageBound ? 'Cloudflare R2' : '未绑定';
  el('fact-admin').textContent = '已配置';
  el('fact-count').textContent = String(next.releases.length);
  el('fact-time').textContent = formatDate(next.checkedAt);
  el('platform-cards').innerHTML =
    summaryCard('windows', next.platforms.windows) + summaryCard('android', next.platforms.android);
  if (!next.storageBound) {
    setBanner('尚未绑定 R2 存储桶：请在 Pages 项目 → 设置 → 绑定 中添加 RELEASES（类型 R2 存储桶），然后重新部署。', 'error');
  } else {
    setBanner('');
  }
  renderReleases();
}

function badges(release: AdminRelease): string {
  const parts: string[] = [];
  if (release.draft) parts.push('<span class="badge draft">草稿</span>');
  if (release.prerelease) parts.push('<span class="badge beta">Beta</span>');
  if (!release.draft && !release.prerelease) parts.push('<span class="badge stable">稳定版</span>');
  if (release.force) parts.push('<span class="badge force">强制更新</span>');
  return parts.join('');
}

function summaryCard(platform: Platform, info: PlatformInfo): string {
  const name = platform === 'windows' ? 'Windows' : 'Android';
  const glyph = platform === 'windows' ? '🪟' : '🤖';
  const stable = info.latest;
  const beta = info.beta && stable && info.beta.version !== stable.version ? info.beta : null;
  return `<article class="card">
    <div class="platform-head">
      <div class="platform-name"><span class="platform-glyph">${glyph}</span>${name} 客户端</div>
      <span class="chip">${esc(platform)}</span>
    </div>
    ${
      stable
        ? `<div class="version-line">
             <span class="version">v${esc(stable.version)}</span>
             ${stable.versionCode ? `<span class="version-code">versionCode ${stable.versionCode}</span>` : ''}
             ${badges(stable)}
           </div>
           <div class="meta-row">
             <span>${formatDate(stable.publishedAt)}</span>
             <span>${formatBytes(stable.size)}</span>
             <span>${esc(stable.assetName || '无安装包')}</span>
           </div>`
        : '<div class="empty">还没有已发布的稳定版。</div>'
    }
    ${beta ? `<div class="meta-row"><span>Beta 通道：v${esc(beta.version)}</span><span>${formatDate(beta.publishedAt)}</span></div>` : ''}
  </article>`;
}

function assetRows(release: AdminRelease): string {
  if (!release.asset) {
    return '<div class="asset-row muted"><span>尚未上传安装包</span></div>';
  }
  return `<div class="asset-row">
      <span class="asset-name">${esc(release.asset.name)}</span>
      <span class="asset-size">${formatBytes(release.asset.size)}</span>
      <span class="badge stable">R2 存储</span>
      <button class="link-btn danger" type="button" data-action="del-asset">删除</button>
    </div>`;
}

function releaseCard(release: AdminRelease): string {
  const actions: string[] = [];
  actions.push(`<button class="btn tonal" type="button" data-action="edit">编辑说明</button>`);
  actions.push(`<button class="btn ghost" type="button" data-action="upload">上传安装包</button>`);
  if (release.draft) {
    actions.push(`<button class="btn ghost" type="button" data-action="draft" data-value="0">发布</button>`);
  } else {
    actions.push(`<button class="btn ghost" type="button" data-action="draft" data-value="1">转为草稿</button>`);
  }
  if (release.prerelease) {
    actions.push(`<button class="btn ghost" type="button" data-action="prerelease" data-value="0">设为稳定</button>`);
  } else {
    actions.push(`<button class="btn ghost" type="button" data-action="prerelease" data-value="1">设为 Beta</button>`);
  }
  actions.push(`<button class="btn ghost danger" type="button" data-action="delete">删除版本</button>`);
  return `<article class="admin-release${release.draft ? ' is-draft' : ''}" data-id="${esc(release.id)}">
    <div class="admin-release-head">
      <div class="admin-version">v${esc(release.version)} ${badges(release)}</div>
      <a class="tag" href="${esc(release.downloadUrl)}" target="_blank" rel="noreferrer">下载链接</a>
    </div>
    <div class="meta-row">
      <span>${formatDate(release.publishedAt)}</span>
      <span>${release.asset ? formatBytes(release.asset.size) : '无安装包'}</span>
    </div>
    <div class="asset-list">${assetRows(release)}</div>
    ${release.notes ? `<pre class="notes">${esc(release.notes)}</pre>` : ''}
    <div class="card-actions">${actions.join('')}</div>
    <div class="upload-progress" hidden><div class="upload-bar"></div><span class="upload-text"></span></div>
  </article>`;
}

function renderReleases(): void {
  const list = el('admin-release-list');
  if (!state) return;
  const filtered =
    activePlatform === 'all' ? state.releases : state.releases.filter((item) => item.platform === activePlatform);
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">${
      state.releases.length ? '该平台还没有版本记录。' : '还没有任何版本，点击右上角「新建版本」开始。'
    }</div>`;
    return;
  }
  list.innerHTML = filtered.map(releaseCard).join('');
}

function openDialog(release: AdminRelease | null): void {
  editingId = release ? release.id : null;
  el('release-dialog-title').textContent = release ? `编辑 ${release.platform} ${release.version}` : '新建版本';
  const platform = el<HTMLSelectElement>('f-platform');
  platform.value = release ? release.platform : 'windows';
  platform.disabled = Boolean(release);
  el<HTMLInputElement>('f-version').value = release ? release.version : '';
  el<HTMLInputElement>('f-version').disabled = Boolean(release);
  el<HTMLInputElement>('f-versioncode').value = release && release.versionCode ? String(release.versionCode) : '';
  el<HTMLInputElement>('f-title').value = release ? release.title : '';
  el<HTMLTextAreaElement>('f-notes').value = release ? release.notes : '';
  el<HTMLInputElement>('f-force').checked = release ? release.force : false;
  el<HTMLInputElement>('f-prerelease').checked = release ? release.prerelease : false;
  el<HTMLInputElement>('f-draft').checked = release ? release.draft : false;
  syncVersionCodeField();
  el<HTMLDialogElement>('release-dialog').showModal();
}

function syncVersionCodeField(): void {
  const platform = el<HTMLSelectElement>('f-platform').value;
  el('versioncode-field').style.display = platform === 'android' ? '' : 'none';
}

async function saveRelease(): Promise<void> {
  if (busy) return;
  const platform = el<HTMLSelectElement>('f-platform').value as Platform;
  const version = el<HTMLInputElement>('f-version').value.trim().replace(/^v/i, '');
  const notes = el<HTMLTextAreaElement>('f-notes').value;
  const title = el<HTMLInputElement>('f-title').value.trim();
  const versionCodeRaw = Number(el<HTMLInputElement>('f-versioncode').value);
  const payload = {
    platform,
    version,
    notes,
    title,
    force: el<HTMLInputElement>('f-force').checked,
    prerelease: el<HTMLInputElement>('f-prerelease').checked,
    draft: el<HTMLInputElement>('f-draft').checked,
    versionCode: Number.isFinite(versionCodeRaw) && versionCodeRaw > 0 ? versionCodeRaw : 0,
  };
  busy = true;
  el<HTMLButtonElement>('release-submit').disabled = true;
  try {
    if (editingId) {
      await request(`/api/v1/admin/releases/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      toast('已保存修改');
    } else {
      await request('/api/v1/admin/releases', { method: 'POST', body: JSON.stringify(payload) });
      toast('版本已创建，记得上传安装包');
    }
    el<HTMLDialogElement>('release-dialog').close();
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : '保存失败', true);
  } finally {
    busy = false;
    el<HTMLButtonElement>('release-submit').disabled = false;
  }
}

function patchRelease(id: string, patch: Record<string, unknown>, done: string): void {
  void (async () => {
    try {
      await request(`/api/v1/admin/releases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      toast(done);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', true);
    }
  })();
}

function deleteRelease(release: AdminRelease): void {
  if (!window.confirm(`删除 ${release.platform} ${release.version}？R2 中的安装包也会被删除。`)) return;
  void (async () => {
    try {
      await request(`/api/v1/admin/releases/${release.id}`, { method: 'DELETE' });
      toast(`已删除 v${release.version}`);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', true);
    }
  })();
}

function deleteAsset(release: AdminRelease): void {
  if (!window.confirm(`删除安装包 ${release.asset?.name || ''}？`)) return;
  void (async () => {
    try {
      await request(`/api/v1/admin/releases/${release.id}/asset`, { method: 'DELETE' });
      toast('已删除安装包');
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', true);
    }
  })();
}

function pickFile(releaseId: string): void {
  if (uploading) {
    toast('已有文件正在上传，请稍候', true);
    return;
  }
  uploadReleaseId = releaseId;
  el<HTMLInputElement>('file-input').click();
}

function updateProgress(releaseId: string, percent: number, label: string): void {
  const card = document.querySelector<HTMLElement>(`.admin-release[data-id="${CSS.escape(releaseId)}"]`);
  const progress = card?.querySelector<HTMLElement>('.upload-progress');
  const bar = progress?.querySelector<HTMLElement>('.upload-bar');
  const text = progress?.querySelector<HTMLElement>('.upload-text');
  if (progress) progress.hidden = false;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (text) text.textContent = label;
}

function hideProgress(releaseId: string): void {
  const card = document.querySelector<HTMLElement>(`.admin-release[data-id="${CSS.escape(releaseId)}"]`);
  const progress = card?.querySelector<HTMLElement>('.upload-progress');
  if (progress) progress.hidden = true;
}

function putPart(
  releaseId: string,
  session: UploadSession,
  partNumber: number,
  blob: Blob,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = `?name=${encodeURIComponent(session.name)}`;
    xhr.open(
      'PUT',
      `/api/v1/admin/releases/${releaseId}/uploads/${encodeURIComponent(session.uploadId)}/parts/${partNumber}${query}`,
    );
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
      } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && typeof data.etag === 'string') {
        resolve(data.etag);
      } else {
        reject(new Error(String(data.error || `分片上传失败（${xhr.status}）`)));
      }
    };
    xhr.onerror = () => reject(new Error('分片上传失败，请检查网络'));
    xhr.send(blob);
  });
}

async function uploadFile(releaseId: string, file: File): Promise<void> {
  uploading = true;
  const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let session: UploadSession | null = null;
  const overall = (sent: number) => {
    const percent = file.size ? ((sent / file.size) * 100) : 0;
    updateProgress(releaseId, percent, `正在上传 ${file.name}（${percent.toFixed(0)}%）`);
  };
  updateProgress(releaseId, 0, `正在准备上传 ${file.name}…`);
  try {
    session = await request<UploadSession>(`/api/v1/admin/releases/${releaseId}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ name: file.name, contentType: file.type }),
    });
    for (let part = 1; part <= totalParts; part++) {
      const start = (part - 1) * PART_SIZE;
      const end = Math.min(start + PART_SIZE, file.size);
      const chunk = file.slice(start, end);
      let etag = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          etag = await putPart(releaseId, session, part, chunk, (loaded) => overall(start + loaded));
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
      parts.push({ partNumber: part, etag });
      overall(end);
    }
    updateProgress(releaseId, 100, '正在合并分片…');
    await request(
      `/api/v1/admin/releases/${releaseId}/uploads/${encodeURIComponent(session.uploadId)}/complete?name=${encodeURIComponent(session.name)}`,
      { method: 'POST', body: JSON.stringify({ parts }) },
    );
    toast(`安装包 ${file.name} 上传完成`);
    hideProgress(releaseId);
    await refresh();
  } catch (error) {
    if (session) {
      void fetch(
        `/api/v1/admin/releases/${releaseId}/uploads/${encodeURIComponent(session.uploadId)}?name=${encodeURIComponent(session.name)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
      ).catch(() => null);
    }
    hideProgress(releaseId);
    toast(error instanceof Error ? error.message : '上传失败', true);
  } finally {
    uploading = false;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  const filter = target.closest<HTMLButtonElement>('.filter');
  if (filter) {
    activePlatform = (filter.dataset.platform as typeof activePlatform) || 'all';
    document.querySelectorAll('#platform-filter .filter').forEach((item) => item.classList.toggle('active', item === filter));
    renderReleases();
    return;
  }

  const actionButton = target.closest<HTMLButtonElement>('[data-action]');
  if (!actionButton || !state) return;
  const card = actionButton.closest<HTMLElement>('.admin-release');
  const release = card ? state.releases.find((item) => item.id === card.dataset.id) : null;
  if (!release) return;

  switch (actionButton.dataset.action) {
    case 'edit':
      openDialog(release);
      break;
    case 'upload':
      pickFile(release.id);
      break;
    case 'del-asset':
      deleteAsset(release);
      break;
    case 'draft':
      patchRelease(release.id, { draft: actionButton.dataset.value === '1' }, actionButton.dataset.value === '1' ? '已转为草稿' : '已发布');
      break;
    case 'prerelease':
      patchRelease(
        release.id,
        { prerelease: actionButton.dataset.value === '1' },
        actionButton.dataset.value === '1' ? '已标记为 Beta' : '已设为稳定版',
      );
      break;
    case 'delete':
      deleteRelease(release);
      break;
    default:
      break;
  }
});

el('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = el<HTMLInputElement>('token-input').value.trim();
  if (!password) return;
  setBanner('');
  const button = el<HTMLButtonElement>('login-btn');
  button.disabled = true;
  login(password)
    .catch((error: unknown) => {
      setBanner(error instanceof Error ? error.message : '登录失败，请确认 ADMIN_TOKEN', 'error');
    })
    .finally(() => {
      button.disabled = false;
    });
});

el('logout').addEventListener('click', () => logout(false));

el('new-release').addEventListener('click', () => {
  if (!state) return;
  if (!state.storageBound) {
    toast('请先绑定 R2 存储桶并重新部署', true);
    return;
  }
  openDialog(null);
});

el('f-platform').addEventListener('change', syncVersionCodeField);

el('release-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveRelease();
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => el<HTMLDialogElement>('release-dialog').close());
});

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.id = 'file-input';
fileInput.hidden = true;
document.body.appendChild(fileInput);
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file && uploadReleaseId) void uploadFile(uploadReleaseId, file);
  fileInput.value = '';
});

try {
  token = sessionStorage.getItem(TOKEN_KEY) || '';
} catch (_) {
  token = '';
}
if (token) {
  refresh().catch(() => {
    token = '';
    logout(false);
  });
} else {
  el('login-view').hidden = false;
}

export {};
