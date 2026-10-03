/** Shared package registry DTOs. Types only; backend operations remain with their services. */


export interface RegistryPackageSummary {
  id: string;
  handle: string;
  name: string;
  description: string;
  tags: string[];
  downloads: number;
  latestVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryPackageSearchResult {
  items: RegistryPackageSummary[];
  page: number;
  pageSize: number;
  total: number;
  error?: string;
}

export interface RegistryPackageDetail extends RegistryPackageSummary {
  versions?: Array<{ version: string; manifestSize: number; publishedAt: string }>;
  error?: string;
}
