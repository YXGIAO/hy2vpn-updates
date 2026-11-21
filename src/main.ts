interface UpdateAsset {
  name: string;
  size: number;
  url: string;
}

interface ReleaseView {
  platform: 'android' | 'windows';
  version: string;
  versionCode: number | null;
  title: string;
  notes: string;
  force: boolean;
  prerelease: boolean;
  publishedAt: string;
  size: number;
  assetName: string;
  downloadUrl: string;
  assets: UpdateAsset[];
}

interface PlatformInfo {
  latest: ReleaseView | null;
  beta: ReleaseView | null;
  checkUrl: string;
}

interface InfoResponse {
  ok: boolean;
  storage: string;
  totalReleases: number;
  platforms: Record<'android' | 'windows', PlatformInfo>;
  checkedAt: string;
}

interface ReleasesResponse {
  ok: boolean;
  count: number;
  releases: ReleaseView[];
}

interface HealthResponse {
  ok: boolean;
  storage: string;
  storageBound: boolean;
  adminConfigured: boolean;
}

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

function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const label = button.textContent;
  button.textContent = '已复制';
  window.setTimeout(() => {
    button.textContent = label;
  }, 1400);
}

function notesBlock(release: ReleaseView): string {
  if (!release.notes) return '<pre class="notes empty">该版本没有填写更新说明</pre>';
  return `<pre class="notes">${esc(release.notes)}</pre>`;
}

function badges(release: ReleaseView): string {
  const parts: string[] = [];
  parts.push(
    release.prerelease
      ? '<span class="badge beta">Beta</span>'
      : '<span class="badge stable">稳定版</span>',
  );
  if (release.force) parts.push('<span class="badge force">强制更新</span>');
  return parts.join('');
}

function platformCard(platform: 'windows' | 'android', info: PlatformInfo | undefined): string {
  const name = platform === 'windows' ? 'Windows' : 'Android';
  const glyph = platform === 'windows' ? '🪟' : '🤖';
  const heading = `
    <div class="platform-head">
      <div class="platform-name"><span class="platform-glyph">${glyph}</span>${name} 客户端</div>
      <span class="chip">${esc(platform)}</span>
    </div>`;
  const featured = info?.latest ?? info?.beta;
  if (!featured) {
    return `<article class="card">${heading}
      <div class="empty">还没有发布 ${name} 安装包。按下方「如何发布新版本」创建第一个版本后，这里会自动显示。</div>
    </article>`;
  }
  const latest = featured;
  const beta =
    info?.beta && info.beta.version !== latest.version
      ? `<div class="meta-row"><span>Beta 通道：v${esc(info.beta.version)}</span></div>`
      : '';
  return `<article class="card">
    ${heading}
    <div class="version-line">
      <span class="version">v${esc(latest.version)}</span>
      ${latest.versionCode ? `<span class="version-code">versionCode ${latest.versionCode}</span>` : ''}
      ${badges(latest)}
    </div>
    <div class="meta-row">
      <span>${formatDate(latest.publishedAt)}</span>
      <span>${formatBytes(latest.size)}</span>
      <span>${esc(latest.assetName || '无安装包')}</span>
    </div>
    ${beta}
    ${notesBlock(latest)}
    <div class="card-actions">
      <a class="btn primary" href="${esc(absolute(latest.downloadUrl))}">下载 v${esc(latest.version)}</a>
      <button class="btn tonal" type="button" data-copy="${esc(absolute(latest.downloadUrl))}">复制直链</button>
    </div>
  </article>`;
}

function releaseRow(release: ReleaseView): string {
  return `<div class="release-row">
    <span class="tag">${esc(release.platform)}</span>
    <span class="release-title"><strong>v${esc(release.version)}</strong>${badges(release)}</span>
    <span class="date">${formatDate(release.publishedAt)}</span>
    <span class="size">${formatBytes(release.size)}</span>
    <span class="dl">${
      release.assetName
        ? `<a class="btn tonal" href="${esc(absolute(release.downloadUrl))}">下载</a>`
        : '<span class="size">无安装包</span>'
    }</span>
  </div>`;
}

