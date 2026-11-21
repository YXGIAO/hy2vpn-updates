import type { UpdateRelease } from './types';

export function releaseView(release: UpdateRelease, origin: string): Record<string, unknown> {
  const primary = release.primary;
  const downloadUrl = primary
    ? `${origin}/api/v1/updates/download/${release.platform}/${encodeURIComponent(release.version)}`
    : release.pageUrl;
  return {
    platform: release.platform,
    version: release.version,
    versionCode: release.versionCode,
    tag: release.tag,
    title: release.title,
    notes: release.notes,
    force: release.force,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    size: primary ? primary.size : 0,
    assetName: primary ? primary.name : '',
    downloadUrl,
    pageUrl: release.pageUrl,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.url,
    })),
  };
}

export function adminReleaseView(release: UpdateRelease, origin: string): Record<string, unknown> {
  return {
    ...releaseView(release, origin),
    id: release.id,
    draft: release.draft,
    assets: release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.size,
      url: asset.url,
      primary: release.primary ? asset.id === release.primary.id : false,
    })),
  };
}
