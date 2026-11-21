# HY2 VPN 更新推送服务

为 HY2 VPN 的 Windows 与 Android 客户端提供「检查更新 + 下载安装包」服务，并附带一个网页管理后台。

- 线上地址：<https://up.tsapi.fun>（自定义域名，指向 Cloudflare Pages 项目 `hy2vpn-updates`）
- 前端：Cloudflare Pages 托管的静态页面（首页 + `admin.html` 管理后台）+ Pages Functions（`functions/[[path]].ts`）
- 存储：安装包与版本清单都存放在 **Cloudflare R2** 存储桶里，不再依赖 GitHub Releases
- 上传：管理后台把安装包切成 32 MiB 分片，通过 R2 分片上传直接写入存储桶，几百 MB 的 exe 也能上传
- 缓存：版本清单（`catalog.json`）在边缘缓存 120 秒，后台写入后立即清除

```
客户端 ──GET /api/v1/updates/latest──▶ Pages Function ──读 catalog.json──▶ R2 存储桶
   │                                        │
   └────── 下载安装包 ◀────────────────────┴──流式读取 releases/... ▶ R2 存储桶
管理后台 ──分片上传 / 编辑版本──▶ Pages Function ──写──▶ R2 存储桶（catalog.json + releases/）
```

## 目录结构

```
updates/
├─ index.html              公开页面（版本展示 + 下载）
├─ admin.html              管理后台（发布 / 分片上传 / 草稿 / Beta）
├─ src/main.ts             公开页面逻辑
├─ src/admin.ts            管理后台逻辑（含分片上传）
├─ src/styles.css          公共样式
├─ worker/                 R2 读写、版本比较、API 路由（被 Functions 复用）
│  ├─ catalog.ts           catalog.json 读写、排序比较、文件名清洗
│  ├─ admin.ts             /api/v1/admin/* 管理接口与分片上传
│  ├─ api.ts               公开接口路由、安装包流式下载
│  └─ view.ts              JSON 视图
├─ functions/[[path]].ts   Pages Functions 入口：/api/* 走 API，其余走静态资源
├─ wrangler.toml           Pages 配置
└─ package.json
```

## 存储结构（R2）

存储桶中只有两类对象：

| 键 | 说明 |
| --- | --- |
| `catalog.json` | 版本清单：每个版本的平台、版本号、说明、状态与安装包元信息 |
| `releases/{platform}/{version}/{文件名}` | 安装包本体，例如 `releases/windows/1.4.0/HY2VPN-Desktop-Setup-1.4.0.exe` |

`catalog.json` 是唯一数据源，不需要数据库。管理后台的每次修改都会整体重写它并刷新缓存。

## 本地开发

```bash
npm install
npm run typecheck
npm run build

# 带 Functions 和本地模拟 R2 桶的调试（先 build，密钥放 .dev.vars）
npm run pages:dev        # 等价于 wrangler pages dev dist --r2=RELEASES=hy2vpn-releases
```

`.dev.vars` 示例（不要提交到仓库）：

```
ADMIN_TOKEN=你的管理口令
```

本地模拟数据保存在 `.wrangler/state`，删除该目录即可清空所有版本。

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

### 2. 创建 R2 存储桶

1. Cloudflare 控制台左侧进入 **R2**。
2. 点击 **Create bucket**，名称填 `hy2vpn-releases`（可自定义，绑定后以绑定名为准）。
3. 位置选择 **Automatic** 即可，其余保持默认，点击创建。
4. 不需要开启公开访问（Public access），安装包统一通过本站的 `/api/v1/updates/download/...` 接口下载。

> R2 免费额度：存储 10 GB/月、A 类操作 100 万次/月、B 类操作 1000 万次/月，个人更新分发完全够用。

### 3. 绑定 R2 到 Pages

1. 进入 Pages 项目 → **Settings** → **Bindings**（旧版界面为 Functions → R2 bucket bindings）。
2. 点击 **Add** → **R2 bucket**。
3. 变量名填 **`RELEASES`**（必须大写，代码里按这个名字读取）。
4. 选择第 2 步创建的桶 `hy2vpn-releases`，点击保存。

### 4. 绑定域名 up.tsapi.fun

`tsapi.fun` 必须已经托管在同一个 Cloudflare 账号下。

1. Pages 项目 → **Custom domains** → **Set up a custom domain**。
2. 输入 `up.tsapi.fun`，点击 **Continue**。
3. Cloudflare 会自动添加 CNAME（`up` → `hy2vpn-updates.pages.dev`），点击 **Activate domain**。
4. 等待状态变为 **Active**（通常 1–2 分钟），打开 `https://up.tsapi.fun/api/v1/updates/health`，返回 `"ok": true` 且 `"storageBound": true` 即成功。

> `hy2vpn-updates.pages.dev` 仍然可用，自定义域名失效时可作为备用。

### 5. 配置管理口令

在 Pages 项目 → **Settings** → **Variables and Secrets** 添加：

| 名称 | 类型 | 值 | 作用 |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | Secret | 自定义强口令（如 32 位随机串） | 管理后台登录口令 |

