# HY2 VPN 更新推送服务

为 HY2 VPN 的 Windows 与 Android 客户端提供「检查更新」接口，并附带一个网页管理后台。

- 线上地址：<https://up.tsapi.fun>（自定义域名，指向 Cloudflare Pages 项目 `hy2vpn-updates`）
- 前端：Cloudflare Pages 托管的静态页面（首页 + `admin.html` 管理后台）+ Pages Functions（`functions/[[path]].ts`）
- 版本清单：存放在 **Cloudflare KV**（一个 `catalog.json` 的 JSON 值），后台可随时增删改
- 安装包：**不经过本站**。在后台手动填写版本号与下载直链，客户端拿到链接后自行跳转下载
- Windows 与 Android 完全分开维护：各自有独立的版本号、versionCode、说明、Beta / 草稿 / 强制更新状态

```
客户端 ──GET /api/v1/updates/latest──▶ Pages Function ──读──▶ Cloudflare KV（catalog.json）
   │
   └── 拿到 release.downloadUrl ──▶ 自行托管的安装包（对象存储 / 网盘 / 自有服务器）

管理后台 ──填版本号 + 下载链接──▶ Pages Function ──写──▶ Cloudflare KV
```

## 目录结构

```
updates/
├─ index.html              公开页面（最新版 / 版本记录 / 直链跳转）
├─ admin.html              管理后台（Windows、Android 分开维护版本与链接）
├─ src/main.ts             公开页面逻辑
├─ src/admin.ts            管理后台逻辑
├─ src/styles.css          公共样式
├─ worker/
│  ├─ catalog.ts           KV 读写、版本比较、链接校验
│  ├─ admin.ts             /api/v1/admin/* 管理接口
│  ├─ api.ts               公开接口路由
│  ├─ types.ts             数据结构
│  └─ view.ts              JSON 视图
├─ functions/[[path]].ts   Pages Functions 入口：/api/* 走 API，其余走静态资源
├─ wrangler.toml           Pages 配置
└─ package.json
```

## 数据结构（KV）

KV 中只有一个键 `catalog.json`，值是所有版本的数组：

```json
{
  "updatedAt": "2026-11-21T12:00:00.000Z",
  "releases": [
    {
      "id": "c2b7…",
      "platform": "windows",
      "version": "1.4.0",
      "versionCode": null,
      "title": "Windows 1.4.0",
      "notes": "修复若干问题",
      "force": false,
      "prerelease": false,
      "draft": false,
      "downloadUrl": "https://cdn.example.com/HY2VPN-Desktop-Setup-1.4.0.exe",
      "publishedAt": "2026-11-21T12:00:00.000Z",
      "createdAt": "2026-11-21T12:00:00.000Z"
    }
  ]
}
```

## 本地开发

```bash
npm install
npm run typecheck
npm run build

# 带 Functions 和本地模拟 KV 的调试（先 build，口令放 .dev.vars）
npm run pages:dev        # 等价于 wrangler pages dev dist --kv=CATALOG
```

`.dev.vars` 示例（不要提交到仓库）：

```
ADMIN_TOKEN=你的管理口令
```

本地模拟数据保存在 `.wrangler/state`，删除该目录即可清空。

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

### 2. 创建 KV 命名空间

1. Cloudflare 控制台左侧进入 **Workers & Pages** → **KV**。
2. 点击 **Create a namespace**，名称填 `hy2vpn-catalog`。
3. 创建后不需要手动写入任何内容，后台第一次保存版本时会自动生成 `catalog.json`。

### 3. 绑定 KV 到 Pages

1. 进入 Pages 项目 → **Settings** → **Bindings**（旧界面为 Functions → KV namespace bindings）。
2. 点击 **Add** → **KV namespace**。
3. 变量名填 **`CATALOG`**（必须大写，代码里按这个名字读取）。
4. 选择第 2 步创建的 namespace `hy2vpn-catalog`，点击保存。

### 4. 绑定域名 up.tsapi.fun

`tsapi.fun` 必须已经托管在同一个 Cloudflare 账号下。

1. Pages 项目 → **Custom domains** → **Set up a custom domain**。
2. 输入 `up.tsapi.fun`，点击 **Continue**。
3. Cloudflare 会自动添加 CNAME（`up` → `hy2vpn-updates.pages.dev`），点击 **Activate domain**。
4. 等待状态变为 **Active**（通常 1–2 分钟），打开 `https://up.tsapi.fun/api/v1/updates/health`，返回 `"ok": true` 且 `"storageBound": true` 即成功。

### 5. 配置管理口令

在 Pages 项目 → **Settings** → **Variables and Secrets** 添加：

