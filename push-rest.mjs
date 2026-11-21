import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = 'YXGIAO/hy2vpn-updates';
const TOKEN = process.env.GIT_TOKEN;
if (!TOKEN) throw new Error('GIT_TOKEN missing');

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'hy2vpn-updates-push',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
};

const status = execSync('git status --porcelain', { cwd: 'D:/Hy2VPN/updates', encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);

const changes = status.map((line) => {
  const code = line.slice(0, 2);
  const path = line.slice(3).trim();
  return { code, path };
});
console.log('changes:', changes.length);

const ref = await api('GET', `/repos/${REPO}/git/ref/heads/main`);
const headSha = ref.object.sha;
const headCommit = await api('GET', `/repos/${REPO}/git/commits/${headSha}`);
console.log('head:', headSha.slice(0, 7), headCommit.message.split('\n')[0]);

const tree = [];
for (const { code, path } of changes) {
  if (code.includes('D')) {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
    console.log('delete', path);
    continue;
  }
  const content = readFileSync(`D:/Hy2VPN/updates/${path}`);
  const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log('blob  ', path, content.length, 'bytes');
}

const newTree = await api('POST', `/repos/${REPO}/git/trees`, {
  base_tree: headCommit.tree.sha,
  tree,
});
const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message: '更新服务改为 Cloudflare R2 存储：catalog.json + 分片上传\n\n- 安装包不再走 GitHub Releases，改为 R2 存储桶（绑定名 RELEASES）\n- 管理后台支持 32 MiB 分片直传、进度条、失败中止\n- 新增草稿/Beta/强制更新与安装包替换、删除\n- 不再需要 GITHUB_TOKEN，仅 ADMIN_TOKEN',
  tree: newTree.sha,
  parents: [headSha],
});
const updated = await api('PATCH', `/repos/${REPO}/git/refs/heads/main`, {
  sha: commit.sha,
  force: false,
});
console.log('pushed:', commit.sha.slice(0, 7), updated.object.sha.slice(0, 7));
