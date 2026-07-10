import { z } from 'zod';
import { KnowledgeGraph } from '../graph/index.js';
import type { GraphNode } from '../types.js';

export type KnowledgeToolName =
  | 'search'
  | 'search_by_tags'
  | 'read_note'
  | 'get_forwardlinks'
  | 'get_backlinks'
  | 'get_neighbors'
  | 'traverse_graph'
  | 'shortest_path'
  | 'get_graph_stats'
  | 'list_notes'
  | 'get_tags'
  | 'get_tag_hierarchy'
  | 'get_index_status';

export interface KnowledgeToolSpec {
  name: KnowledgeToolName;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export const KNOWLEDGE_TOOL_SPECS: KnowledgeToolSpec[] = [
  {
    name: 'search',
    description: 'Full-text search across all notes. Returns matching notes with relevance scores.',
    inputSchema: {
      query: z.string().describe('Search query string'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
    },
  },
  {
    name: 'search_by_tags',
    description: 'Find notes by tags. Use for narrowing search scope.',
    inputSchema: {
      tags: z.array(z.string()).describe('Tag names (with or without # prefix)'),
      mode: z.enum(['and', 'or']).default('or').describe('Match all (and) or any (or) tags'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
    },
  },
  {
    name: 'read_note',
    description: 'Read the full content and metadata of a specific note by its path.',
    inputSchema: {
      path: z.string().describe('Vault-relative path of the note (e.g. "10-业务模块实现/xxx.md")'),
    },
  },
  {
    name: 'get_forwardlinks',
    description: 'Get outgoing wikilinks from a note (what this note references).',
    inputSchema: {
      path: z.string().describe('Vault-relative path of the note'),
    },
  },
  {
    name: 'get_backlinks',
    description: 'Get incoming backlinks to a note (what references this note).',
    inputSchema: {
      path: z.string().describe('Vault-relative path of the note'),
    },
  },
  {
    name: 'get_neighbors',
    description: 'Get both forward links and backlinks for a note (full connectivity).',
    inputSchema: {
      path: z.string().describe('Vault-relative path of the note'),
    },
  },
  {
    name: 'traverse_graph',
    description: 'BFS traverse the knowledge graph from a starting note to explore its connected network.',
    inputSchema: {
      start: z.string().describe('Starting note path'),
      depth: z.number().min(1).max(10).default(2).describe('Traversal depth'),
      direction: z.enum(['forward', 'backward', 'both']).default('both').describe('Traversal direction'),
      max_nodes: z.number().min(1).max(500).default(200).describe('Maximum nodes to include'),
      tag_filter: z.array(z.string()).optional().describe('Only include nodes with these tags'),
    },
  },
  {
    name: 'shortest_path',
    description: 'Find the shortest path between two notes in the knowledge graph.',
    inputSchema: {
      from: z.string().describe('Starting note path'),
      to: z.string().describe('Target note path'),
    },
  },
  {
    name: 'get_graph_stats',
    description: 'Get statistics about the knowledge graph (node count, edge count, top hubs, etc.).',
    inputSchema: {},
  },
  {
    name: 'list_notes',
    description: 'List notes in the knowledge base, optionally filtered by folder.',
    inputSchema: {
      folder: z.string().optional().describe('Folder path prefix to filter by (e.g. "10-业务模块实现")'),
      limit: z.number().min(1).max(1000).default(100).describe('Maximum number of results'),
    },
  },
  {
    name: 'get_tags',
    description: 'List all tags used in the knowledge base with their document counts.',
    inputSchema: {},
  },
  {
    name: 'get_tag_hierarchy',
    description: 'Get the nested tag hierarchy structure.',
    inputSchema: {},
  },
  {
    name: 'get_index_status',
    description: 'Get the current index status (total files, staleness, etc.).',
    inputSchema: {},
  },
];

export async function executeKnowledgeTool(
  graph: KnowledgeGraph,
  name: KnowledgeToolName,
  args: Record<string, any>
): Promise<string> {
  switch (name) {
    case 'search':
      return stringify(graph.search(args.query, args.limit).map(result => decorateSearchResult(graph, result)));
    case 'search_by_tags': {
      const norm = args.tags.map((t: string) => t.startsWith('#') ? t : `#${t}`);
      return stringify(graph.searchEngine.searchByTags(norm, args.mode).slice(0, args.limit).map(result => decorateSearchResult(graph, result)));
    }
    case 'read_note': {
      const node = graph.nodes.get(args.path);
      if (!node) {
        return stringify({ error: `Not found: ${args.path}` });
      }
      const m = node.metadata;
      return stringify({
        source: buildSourceMeta(node),
        path: m.path,
        basename: m.basename,
        frontmatter: m.frontmatter,
        headings: m.headings,
        tags: m.tags.map(t => t.name),
        links: m.links.map(l => ({ target: l.target, alias: l.alias })),
        content: m.content,
      });
    }
    case 'get_forwardlinks':
      return stringify(graph.getForwardLinks(args.path));
    case 'get_backlinks':
      return stringify(graph.getBacklinks(args.path));
    case 'get_neighbors':
      return stringify(graph.getNeighbors(args.path));
    case 'traverse_graph':
      return stringify(graph.traverse(args.start, args.depth, args.direction, args.max_nodes, args.tag_filter));
    case 'shortest_path': {
      const path = graph.shortestPath(args.from, args.to);
      return path ? stringify({ path, length: path.length - 1 }) : stringify({ message: 'No path found' });
    }
    case 'get_graph_stats':
      return stringify(graph.getStats());
    case 'list_notes': {
      const results: Array<{ path: string; title: string; tags: string[] }> = [];
      for (const [path, node] of graph.nodes) {
        if (args.folder && !path.startsWith(args.folder)) continue;
        results.push(buildNoteReference(node));
        if (results.length >= args.limit) break;
      }
      return stringify(results);
    }
    case 'get_tags':
      return stringify(graph.getTags());
    case 'get_tag_hierarchy':
      return stringify(graph.getTagHierarchy());
    case 'get_index_status':
      return stringify({
        ...graph.getStatus(),
        topLevelFolders: summarizeTopLevelFolders(graph),
      });
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function decorateSearchResult(
  graph: KnowledgeGraph,
  result: {
    path: string;
    title: string;
    snippet: string;
    score: number;
    tags: string[];
  }
) {
  const node = graph.nodes.get(result.path);
  return {
    ...result,
    folder: getTopLevelFolder(result.path),
    source: node ? buildSourceMeta(node) : { path: result.path },
  };
}

function buildNoteReference(node: GraphNode) {
  return {
    path: node.path,
    title: node.metadata.basename,
    tags: node.metadata.tags.map(t => t.name),
    source: buildSourceMeta(node),
  };
}

function buildSourceMeta(node: GraphNode) {
  const fm = node.metadata.frontmatter;
  return {
    path: node.path,
    status: getFrontmatterText(fm, ['状态', 'status']),
    confidence: getFrontmatterText(fm, ['可信度', '可置信度', 'confidence', 'reliability']),
    sourceId: getFrontmatterText(fm, ['Source ID', 'source_id', 'sourceId', '证据ID', 'Evidence ID']),
    tags: node.metadata.tags.map(t => t.name),
  };
}

function getFrontmatterText(
  frontmatter: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }
  return undefined;
}

function summarizeTopLevelFolders(graph: KnowledgeGraph, limit = 12) {
  const counts = new Map<string, number>();

  for (const path of graph.nodes.keys()) {
    const folder = getTopLevelFolder(path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
    .slice(0, limit);
}

function getTopLevelFolder(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes('/') ? normalized.split('/')[0] : '(root)';
}
