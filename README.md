# HY2 VPN 更新推送服务

为 HY2 VPN 的 Windows 与 Android 客户端提供「检查更新 + 下载安装包」服务，并附带一个网页管理后台。

- 线上地址：<https://up.tsapi.fun>（自定义域名，指向 Cloudflare Pages 项目 `hy2vpn-updates`）
- 前端：Cloudflare Pages 托管的静态页面（首页 + `admin.html` 管理后台）+ Pages Functions（`functions/[[path]].ts`）
- 后端：Pages Function 读取 GitHub Releases，返回统一的版本 JSON，并把下载请求 302 跳转到安装包
- 安装包：存放在公开仓库的 GitHub Releases，不占用 Cloudflare 的 25 MiB 单文件限制
- 缓存：GitHub API 结果在边缘缓存 120 秒，管理后台写入后立即清除缓存

```
客户端 ──GET /api/v1/updates/latest──▶ Pages Function ──GET /repos/.../releases──▶ GitHub API
   │                                        │
   └────── 302 / 直接下载 ──────────────────┴──▶ github.com/.../releases/download/...
```

## 目录结构

```
updates/
├─ index.html              公开页面（版本展示 + 下载）
├─ admin.html              管理后台（发布 / 上传 / 草稿 / Beta）
├─ src/main.ts             公开页面逻辑
├─ src/admin.ts            管理后台逻辑
├─ src/styles.css          公共样式
├─ worker/                 GitHub 读写、版本比较、API 路由（被 Functions 复用）
│  ├─ github.ts            读取与写入 GitHub Releases
│  ├─ admin.ts             /api/v1/admin/* 管理接口
│  ├─ api.ts               公开接口路由
│  └─ view.ts              JSON 视图
├─ functions/[[path]].ts   Pages Functions 入口：/api/* 走 API，其余走静态资源
├─ wrangler.toml           Pages 配置与 GITHUB_REPO 变量
└─ package.json
```

## 本地开发

```bash
npm install
npm run typecheck
npm run build

# 带 Functions 的本地调试（需要先 build，密钥放 .dev.vars）
npx wrangler pages dev dist
```

`.dev.vars` 示例（不要提交到仓库）：

```
GITHUB_REPO=YXGIAO/hy2vpn-updates
GITHUB_TOKEN=github_pat_xxx
ADMIN_TOKEN=你的管理口令
```

`npm run dev` 只启动 Vite 静态页面，不含 `/api/*`，页面会显示「连接失败」，属正常现象。

## 部署到 Cloudflare Pages

### 1. 创建 Pages 项目

> 项目名必须填 `hy2vpn-updates`。

1. 打开 <https://dash.cloudflare.com/>，进入 **Workers & Pages**。
2. 点击 **Create** → **Pages** → **Connect to Git**，选择 `YXGIAO/hy2vpn-updates`。
3. 项目名称填 `hy2vpn-updates`，构建设置：
   - Framework preset：**None**
   - Build command：`npm run build`
   - Build output directory：`dist`
   - Root directory：留空
   - Environment variables：`NODE_VERSION` = `22`（可选，默认已是 22）
4. 点击 **Save and Deploy**。

### 2. 绑定域名 up.tsapi.fun

`tsapi.fun` 必须已经托管在同一个 Cloudflare 账号下。

1. Pages 项目 → **Custom domains** → **Set up a custom domain**。
2. 输入 `up.tsapi.fun`，点击 **Continue**。
3. Cloudflare 会自动添加 CNAME（`up` → `hy2vpn-updates.pages.dev`），点击 **Activate domain**。
4. 等待状态变为 **Active**（通常 1–2 分钟），打开 `https://up.tsapi.fun/api/v1/updates/health`，返回 `"ok": true` 即成功。

> `hy2vpn-updates.pages.dev` 仍然可用，自定义域名失效时可作为备用。

### 3. 配置变量

在 Pages 项目 → **Settings** → **Variables and Secrets** 添加：

| 名称 | 类型 | 值 | 作用 |
| --- | --- | --- | --- |
| `GITHUB_REPO` | 变量 | `YXGIAO/hy2vpn-updates` | 已写在 `wrangler.toml`，此处可覆盖 |
| `GITHUB_TOKEN` | Secret | GitHub PAT（**Contents: Read and write**） | 读：避免 60 次/小时限流；写：管理后台上传 / 发布 |
| `ADMIN_TOKEN` | Secret | 自定义强口令（如 32 位随机串） | 管理后台登录口令 |

创建 GitHub Token：GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**，Repository access 只选 `hy2vpn-updates`，Permissions → Repository permissions → **Contents: Read and write**，生成后复制到 Cloudflare 的 `GITHUB_TOKEN`。

修改变量后需要在 **Deployments** 里 **Retry deployment** 才会生效。

### 4. 进入管理后台

