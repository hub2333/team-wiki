/**
 * KnowledgeGraph: in-memory graph index of markdown vault files.
 *
 * Core data structures (modeled after Obsidian's MetadataCache):
 * - nodes: Map<path, GraphNode> — all files with their metadata
 * - resolvedLinks: Map<source, Map<target, count>> — resolved wikilinks
 * - unresolvedLinks: Map<source, Map<linktext, count>> — dangling links
 * - backlinks: Map<target, Map<source, count>> — reverse index (not in Obsidian, but needed)
 * - tagIndex: Map<tag, Set<path>> — files by tag
 */

import type {
  CachedMetadata,
  GraphNode,
  GraphEdge,
  GraphData,
  GraphNodeBrief,
  IndexStatus,
} from '../types.js';
import { resolveWikilink, buildFileIndex } from './resolver.js';
import { SearchEngine, type SearchResult } from './search.js';

export class KnowledgeGraph {
  // ─── Core Data ────────────────────────────────────────

  /** All files indexed by vault-relative path */
  nodes: Map<string, GraphNode> = new Map();

  /** resolvedLinks[source][target] = count */
  resolvedLinks: Map<string, Map<string, number>> = new Map();

  /** unresolvedLinks[source][linktext] = count */
  unresolvedLinks: Map<string, Map<string, number>> = new Map();

  /** backlinks[target][source] = count (reverse of resolvedLinks) */
  backlinks: Map<string, Map<string, number>> = new Map();

  /** tagIndex[tagName] = Set of file paths */
  tagIndex: Map<string, Set<string>> = new Map();

  /** Full-text search engine */
  searchEngine: SearchEngine = new SearchEngine();

  /** Index metadata */
  lastUpdated: number | null = null;
  isIndexing: boolean = false;
  vaultPath: string = '';

  // ─── Private helpers ──────────────────────────────────

  private fileIndex: Map<string, { path: string; basename: string }> = new Map();

  // ─── Build / Rebuild ──────────────────────────────────

  /**
   * Build the full index from all parsed metadata.
   * Normalizes all paths to be vault-relative.
   */
  build(files: CachedMetadata[], vaultPath: string): void {
    this.isIndexing = true;
    this.vaultPath = vaultPath;

    // Clear all data
    this.nodes.clear();
    this.resolvedLinks.clear();
    this.unresolvedLinks.clear();
    this.backlinks.clear();
    this.tagIndex.clear();
    this.searchEngine = new SearchEngine();

    // Normalize paths to be vault-relative
    const normalizedFiles = files.map(meta => ({
      ...meta,
      path: this.toRelPath(meta.path),
    }));

    // Build file index for resolution (using relative paths)
    this.fileIndex = buildFileIndex(normalizedFiles);

    // Phase 1: Add all nodes
    for (const meta of normalizedFiles) {
      this.addNodeInternal(meta, false);
    }

    // Phase 2: Resolve all links (all nodes exist, so resolution is accurate)
    for (const meta of normalizedFiles) {
      this.resolveLinksForFile(meta, false);
    }

    // Phase 3: Build reverse indexes + search
    this.buildBacklinks();
    this.buildTagIndex();
    for (const meta of normalizedFiles) {
      this.searchEngine.upsert(meta);
    }

    this.lastUpdated = Date.now();
    this.isIndexing = false;
  }

  // ─── Single File Operations (for incremental updates) ──

