/**
 * Full-text search using MiniSearch.
 * Indexes file content, title (basename), tags, and frontmatter fields.
 */

import MiniSearch from 'minisearch';
import type { CachedMetadata } from '../types.js';

export interface SearchDocument {
  id: string;
  path: string;
  title: string;
  content: string;
  tags: string;
  frontmatterSummary: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

export class SearchEngine {
  private ms: MiniSearch<SearchDocument>;

  constructor() {
    this.ms = new MiniSearch<SearchDocument>({
      fields: ['title', 'content', 'tags', 'frontmatterSummary'],
      storeFields: ['path', 'title', 'tags'],
      searchOptions: {
        boost: { title: 3, tags: 2, frontmatterSummary: 1.5, content: 1 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  /**
   * Add or update a document in the search index.
   */
  upsert(meta: CachedMetadata): void {
    const doc: SearchDocument = {
      id: meta.path,
      path: meta.path,
      title: meta.basename,
      content: meta.content,
      tags: meta.tags.map(t => t.name).join(' '),
      frontmatterSummary: this.summarizeFrontmatter(meta.frontmatter),
    };

    if (this.ms.has(meta.path)) {
      this.ms.replace(doc);
    } else {
      this.ms.add(doc);
    }
  }

  /**
   * Remove a document from the search index.
   */
  remove(path: string): void {
    if (this.ms.has(path)) {
      this.ms.discard(path);
    }
  }

  /**
   * Search the index.
   */
  search(query: string, limit = 20): SearchResult[] {
    const results = this.ms.search(query, { fuzzy: 0.2, prefix: true });
    return results.slice(0, limit).map(r => ({
      path: r.path,
      title: r.title ?? '',
      snippet: this.generateSnippet(r, query),
      score: r.score,
      tags: r.tags ? (r.tags as string).split(' ').filter(Boolean) : [],
    }));
  }

  /**
   * Search with exact tag filter.
   */
  searchByTags(tags: string[], mode: 'and' | 'or' = 'or'): SearchResult[] {
    const query = tags.join(' ');
    const results = this.ms.search(query, {
      fields: ['tags'],
      boost: { tags: 1 },
      prefix: false,
      fuzzy: false,
    });

    const filtered = results.filter(r => {
      const docTags = (r.tags as string ?? '').split(' ').filter(Boolean);
      if (mode === 'and') {
        return tags.every(t => docTags.includes(t));
      }
      return tags.some(t => docTags.includes(t));
    });

    return filtered.map(r => ({
      path: r.path,
      title: r.title ?? '',
      snippet: '',
      score: r.score,
      tags: (r.tags as string ?? '').split(' ').filter(Boolean),
    }));
  }

  /**
   * Get total document count.
   */
  get size(): number {
    return this.ms.documentCount;
  }

  private summarizeFrontmatter(fm: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(fm)) {
      if (key === 'tags') continue; // already indexed separately
      if (typeof value === 'string') {
        parts.push(`${key}: ${value}`);
      } else if (Array.isArray(value)) {
        parts.push(`${key}: ${value.join(', ')}`);
      }
    }
    return parts.join('; ');
  }

  private generateSnippet(result: any, query: string): string {
    const content = result.content ?? '';
    if (!query || !content) return content.slice(0, 200);

    const lower = content.toLowerCase();
    const qLower = query.toLowerCase();
    const idx = lower.indexOf(qLower);

    if (idx < 0) return content.slice(0, 200);

    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + query.length + 120);
    let snippet = content.slice(start, end);

    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
  }
}
