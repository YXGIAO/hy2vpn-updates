import type { CatalogRelease } from './types';

export function downloadPath(release: CatalogRelease): string {
  return `/api/v1/updates/download/${release.platform}/${encodeURIComponent(release.version)}`;
}

export function releaseView(release: CatalogRelease, origin: string): Record<string, unknown> {
  const asset = release.asset;
  const downloadUrl = `${origin}${downloadPath(release)}`;
  return {
    platform: release.platform,
    version: release.version,
    versionCode: release.versionCode,
    title: release.title,
    notes: release.notes,
    force: release.force,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    size: asset ? asset.size : 0,
    assetName: asset ? asset.name : '',
    downloadUrl,
    pageUrl: downloadUrl,
    assets: asset
      ? [{ name: asset.name, size: asset.size, url: downloadUrl }]
      : [],
  };
}

export function adminReleaseView(release: CatalogRelease, origin: string): Record<string, unknown> {
  return {
    ...releaseView(release, origin),
    id: release.id,
    draft: release.draft,
    asset: release.asset
      ? { name: release.asset.name, size: release.asset.size, contentType: release.asset.contentType }
      : null,
  };
}