1. 打开 <https://up.tsapi.fun/admin.html>（首页右上角「管理后台」也可进入）。
2. 输入 `ADMIN_TOKEN` 登录，口令只保存在当前浏览器标签页（sessionStorage）。
3. 首次发版：点击「新建版本」→ 填写版本号 → 保存 → 在版本卡片上「上传安装包」→ 点击「发布」。

后台支持的操作：

- 新建版本（自动生成 `windows-v1.4.1` / `android-v1.10.0` 标签）
- 编辑更新说明、强制更新、Android versionCode
- 上传 / 替换 / 删除安装包
- 草稿（不对外）↔ 发布；预发布（Beta）↔ 稳定版
- 删除整个版本（同时删除 GitHub Release 与标签）

> 上传上限约 **95 MB**（Cloudflare 请求体限制）。Windows 安装包通常更大，请先在 GitHub 的 Release 网页上传文件，再回到后台调整版本状态。

## API

### 检查更新（客户端）

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
    "downloadUrl": "https://up.tsapi.fun/api/v1/updates/download/android/1.9.0",
    "pageUrl": "https://github.com/YXGIAO/hy2vpn-updates/releases/tag/android-v1.9.0",
    "assets": [{ "name": "HY2VPN-1.9.0.apk", "size": 23592960, "url": "..." }]
  }
}
```

### 其他公开接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/updates/releases?platform=all&channel=all` | 全部版本列表（不含草稿） |
| `GET /api/v1/updates/download/{platform}/{version}` | 302 跳转到安装包；`version` 可填 `latest` |
| `GET /api/v1/updates/info` | 页面概览数据 |
| `GET /api/v1/updates/health` | 健康检查，返回仓库名与两个 Token 是否已配置 |

所有公开接口都带 `Access-Control-Allow-Origin: *`。

### 管理接口

除登录外都需要请求头 `Authorization: Bearer <ADMIN_TOKEN>`：

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/admin/session` | 校验口令 |
| `GET /api/v1/admin/state` | 全部版本（含草稿）+ 各平台最新版 |
| `POST /api/v1/admin/releases` | 新建版本 |
| `PATCH /api/v1/admin/releases/{id}` | 修改说明 / force / 预发布 / 草稿 |
| `DELETE /api/v1/admin/releases/{id}` | 删除版本与标签 |
| `POST /api/v1/admin/releases/{id}/assets?name=xxx&replace=1` | 上传安装包（请求体为文件流） |
| `DELETE /api/v1/admin/assets/{id}` | 删除安装包 |

## 版本约定

- Tag：`windows-v<semver>` / `android-v<semver>`，例如 `windows-v1.4.0`、`android-v1.9.0-beta.1`。
- 预发布：GitHub 的 Pre-release，或版本号带 `-`（如 `1.9.0-beta.1`）。
- 草稿：不会出现在任何公开接口中，后台可随时发布。
- Android 安装包名建议 `HY2VPN-<version>.apk`；Windows 建议 `HY2VPN-Desktop-Setup-<version>.exe`（文件名不要带空格）。
- Release 说明中的单独一行 `versionCode=13`、`force=true` 会写入 GitHub，但不会展示给用户。
- 「最新版」按版本号排序自动取最高；回滚时把新版本改为草稿或 Beta 即可。

## 客户端接入

- Windows 1.4.0：`electron/updates.cjs` 默认请求 `https://up.tsapi.fun`，可用环境变量 `HY2VPN_UPDATES_URL` 覆盖。
- Android 1.9.0：`UPDATE_BASE_URL`（`app/build.gradle.kts`）指向同一地址。
- 检查时机：启动时自动检查一次；「我 → 关于 → 检查更新」可手动检查；发现新版本后弹窗展示更新说明并打开下载页。

## 常见问题

- **构建报 `npm ci` 与 lockfile 不同步**：仓库内已包含与 `package.json` 匹配的 `package-lock.json`；如自行改过依赖，请在本地执行 `npm install` 后把新的 lockfile 一起提交。
- **页面显示「更新服务返回 404」**：仓库还没有 Release，或 `GITHUB_REPO` 写错。
- **「GitHub API 请求频率受限」**：在 Pages 添加 `GITHUB_TOKEN` Secret 后重新部署。
- **管理后台提示「未配置 ADMIN_TOKEN」**：添加 Secret 后务必 Retry deployment。
- **管理后台无法新建 / 上传**：`GITHUB_TOKEN` 需要 Contents **读写**权限；只读 Token 只能查看。
- **上传返回 413 或提示超过上限**：单文件大于约 95 MB 时请走 GitHub 网页上传。
- **安装包太大**：单个 Release 资产上限 2 GiB；下载接口是 302，不中转流量。
- **客户端看到旧版本**：边缘缓存 120 秒，发布后最多等待两分钟再刷新。