| 名称 | 类型 | 值 | 作用 |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | Secret | 自定义强口令（如 32 位随机串） | 管理后台登录口令 |

不再需要 GitHub Token 或 R2 存储桶。修改绑定或变量后，需要在 **Deployments** 里 **Retry deployment** 才会生效。

### 6. 使用管理后台

1. 打开 <https://up.tsapi.fun/admin.html>（首页右上角「管理后台」也可进入）。
2. 输入 `ADMIN_TOKEN` 登录，口令只保存在当前浏览器标签页（sessionStorage）。
3. 点击「新建版本」，Windows / Android 各填各的：
   - **版本号**：如 `1.4.1`、`1.10.0`（同平台不可重复）
   - **安装包下载链接**：必须是 `http://` 或 `https://` 开头、能在浏览器直接开始下载的地址
   - **versionCode**：Android 必填，递增整数
   - **更新说明 / 强制更新 / 预发布（Beta）/ 草稿**
4. 保存后可在卡片上编辑链接、发布、转草稿、设为 Beta 或删除。

安装包放在哪里都可以：对象存储（R2 / S3 / 阿里云 OSS 等）、网盘直链、自有服务器。本站只保存链接，不代理流量。

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
    "platform": "android",
    "version": "1.9.0",
    "versionCode": 13,
    "title": "Android 1.9.0",
    "notes": "新增客户端更新检查",
    "force": false,
    "prerelease": false,
    "publishedAt": "2026-11-21T08:00:00Z",
    "downloadUrl": "https://cdn.example.com/HY2VPN-1.9.0.apk"
  },
  "checkedAt": "2026-11-21T08:01:00Z"
}
```

### 其他公开接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/updates/releases?platform=all&channel=all` | 全部版本列表（不含草稿与没有链接的版本） |
| `GET /api/v1/updates/info` | 页面概览数据 |
| `GET /api/v1/updates/health` | 健康检查，返回 `storageBound`、`adminConfigured` |

所有公开接口都带 `Access-Control-Allow-Origin: *`，客户端跨域调用，下载链接由客户端自行打开。

### 管理接口

除登录外都需要请求头 `Authorization: Bearer <ADMIN_TOKEN>`：

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/admin/session` | 校验口令 |
| `GET /api/v1/admin/state` | 全部版本（含草稿）+ 各平台最新版 |
| `POST /api/v1/admin/releases` | 新建版本（platform / version / versionCode / downloadUrl / notes / force / prerelease / draft） |
| `PATCH /api/v1/admin/releases/{id}` | 修改说明、下载链接、force、预发布、草稿、versionCode |
| `DELETE /api/v1/admin/releases/{id}` | 删除版本（不影响链接指向的文件） |

## 版本约定

- 平台只有 `windows` 与 `android` 两种，同一平台版本号不可重复。
- 草稿：不会出现在任何公开接口中，后台可随时发布。
- 预发布：只对 `channel=beta` 的请求可见。
- Android 必须填写 `versionCode`（递增整数），用于客户端比较。
- 只有填写了合法下载链接的版本才会对外可见；编辑链接会立即替换客户端收到的地址。
- 「最新版」按版本号排序自动取最高；回滚时把新版本改为草稿或 Beta 即可。

## 客户端接入

- Windows 1.4.0：`electron/updates.cjs` 默认请求 `https://up.tsapi.fun`，可用环境变量 `HY2VPN_UPDATES_URL` 覆盖。
- Android 1.9.0：`UPDATE_BASE_URL`（`app/build.gradle.kts`）指向同一地址。
- 检查时机：启动时自动检查一次；「我 → 关于 → 检查更新」可手动检查；发现新版本后弹窗展示更新说明并打开 `downloadUrl`。

## 常见问题

- **页面提示「未绑定」或接口返回 503**：Pages → Settings → Bindings 添加 KV 命名空间绑定，变量名必须是 `CATALOG`，然后 Retry deployment。
- **管理后台提示「未配置 ADMIN_TOKEN」**：添加 Secret 后务必 Retry deployment。
- **保存后客户端没变化**：接口本身缓存 30 秒；KV 全球同步通常几秒到 1 分钟，稍等再试。
- **下载链接点了没反应 / 403**：先在无痕窗口直接打开链接验证；网盘链接需要能免登录直接下载，不能是分享页面。
- **客户端看到旧版本**：检查是否误标为草稿 / Beta，或版本号没有递增。
- **想删掉安装包**：本站不存文件，删除版本记录即可；文件请到实际托管处删除。
- **构建报 `npm ci` 与 lockfile 不同步**：本地执行 `npm install` 后提交新的 `package-lock.json`。
