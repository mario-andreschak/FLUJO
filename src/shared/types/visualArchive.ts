/**
 * Lineage of run resources that the retired visual compaction saved (#1449):
 * an exact-source sidecar and its PNG pages. Older conversations still list
 * and copy these resources, so the metadata stays readable.
 */
export interface VisualArchiveResourceMetadata {
  archiveId: string;
  role: 'source' | 'page';
  pageIndex?: number;
  pageCount?: number;
  route: 'image' | 'text' | 'summary' | 'raw';
  sourceSha256: string;
}
