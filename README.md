# HY2 VPN 更新推送服务

为 HY2 VPN 的 Windows 与 Android 客户端提供「检查更新 + 下载安装包」服务。

- 前端：Cloudflare Pages 托管的静态页面 + Pages Functions（`functions/[[path]].ts`）
- 后端：Pages Function 读取 GitHub Releases，返回统一的版本 JSON，并把下载请求 302 跳转到安装包
- 安装包：存放在公开仓库的 GitHub Releases，不占用 Cloudflare 的 25 MiB 单文件限制
- 缓存：GitHub API 结果在边缘缓存 120 秒，避免频繁触发限流

```
客户端 ──GET /api/v1/updates/latest──▶ Pages Function ──GET /repos/.../releases──▶ GitHub API
   │                                        │
   └────── 302 / 直接下载 ──────────────────┴──▶ github.com/.../releases/download/...
```

## 目录结构

```
updates/
├─ index.html              页面骨架
├─ src/                    页面样式与逻辑
├─ worker/                 GitHub 读取、版本比较、API 路由（被 Functions 复用）
├─ functions/[[path]].ts   Pages Functions 入口：/api/* 走 API，其余走静态资源
├─ wrangler.toml           Pages 配置与 GITHUB_REPO 变量
└─ package.json
```

## 本地开发

```bash
npm install
npm run typecheck
npm run build

# 带 Functions 的本地调试（需要先 build）
npx wrangler pages dev dist
```

`npm run dev` 只启动 Vite 静态页面，不含 `/api/*`，页面会显示「连接失败」，属正常现象。

## 部署到 Cloudflare Pages（网页点击版）

### 1. 新建 GitHub 仓库

1. 打开 <https://github.com/new>。
2. Repository name 填 `hy2vpn-updates`。
3. 选择 **Public**（Pages 读取 Release 无需私有仓库）。
4. 不要勾选初始化 README，点击 **Create repository**。

### 2. 推送本项目

在 `D:\Hy2VPN\updates` 下执行（把邮箱、用户名换成自己的）：

```bash
git init
git add .
git commit -m "feat: 更新推送服务"
git branch -M main
git remote add origin https://github.com/YXGIAO/hy2vpn-updates.git
git push -u origin main
```

### 3. 创建 Pages 项目

1. 打开 <https://dash.cloudflare.com/>，进入 **Workers & Pages**。
2. 点击 **Create** → **Pages** → **Connect to Git**。
3. 授权 GitHub，选择 `YXGIAO/hy2vpn-updates`，点击 **Begin setup**。
4. 构建设置：
   - Framework preset：**None**
   - Build command：`npm run build`
   - Build output directory：`dist`
   - Root directory：留空
   - Environment variables：`NODE_VERSION` = `22`（可选，默认已是 22）
5. 点击 **Save and Deploy**，等待第一次构建完成。
6. 记下分配的域名，例如 `https://hy2vpn-updates.pages.dev`。之后每次 `git push` 到 `main` 都会自动重新部署。

### 4. 配置变量（可选但建议）

在 Pages 项目 → **Settings** → **Variables and Secrets**：

| 名称 | 类型 | 值 | 作用 |
| --- | --- | --- | --- |
| `GITHUB_REPO` | 变量 | `YXGIAO/hy2vpn-updates` | 已写在 `wrangler.toml`，此处可覆盖 |
| `GITHUB_TOKEN` | Secret | GitHub PAT（仅 `public_repo` 只读权限） | 把限流从 60 次/小时提升到 5000 次/小时 |

修改变量后需要在 **Deployments** 里 **Retry deployment** 才会生效。

### 5. 发布第一个安装包

方式一：网页操作

1. 打开仓库 → **Releases** → **Draft a new release**。
2. Tag 填 `windows-v1.4.0`（必须 `windows-` 或 `android-` 开头）。
3. 标题随意，说明里写更新内容；Android 额外写一行 `versionCode=13`。
4. 上传 `HY2VPN-Desktop-Setup-1.4.0.exe` 或 `HY2VPN-1.9.0.apk`。
5. 点击 **Publish release**。

方式二：命令行（推荐）

```bash
gh release create windows-v1.4.0 ./HY2VPN-Desktop-Setup-1.4.0.exe \
  --title "Windows 1.4.0" --notes "新增客户端更新检查"

gh release create android-v1.9.0 ./HY2VPN-1.9.0.apk \
  --title "Android 1.9.0" --notes "versionCode: 13
新增客户端更新检查"
```

Beta 版本在网页勾选 **Set as a pre-release**，或在命令中加 `--prerelease`。

发布后打开 `<你的 Pages 域名>/api/v1/updates/latest?platform=windows&current=0.0.0` 验证。

## API

### 检查更新

```
GET /api/v1/updates/latest?platform=android&channel=stable&current=1.8.0
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `platform` | 是 | `android` 或 `windows` |
| `channel` | 否 | `stable`（默认）或 `beta` |
| `current` | 否 | 当前版本号；省略时 `updateAvailable` 恒为 `true` |

```json
{
  "ok": true,
  "platform": "android",
  "channel": "stable",
  "current": "1.8.0",
  "updateAvailable": true,
  "release": {
    "version": "1.9.0",
    "versionCode": 13,
    "tag": "android-v1.9.0",
    "notes": "新增客户端更新检查",
    "force": false,
    "prerelease": false,
    "publishedAt": "2026-11-21T08:00:00Z",
    "size": 23592960,
    "assetName": "HY2VPN-1.9.0.apk",
    "downloadUrl": "https://<域名>/api/v1/updates/download/android/1.9.0",
    "pageUrl": "https://github.com/YXGIAO/hy2vpn-updates/releases/tag/android-v1.9.0",
    "assets": [{ "name": "HY2VPN-1.9.0.apk", "size": 23592960, "url": "..." }]
  }
}
```

### 其他接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/updates/releases?platform=all&channel=all` | 全部版本列表 |
| `GET /api/v1/updates/download/{platform}/{version}` | 302 跳转到安装包；`version` 可填 `latest` |
| `GET /api/v1/updates/info` | 页面概览数据 |
| `GET /api/v1/updates/health` | 健康检查，返回仓库名与是否配置 Token |

所有接口都带 `Access-Control-Allow-Origin: *`，桌面端与移动端可直接请求。

## 版本约定

- Tag：`windows-v<semver>` / `android-v<semver>`，例如 `windows-v1.4.0`、`android-v1.9.0-beta.1`。
- 预发布：GitHub 的 Pre-release，或版本号带 `-`（如 `1.9.0-beta.1`）。
- Android 安装包名建议 `HY2VPN-<version>.apk`；Windows 建议 `HY2VPN-Desktop-Setup-<version>.exe`（文件名不要带空格）。
- Release 说明中单独一行：
  - `versionCode=13`：Android 的 versionCode；
  - `force=true`：强制更新。
- 说明中的这两行会从展示给用户的更新日志中自动剔除。

## 常见问题

- **页面显示「更新服务返回 404」**：仓库还没有 Release，或 `GITHUB_REPO` 写错。
- **「GitHub API 请求频率受限」**：在 Pages 添加 `GITHUB_TOKEN` Secret 后重新部署。
- **安装包太大**：单个 Release 资产上限 2 GiB；超过 100 MiB 时不要经过 Worker 中转（本服务的下载接口是 302，不中转流量）。
- **客户端看到旧版本**：边缘缓存 120 秒，发布后最多等待两分钟再刷新。
