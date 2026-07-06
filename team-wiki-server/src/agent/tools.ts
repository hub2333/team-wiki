/**
 * Direct function tools wrapping KnowledgeGraph methods.
 *
 * These tools are registered directly with the OpenAI Agent SDK,
 * bypassing the MCP HTTP layer for internal agent calls.
 * MCP remains available for external consumers (Claude Desktop, Cursor, etc.).
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import { KnowledgeGraph } from '../graph/index.js';

export function createKnowledgeTools(graph: KnowledgeGraph) {
  return [
    // ─── Full-text search ──────────────────────────────────

    tool({
      name: 'search',
      description: 'Full-text search across all notes. Returns matching notes with relevance scores.',
      parameters: z.object({
        query: z.string().describe('Search query string'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      }),
      strict: true,
      execute: async ({ query, limit }) => {
        return JSON.stringify(graph.search(query, limit), null, 2);
      },
    }),

    // ─── Tag search ────────────────────────────────────────

    tool({
      name: 'search_by_tags',
      description: 'Find notes by tags. Use for narrowing search scope.',
      parameters: z.object({
        tags: z.array(z.string()).describe('Tag names (with or without # prefix)'),
        mode: z.enum(['and', 'or']).default('or').describe('Match all (and) or any (or) tags'),
        limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      }),
      strict: true,
      execute: async ({ tags, mode, limit }) => {
        const norm = tags.map(t => t.startsWith('#') ? t : `#${t}`);
        return JSON.stringify(graph.searchEngine.searchByTags(norm, mode).slice(0, limit), null, 2);
      },
    }),

    // ─── Read note ─────────────────────────────────────────

    tool({
      name: 'read_note',
      description: 'Read the full content and metadata of a specific note by its path.',
      parameters: z.object({
        path: z.string().describe('Vault-relative path of the note (e.g. "10-业务模块实现/xxx.md")'),
      }),
      strict: true,
      execute: async ({ path }) => {
        const node = graph.nodes.get(path);
        if (!node) {
          return JSON.stringify({ error: `Not found: ${path}` });
        }
        const m = node.metadata;
        return JSON.stringify({
          path: m.path,
          basename: m.basename,
          frontmatter: m.frontmatter,
          headings: m.headings,
          tags: m.tags.map(t => t.name),
          links: m.links.map(l => ({ target: l.target, alias: l.alias })),
          content: m.content,
        }, null, 2);
      },
    }),

    // ─── Forward links ─────────────────────────────────────

    tool({
      name: 'get_forwardlinks',
      description: 'Get outgoing wikilinks from a note (what this note references).',
      parameters: z.object({
        path: z.string().describe('Vault-relative path of the note'),
      }),
      strict: true,
      execute: async ({ path }) => {
        return JSON.stringify(graph.getForwardLinks(path), null, 2);
      },
    }),

    // ─── Backlinks ─────────────────────────────────────────

    tool({
      name: 'get_backlinks',
      description: 'Get incoming backlinks to a note (what references this note).',
      parameters: z.object({
        path: z.string().describe('Vault-relative path of the note'),
      }),
      strict: true,
      execute: async ({ path }) => {
        return JSON.stringify(graph.getBacklinks(path), null, 2);
      },
    }),

    // ─── Neighbors ─────────────────────────────────────────

    tool({
      name: 'get_neighbors',
      description: 'Get both forward links and backlinks for a note (full connectivity).',
      parameters: z.object({
        path: z.string().describe('Vault-relative path of the note'),
      }),
      strict: true,
      execute: async ({ path }) => {
        return JSON.stringify(graph.getNeighbors(path), null, 2);
      },
    }),

    // ─── Graph traversal ───────────────────────────────────

    tool({
      name: 'traverse_graph',
      description: 'BFS traverse the knowledge graph from a starting note to explore its connected network.',
      parameters: z.object({
        start: z.string().describe('Starting note path'),
        depth: z.number().min(1).max(10).default(2).describe('Traversal depth'),
        direction: z.enum(['forward', 'backward', 'both']).default('both').describe('Traversal direction'),
        max_nodes: z.number().min(1).max(500).default(200).describe('Maximum nodes to include'),
        tag_filter: z.array(z.string()).optional().describe('Only include nodes with these tags'),
      }),
      strict: true,
      execute: async ({ start, depth, direction, max_nodes, tag_filter }) => {
        return JSON.stringify(graph.traverse(start, depth, direction, max_nodes, tag_filter), null, 2);
      },
    }),

    // ─── Shortest path ─────────────────────────────────────

    tool({
      name: 'shortest_path',
      description: 'Find the shortest path between two notes in the knowledge graph.',
      parameters: z.object({
        from: z.string().describe('Starting note path'),
        to: z.string().describe('Target note path'),
      }),
      strict: true,
      execute: async ({ from, to }) => {
        const p = graph.shortestPath(from, to);
        if (p) return JSON.stringify({ path: p, length: p.length - 1 }, null, 2);
        return JSON.stringify({ message: 'No path found' });
      },
    }),

    // ─── Graph stats ───────────────────────────────────────

    tool({
      name: 'get_graph_stats',
      description: 'Get statistics about the knowledge graph (node count, edge count, top hubs, etc.).',
      parameters: z.object({}),
      strict: true,
      execute: async () => {
        return JSON.stringify(graph.getStats(), null, 2);
      },
    }),

    // ─── List notes ────────────────────────────────────────

    tool({
      name: 'list_notes',
      description: 'List notes in the knowledge base, optionally filtered by folder.',
      parameters: z.object({
        folder: z.string().optional().describe('Folder path prefix to filter by (e.g. "10-业务模块实现")'),
        limit: z.number().min(1).max(1000).default(100).describe('Maximum number of results'),
      }),
      strict: true,
      execute: async ({ folder, limit }) => {
        const results: Array<{ path: string; title: string; tags: string[] }> = [];
        for (const [p, node] of graph.nodes) {
          if (folder && !p.startsWith(folder)) continue;
          results.push({
            path: p,
            title: node.metadata.basename,
            tags: node.metadata.tags.map(t => t.name),
          });
          if (results.length >= limit) break;
        }
        return JSON.stringify(results, null, 2);
      },
    }),

    // ─── Tags ──────────────────────────────────────────────

    tool({
      name: 'get_tags',
      description: 'List all tags used in the knowledge base with their document counts.',
      parameters: z.object({}),
      strict: true,
      execute: async () => {
        return JSON.stringify(graph.getTags(), null, 2);
      },
    }),

    tool({
      name: 'get_tag_hierarchy',
      description: 'Get the nested tag hierarchy structure.',
      parameters: z.object({}),
      strict: true,
      execute: async () => {
        return JSON.stringify(graph.getTagHierarchy(), null, 2);
      },
    }),

    // ─── Index status ──────────────────────────────────────

    tool({
      name: 'get_index_status',
      description: 'Get the current index status (total files, staleness, etc.).',
      parameters: z.object({}),
      strict: true,
      execute: async () => {
        return JSON.stringify(graph.getStatus(), null, 2);
      },
    }),
  ];
}