function renderReleases(releases: ReleaseView[], platform: 'all' | 'windows' | 'android'): void {
  const list = el('release-list');
  const filtered = platform === 'all' ? releases : releases.filter((item) => item.platform === platform);
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">${
      releases.length ? '该平台还没有版本记录。' : '还没有任何版本。在管理后台创建第一个版本后会自动出现在这里。'
    }</div>`;
    return;
  }
  list.innerHTML = filtered.map(releaseRow).join('');
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
  banner.innerHTML = text;
}

let allReleases: ReleaseView[] = [];
let activePlatform: 'all' | 'windows' | 'android' = 'all';

async function load(): Promise<void> {
  const refresh = el<HTMLButtonElement>('refresh');
  refresh.classList.add('loading');
  try {
    const [infoResponse, releasesResponse, healthResponse] = await Promise.all([
      fetch('/api/v1/updates/info', { headers: { accept: 'application/json' } }),
      fetch('/api/v1/updates/releases', { headers: { accept: 'application/json' } }),
      fetch('/api/v1/updates/health', { headers: { accept: 'application/json' } }).catch(() => null),
    ]);
    const payload = (await infoResponse.json()) as InfoResponse & { error?: string };
    if (!infoResponse.ok || !payload.ok) {
      throw new Error(payload.error || `更新服务返回 ${infoResponse.status}`);
    }
    if (!releasesResponse.ok) {
      throw new Error(`版本列表返回 ${releasesResponse.status}`);
    }
    const list = (await releasesResponse.json()) as ReleasesResponse;
    allReleases = Array.isArray(list.releases) ? list.releases : [];
    const health = healthResponse && healthResponse.ok
      ? ((await healthResponse.json()) as HealthResponse)
      : null;

    el('repo-chip').textContent = payload.storage || 'Cloudflare R2';
    el('repo-chip').className = 'chip ok';
    el('latest-cards').innerHTML = platformCard('windows', payload.platforms.windows) +
      platformCard('android', payload.platforms.android);
    el('release-list').innerHTML = '';
    renderReleases(allReleases, activePlatform);
    el('fact-storage').textContent = payload.storage || 'Cloudflare R2';
    el('fact-total').textContent = String(payload.totalReleases ?? allReleases.length);
    el('fact-time').textContent = formatDate(payload.checkedAt);
    el('fact-health').textContent = health
      ? `正常${health.storageBound ? ' · 存储已绑定' : ' · 存储未绑定'}${health.adminConfigured ? ' · 后台可用' : ' · 后台未配置'}`
      : '正常';
    const sample = el('api-sample');
    sample.textContent = `GET /api/v1/updates/latest?platform=android&channel=stable&current=1.8.0`;
    setBanner('');
  } catch (error) {
    const message = error instanceof Error ? error.message : '更新服务暂时不可用';
    setBanner(
      `${esc(message)}。若刚完成部署，请确认 Pages 项目中已绑定 R2 存储桶（变量名 <code>RELEASES</code>）并配置 <code>ADMIN_TOKEN</code>。`,
      'warn',
    );
    el('repo-chip').textContent = '连接失败';
    el('repo-chip').className = 'chip warn';
    el('fact-health').textContent = '不可用';
    el('latest-cards').innerHTML =
      `<article class="card"><div class="empty">无法加载版本信息，请稍后点击右上角刷新。</div></article>` +
      `<article class="card"><div class="empty">创建第一个版本后即可在线检查更新。</div></article>`;
    el('release-list').innerHTML = '<div class="empty">暂无数据。</div>';
  } finally {
    refresh.classList.remove('loading');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const copyButton = target?.closest<HTMLButtonElement>('[data-copy]');
  if (copyButton) {
    void copyText(copyButton.dataset.copy || '', copyButton);
    return;
  }
  const filter = target?.closest<HTMLButtonElement>('.filter');
  if (filter) {
    activePlatform = (filter.dataset.platform as typeof activePlatform) || 'all';
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === filter));
    renderReleases(allReleases, activePlatform);
  }
});

el('refresh').addEventListener('click', () => {
  void load();
});

void load();

export {};