不再需要任何 GitHub Token。修改绑定或变量后，需要在 **Deployments** 里 **Retry deployment** 才会生效。

### 6. 进入管理后台

1. 打开 <https://up.tsapi.fun/admin.html>（首页右上角「管理后台」也可进入）。
2. 输入 `ADMIN_TOKEN` 登录，口令只保存在当前浏览器标签页（sessionStorage）。
3. 首次发版：点击「新建版本」→ 填写平台与版本号 → 保存 → 在版本卡片上「上传安装包」→ 点击「发布」。

后台支持的操作：

- 新建 / 编辑 / 删除版本（说明、强制更新、Android versionCode）
- 上传安装包：自动按 32 MiB 分片直传 R2，带进度条与失败重试，重新上传会替换旧文件
- 单独删除安装包（保留版本记录）
- 草稿（不对外）↔ 发布；预发布（Beta）↔ 稳定版

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
    "notes": "新增客户端更新检查",
    "force": false,
    "prerelease": false,
    "publishedAt": "2026-11-21T08:00:00Z",
    "size": 23592960,
    "assetName": "HY2VPN-1.9.0.apk",
    "downloadUrl": "https://up.tsapi.fun/api/v1/updates/download/android/1.9.0",
    "assets": [{ "name": "HY2VPN-1.9.0.apk", "size": 23592960, "url": "..." }]
  }
}
```

### 其他公开接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/updates/releases?platform=all&channel=all` | 全部版本列表（不含草稿） |
| `GET /api/v1/updates/download/{platform}/{version}` | 流式返回安装包（由 Function 从 R2 中转）；`version` 可填 `latest` |
| `GET /api/v1/updates/info` | 页面概览数据 |
| `GET /api/v1/updates/health` | 健康检查，返回 `storage`、`storageBound`、`adminConfigured` |

所有公开接口都带 `Access-Control-Allow-Origin: *`。

### 管理接口

除登录外都需要请求头 `Authorization: Bearer <ADMIN_TOKEN>`：

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/admin/session` | 校验口令 |
| `GET /api/v1/admin/state` | 全部版本（含草稿）+ 存储绑定状态 |
| `POST /api/v1/admin/releases` | 新建版本 |
| `PATCH /api/v1/admin/releases/{id}` | 修改说明 / force / 预发布 / 草稿 |
| `DELETE /api/v1/admin/releases/{id}` | 删除版本及其安装包 |
| `POST /api/v1/admin/releases/{id}/uploads` | 开始分片上传，返回 `uploadId` |
| `PUT /api/v1/admin/releases/{id}/uploads/{uploadId}/parts/{n}?name=xxx` | 上传第 n 片（请求体为二进制） |
| `POST /api/v1/admin/releases/{id}/uploads/{uploadId}/complete?name=xxx` | 合并分片并写入版本清单 |
| `DELETE /api/v1/admin/releases/{id}/uploads/{uploadId}?name=xxx` | 中止上传 |
| `DELETE /api/v1/admin/releases/{id}/asset` | 删除安装包（保留版本） |

## 版本约定

- 平台只有 `windows` 与 `android` 两种；同一平台版本号不可重复。
- 草稿：不会出现在任何公开接口中，后台可随时发布。
- 预发布：只对 `channel=beta` 的请求可见。
- Android 必须填写 `versionCode`（递增整数），用于客户端比较。
- 安装包名建议 `HY2VPN-<version>.apk` / `HY2VPN-Desktop-Setup-<version>.exe`；文件名中的空格与非法字符会被自动替换。
- 「最新版」按版本号排序自动取最高；回滚时把新版本改为草稿或 Beta 即可。

## 客户端接入

- Windows 1.4.0：`electron/updates.cjs` 默认请求 `https://up.tsapi.fun`，可用环境变量 `HY2VPN_UPDATES_URL` 覆盖。
- Android 1.9.0：`UPDATE_BASE_URL`（`app/build.gradle.kts`）指向同一地址。
- 检查时机：启动时自动检查一次；「我 → 关于 → 检查更新」可手动检查；发现新版本后弹窗展示更新说明并打开下载页。

## 常见问题

- **构建报 `npm ci` 与 lockfile 不同步**：仓库内已包含与 `package.json` 匹配的 `package-lock.json`；如自行改过依赖，请在本地执行 `npm install` 后把新的 lockfile 一起提交。
- **页面提示「存储未绑定」或接口返回 503**：Pages → Settings → Bindings 添加 R2 存储桶绑定，变量名必须是 `RELEASES`，然后 Retry deployment。
- **管理后台提示「未配置 ADMIN_TOKEN」**：添加 Secret 后务必 Retry deployment。
- **上传到一半失败**：后台会自动中止本次上传；重新点击「上传安装包」即可整体重传，不会产生脏文件。
- **客户端看到旧版本**：边缘缓存 120 秒，发布后最多等待两分钟再刷新。
- **安装包下载慢**：下载由 Pages Function 从 R2 流式中转，走 Cloudflare 全球网络，不受源站带宽限制。