  /**
   * Convert an absolute path to vault-relative.
   */
  private toRelPath(absPath: string): string {
    if (!this.vaultPath) return absPath;
    const normalized = absPath.replace(/\\/g, '/');
    const vault = this.vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.startsWith(vault + '/')) {
      return normalized.slice(vault.length + 1);
    }
    return normalized;
  }

  /**
   * Add or update a single file in the index.
   * Normalizes path to be vault-relative.
   */
  upsertFile(meta: CachedMetadata): void {
    const normalized = {
      ...meta,
      path: this.toRelPath(meta.path),
    };
    const relPath = normalized.path;

    // Remove existing entries for this path first
    if (this.nodes.has(relPath)) {
      this.removeFileInternal(relPath);
    }

    // Update fileIndex for resolution
    this.fileIndex.set(relPath, { path: relPath, basename: meta.basename });

    this.addNodeInternal(normalized, true);
    this.resolveLinksForFile(normalized, true);
    this.rebuildBacklinksForFile(relPath);
    this.rebuildTagIndexForFile(relPath);
    this.searchEngine.upsert(normalized);
    this.lastUpdated = Date.now();
  }

  /**
   * Remove a file from the index.
   */
  removeFile(path: string): void {
    this.removeFileInternal(path);
    this.rebuildBacklinksForRemoval(path);
    this.rebuildTagIndexForFile(path);
    this.searchEngine.remove(path);
    this.lastUpdated = Date.now();
  }

  // ─── Query Methods ────────────────────────────────────

  /**
   * Get outgoing links for a file.
   */
  getForwardLinks(path: string): GraphEdge[] {
    const links = this.resolvedLinks.get(path);
    if (!links) return [];
    return Array.from(links.entries()).map(([target, count]) => ({
      source: path,
      target,
      count,
    }));
  }

  /**
   * Get incoming links (backlinks) for a file.
   */
  getBacklinks(path: string): GraphEdge[] {
    const links = this.backlinks.get(path);
    if (!links) return [];
    return Array.from(links.entries()).map(([source, count]) => ({
      source,
      target: path,
      count,
    }));
  }

  /**
   * Get all neighbors (forward + back) for a file.
   */
  getNeighbors(path: string): { forward: GraphEdge[]; backlinks: GraphEdge[] } {
    return {
      forward: this.getForwardLinks(path),
      backlinks: this.getBacklinks(path),
    };
  }

  /**
   * Traverse the graph from a starting node using BFS.
   */
  traverse(
    start: string,
    depth: number,
    direction: 'forward' | 'backward' | 'both' = 'both',
    maxNodes = 200,
    tagFilter?: string[]
  ): GraphData {
    const visited = new Set<string>();
    const edges: GraphEdge[] = [];
    const queue: Array<{ path: string; dist: number }> = [];

    if (!this.nodes.has(start)) {
      return { nodes: [], edges: [] };
    }

    visited.add(start);
    queue.push({ path: start, dist: 0 });

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!current) break;

      const currentNode = this.nodes.get(current.path);
      if (!currentNode) continue;

      // Apply tag filter
      if (tagFilter && tagFilter.length > 0) {
        const nodeTags = currentNode.metadata.tags.map(t => t.name);
        const matchesTag = tagFilter.some(t => nodeTags.includes(t));
        if (!matchesTag && current.dist > 0) continue;
      }

      if (current.dist < depth && visited.size < maxNodes) {
        let neighbors: string[] = [];

        if (direction === 'forward' || direction === 'both') {
          const fwd = this.resolvedLinks.get(current.path);
          if (fwd) {
            for (const [target, count] of fwd) {
              edges.push({ source: current.path, target, count });
              neighbors.push(target);
            }
          }
          // Also add unresolved links as edges (target = unresolved link text)
          const unres = this.unresolvedLinks.get(current.path);
          if (unres) {
            for (const [linktext, count] of unres) {
              edges.push({ source: current.path, target: `?${linktext}`, count });
            }
          }
        }

        if (direction === 'backward' || direction === 'both') {
          const bwd = this.backlinks.get(current.path);
          if (bwd) {
            for (const [source, count] of bwd) {
              edges.push({ source, target: current.path, count });
              neighbors.push(source);
            }
          }
        }

        for (const n of neighbors) {
          if (!visited.has(n) && this.nodes.has(n)) {
            visited.add(n);
            queue.push({ path: n, dist: current.dist + 1 });
          }
        }
      }
    }

    const nodes: GraphNodeBrief[] = Array.from(visited).map(p => {
      const node = this.nodes.get(p);
      return {
        id: p,
        title: node?.metadata.basename ?? p,
        tags: node?.metadata.tags.map(t => t.name) ?? [],
        linkCount: this.getLinkCount(p),
        isOrphan: node?.isOrphan ?? false,
      };
    });

    return { nodes, edges };
  }

  /**
   * Find the shortest path between two nodes using BFS.
   */
  shortestPath(from: string, to: string): string[] | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;
    if (from === to) return [from];

    const visited = new Set<string>([from]);
    const queue: string[] = [from];
    const prev = new Map<string, string | null>();
    prev.set(from, null);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const links = this.resolvedLinks.get(current);
      if (links) {
        for (const target of links.keys()) {
          if (!visited.has(target)) {
            visited.add(target);
            prev.set(target, current);
            if (target === to) {
              // Reconstruct path
              const path: string[] = [];
              let step: string | null = to;
              while (step !== null) {
                path.unshift(step);
                step = prev.get(step) ?? null;
              }
              return path;
            }
            queue.push(target);
          }
        }
      }
      // Also traverse backlinks
      const bl = this.backlinks.get(current);
      if (bl) {
        for (const source of bl.keys()) {
          if (!visited.has(source)) {
            visited.add(source);
            prev.set(source, current);
            if (source === to) {
              const path: string[] = [];
              let step: string | null = to;
              while (step !== null) {
                path.unshift(step);
                step = prev.get(step) ?? null;
              }
              return path;
            }
            queue.push(source);
          }
        }
      }
    }

    return null; // no path found
  }

  /**
   * Get graph statistics.
   */
  getStats(): {
    nodeCount: number;
    edgeCount: number;
    orphanCount: number;
    density: number;
    topHubs: Array<{ path: string; degree: number }>;
  } {
    const nodeCount = this.nodes.size;
    let edgeCount = 0;
    let orphanCount = 0;
    const degrees: Array<{ path: string; degree: number }> = [];

    for (const [path, node] of this.nodes) {
      const outDegree = this.resolvedLinks.get(path)?.size ?? 0;
      const inDegree = this.backlinks.get(path)?.size ?? 0;
      const total = outDegree + inDegree;
      edgeCount += outDegree;

      if (total === 0) orphanCount++;

      degrees.push({ path, degree: total });
    }

    const maxDensity = nodeCount > 1 ? nodeCount * (nodeCount - 1) : 1;
    const density = edgeCount / maxDensity;

    degrees.sort((a, b) => b.degree - a.degree);
    const topHubs = degrees.slice(0, 10);

    return { nodeCount, edgeCount, orphanCount, density, topHubs };
  }

  /**
   * Search full-text.
   */
  search(query: string, limit = 20): SearchResult[] {
    return this.searchEngine.search(query, limit);
  }

  /**
   * List all tags with counts.
   */
  getTags(): Array<{ name: string; count: number }> {
    const result: Array<{ name: string; count: number }> = [];
    for (const [name, paths] of this.tagIndex) {
      result.push({ name, count: paths.size });
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  /**
   * Get tag hierarchy (nested tags expanded).
   */
  getTagHierarchy(): Record<string, unknown> {
    const tree: Record<string, unknown> = {};
    for (const [name] of this.tagIndex) {
      const parts = name.replace(/^#/, '').split('/');
      let current = tree;
      for (const part of parts) {
        if (!current[part]) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
    }
    return tree;
  }

  /**
   * Get the current index status.
   */
  getStatus(): IndexStatus {
    return {
      totalFiles: this.nodes.size,
      indexedFiles: this.nodes.size,
      lastUpdated: this.lastUpdated,
      isIndexing: this.isIndexing,
      stalenessMs: this.lastUpdated ? Date.now() - this.lastUpdated : null,
      vaultPath: this.vaultPath,
    };
  }

  /**
   * Check if a file exists in the index.
   */
  has(path: string): boolean {
    return this.nodes.has(path);
  }

  // ─── Private: Internal mutation helpers ────────────────

  private addNodeInternal(meta: CachedMetadata, buildSearch: boolean): void {
    const node: GraphNode = {
      path: meta.path,
      metadata: meta,
      degree: 0,
      isOrphan: true,
    };
    this.nodes.set(meta.path, node);
    if (buildSearch) {
      this.searchEngine.upsert(meta);
    }
  }

  private removeFileInternal(path: string): void {
    this.nodes.delete(path);
    this.resolvedLinks.delete(path);
    this.unresolvedLinks.delete(path);
  }

  private resolveLinksForFile(meta: CachedMetadata, updateDegrees: boolean): void {
    const sourcePath = meta.path;
    const allLinks = [...meta.links, ...meta.embeds];

    for (const link of allLinks) {
      const resolved = resolveWikilink(link.target, sourcePath, this.fileIndex);

      if (resolved) {
        let edges = this.resolvedLinks.get(sourcePath);
        if (!edges) {
          edges = new Map();
          this.resolvedLinks.set(sourcePath, edges);
        }
        edges.set(resolved, (edges.get(resolved) || 0) + 1);

        if (updateDegrees) {
          this.updateDegree(sourcePath);
          this.updateDegree(resolved);
        }
      } else {
        let edges = this.unresolvedLinks.get(sourcePath);
        if (!edges) {
          edges = new Map();
          this.unresolvedLinks.set(sourcePath, edges);
        }
        edges.set(link.target, (edges.get(link.target) || 0) + 1);
      }
    }
  }

  private updateDegree(path: string): void {
    const node = this.nodes.get(path);
    if (!node) return;

    const outDegree = this.resolvedLinks.get(path)?.size ?? 0;
    const inDegree = this.backlinks.get(path)?.size ?? 0;
    node.degree = outDegree + inDegree;
    node.isOrphan = node.degree === 0;

    // Also update isOrphan considering both resolved and unresolved
    const hasUnresolved = this.unresolvedLinks.get(path)?.size ?? 0;
    if (hasUnresolved > 0) {
      node.isOrphan = false;
    }
  }

  private buildBacklinks(): void {
    this.backlinks.clear();
    for (const [source, targets] of this.resolvedLinks) {
      for (const target of targets.keys()) {
        let sources = this.backlinks.get(target);
        if (!sources) {
          sources = new Map();
          this.backlinks.set(target, sources);
        }
        const currentCount = targets.get(target) ?? 0;
        sources.set(source, (sources.get(source) || 0) + currentCount);
      }
    }

    // Update degrees now that backlinks are built
    for (const path of this.nodes.keys()) {
      this.updateDegree(path);
    }
  }

  private rebuildBacklinksForFile(path: string): void {
    // Remove all backlinks pointing to this file from other files
    for (const [, targets] of this.resolvedLinks) {
      targets.delete(path);
    }

    // Rebuild backlinks for this file
    const targets = this.resolvedLinks.get(path);
    if (targets) {
      for (const target of targets.keys()) {
        let sources = this.backlinks.get(target);
        if (!sources) {
          sources = new Map();
          this.backlinks.set(target, sources);
        }
        const count = targets.get(target) ?? 0;
        sources.set(path, (sources.get(path) || 0) + count);
      }
    }

    // Update degrees
    this.updateDegree(path);
  }

  private rebuildBacklinksForRemoval(path: string): void {
    // Remove this file from everyone's resolvedLinks
    for (const [, targets] of this.resolvedLinks) {
      targets.delete(path);
    }
    // Remove this file from backlinks
    this.backlinks.delete(path);
    // Remove from all backlink entries
    for (const [, sources] of this.backlinks) {
      sources.delete(path);
    }
  }

  private buildTagIndex(): void {
    this.tagIndex.clear();
    for (const [path, node] of this.nodes) {
      for (const tag of node.metadata.tags) {
        const normalized = tag.name;
        let files = this.tagIndex.get(normalized);
        if (!files) {
          files = new Set();
          this.tagIndex.set(normalized, files);
        }
        files.add(path);
      }
      // Also index frontmatter tags
      const fmTags = node.metadata.frontmatter?.tags;
      if (Array.isArray(fmTags)) {
        for (const tag of fmTags) {
          const tagStr = `#${String(tag).replace(/^#/, '')}`;
          let files = this.tagIndex.get(tagStr);
          if (!files) {
            files = new Set();
            this.tagIndex.set(tagStr, files);
          }
          files.add(path);
        }
      }
    }
  }

  private rebuildTagIndexForFile(path: string): void {
    // Remove this file from all tag entries
    for (const [, files] of this.tagIndex) {
      files.delete(path);
    }

    // Re-add
    const node = this.nodes.get(path);
    if (!node) return;

    for (const tag of node.metadata.tags) {
      let files = this.tagIndex.get(tag.name);
      if (!files) {
        files = new Set();
        this.tagIndex.set(tag.name, files);
      }
      files.add(path);
    }

    const fmTags = node.metadata.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) {
        const tagStr = `#${String(tag).replace(/^#/, '')}`;
        let files = this.tagIndex.get(tagStr);
        if (!files) {
          files = new Set();
          this.tagIndex.set(tagStr, files);
        }
        files.add(path);
      }
    }
  }

  private getLinkCount(path: string): number {
    const out = this.resolvedLinks.get(path)?.size ?? 0;
    const in_ = this.backlinks.get(path)?.size ?? 0;
    return out + in_;
  }
}
