/**
 * Wikilink path resolution.
 * Implements Obsidian's resolution rules:
 * - Same-directory match preferred
 * - Shortest vault-relative path wins
 * - Case-insensitive matching
 * - Supports < > for paths with spaces
 * - .md extension normalization
 */

import { normalizePath } from '../parser/index.js';
import type { CachedMetadata } from '../types.js';

export interface FileIndex {
  /** vault-relative path → basename (without extension) */
  path: string;
  basename: string;
}

/**
 * Build a lookup map from all file metadata for fast resolution.
 */
export function buildFileIndex(files: CachedMetadata[]): Map<string, FileIndex> {
  const index = new Map<string, FileIndex>();
  for (const f of files) {
    index.set(f.path, { path: f.path, basename: f.basename });
  }
  return index;
}

/**
 * Resolve a wikilink target to a vault-relative file path.
 *
 * @param linktext - The raw wikilink target, e.g. "Note", "Folder/Note", "../Other/Note"
 * @param sourcePath - The vault-relative path of the source file
 * @param fileIndex - All files in the vault, keyed by path
 * @returns The resolved vault-relative path, or null if unresolved
 */
export function resolveWikilink(
  linktext: string,
  sourcePath: string,
  fileIndex: Map<string, FileIndex>
): string | null {
  // 1. Strip angle brackets used for spaces
  let clean = linktext.trim();
  if (clean.startsWith('<') && clean.endsWith('>')) {
    clean = clean.slice(1, -1);
  }

  // 2. Split off display text after |
  const pipeIdx = clean.lastIndexOf('|');
  if (pipeIdx >= 0) {
    clean = clean.slice(0, pipeIdx);
  }

  // 3. Split off #Section and ^block-id suffixes
  const hashIdx = clean.indexOf('#');
  if (hashIdx >= 0) {
    clean = clean.slice(0, hashIdx);
  }

  // 4. Normalize: strip .md extension and trailing whitespace
  let targetName = clean.trim();
  if (targetName.toLowerCase().endsWith('.md')) {
    targetName = targetName.slice(0, -3);
  }

  if (!targetName) return null;

  // 5. Handle explicit relative paths (./ and ../)
  if (targetName.startsWith('./') || targetName.startsWith('../')) {
    const sourceDir = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : '';
    const resolved = normalizePath(
      sourceDir ? `${sourceDir}/${targetName}` : targetName
    );
    // Try with .md extension
    const withExt = resolved.endsWith('.md') ? resolved : `${resolved}.md`;
    if (fileIndex.has(withExt)) return withExt;
    // Try as-is
    if (fileIndex.has(resolved)) return resolved;
    return null;
  }

  // 6. Handle path-qualified links (Folder/Note)
  if (targetName.includes('/')) {
    const withExt = targetName.endsWith('.md') ? targetName : `${targetName}.md`;
    const normalized = normalizePath(withExt);
    if (fileIndex.has(normalized)) return normalized;
  }

  // 7. Search vault-wide with Obsidian's rules
  const targetLower = targetName.toLowerCase();
  const sourceDir = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
    : '';

  const candidates: string[] = [];

  for (const [path, info] of fileIndex) {
    if (info.basename.toLowerCase() === targetLower) {
      candidates.push(path);
    }
  }

  if (candidates.length === 0) return null;

  if (candidates.length === 1) return candidates[0];

  // Multiple candidates: same-directory first, then shortest path
  const sameDir = candidates.filter(c => {
    const dir = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '';
    return dir === sourceDir;
  });

  if (sameDir.length === 1) return sameDir[0];
  if (sameDir.length > 1) {
    // Among same-dir candidates, pick shortest
    sameDir.sort((a, b) => a.split('/').length - b.split('/').length);
    return sameDir[0];
  }

  // No same-dir match: shortest path wins
  candidates.sort((a, b) => a.split('/').length - b.split('/').length);
  return candidates[0];
}
