export interface Env {
  ADMIN_TOKEN?: string;
  CATALOG?: KVNamespace;
  ASSETS: Fetcher;
}

export type Platform = 'android' | 'windows';

export interface CatalogRelease {
  id: string;
  platform: Platform;
  version: string;
  title: string;
  notes: string;
  force: boolean;
  versionCode: number | null;
  prerelease: boolean;
  draft: boolean;
  // 后台手动填写的安装包直链（对象存储 / 网盘 / 自有服务器均可）
  downloadUrl: string;
  publishedAt: string;
  createdAt: string;
}

export interface Catalog {
  updatedAt: string;
  releases: CatalogRelease[];
}
