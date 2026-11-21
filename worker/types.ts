export interface Env {
  ADMIN_TOKEN?: string;
  RELEASES?: R2Bucket;
  ASSETS: Fetcher;
}

export type Platform = 'android' | 'windows';

export interface CatalogAsset {
  key: string;
  name: string;
  size: number;
  contentType: string;
}

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
  publishedAt: string;
  createdAt: string;
  asset: CatalogAsset | null;
}

export interface Catalog {
  updatedAt: string;
  releases: CatalogRelease[];
}
