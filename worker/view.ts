import type { CatalogRelease } from './types';

export function releaseView(release: CatalogRelease): Record<string, unknown> {
  return {
    platform: release.platform,
    version: release.version,
    versionCode: release.versionCode,
    title: release.title,
    notes: release.notes,
    force: release.force,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    downloadUrl: release.downloadUrl,
  };
}

export function adminReleaseView(release: CatalogRelease): Record<string, unknown> {
  return {
    ...releaseView(release),
    id: release.id,
    draft: release.draft,
  };
}
