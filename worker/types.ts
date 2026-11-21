export interface Env {
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  ASSETS: Fetcher;
}

export type Platform = 'android' | 'windows';

export interface UpdateAsset {
  name: string;
  size: number;
  url: string;
}

export interface UpdateRelease {
  id: number;
  platform: Platform;
  version: string;
  tag: string;
  title: string;
  notes: string;
  publishedAt: string;
  prerelease: boolean;
  force: boolean;
  versionCode: number | null;
  pageUrl: string;
  assets: UpdateAsset[];
  primary: UpdateAsset | null;
}
