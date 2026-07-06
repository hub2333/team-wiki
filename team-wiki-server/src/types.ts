/**
 * Core type definitions for the MetadataCache MCP Server.
 * Modeled after Obsidian's CachedMetadata/MetadataCache API types.
 */

// ─── Position ─────────────────────────────────────────────

export interface Position {
  line: number;
  col: number;
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

// ─── Parsed Metadata (per file) ────────────────────────────

export interface Wikilink {
  /** The link target, e.g. "Note", "Folder/Note", "Note#Heading" */
  target: string;
  /** The display text after |, if any */
  alias?: string;
  /** The section heading after #, if any */
  section?: string;
  /** The block reference after ^, if any */
  blockRef?: string;
  /** Whether this is an embed ![[...]] rather than a link [[...]] */
  isEmbed: boolean;
  /** Original text as written in the document */
  original: string;
  position: Range;
}

export interface Heading {
  text: string;
  level: number; // 1-6
  position: Range;
}

export interface Tag {
  /** Full tag including #, e.g. "#project/active" */
  name: string;
  position: Range;
}

export interface BlockId {
  id: string;
  position: Range;
}

export interface FrontmatterLink {
  key: string;
  link: string;
  original: string;
  displayText?: string;
}

export interface CachedMetadata {
  /** Vault-relative file path */
  path: string;
  /** File basename without extension */
  basename: string;
  /** File extension (e.g. "md", "canvas") */
  extension: string;

  /** Parsed YAML frontmatter as a key-value bag */
  frontmatter: Record<string, unknown>;
  /** Links found inside frontmatter properties */
  frontmatterLinks: FrontmatterLink[];

  /** Internal wikilinks [[...]] */
  links: Wikilink[];
  /** Embedded content ![[...]] */
  embeds: Wikilink[];
  /** Tags #tag */
  tags: Tag[];
  /** Headings */
  headings: Heading[];
  /** Block IDs ^id */
  blocks: BlockId[];

  /** Raw markdown content (for full-text search) */
  content: string;
  /** MD5 hash of content for change detection */
  contentHash: string;
  /** File modification time (epoch ms) */
  mtime: number;
  /** File size in bytes */
  size: number;
}

// ─── Knowledge Graph ──────────────────────────────────────

export interface GraphNode {
  /** Vault-relative file path */
  path: string;
  /** Parsed metadata */
  metadata: CachedMetadata;
  /** Combined degree (in + out) */
  degree: number;
  /** Whether this node has no links in or out */
  isOrphan: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  count: number;
}

export interface GraphData {
  nodes: GraphNodeBrief[];
  edges: GraphEdge[];
}

export interface GraphNodeBrief {
  id: string;
  title: string;
  tags: string[];
  linkCount: number;
  isOrphan: boolean;
}

// ─── Link Resolution ──────────────────────────────────────

export interface LinkResolution {
  /** Source file vault-absolute path */
  sourcePath: string;
  /** Link target as written in the document */
  linktext: string;
  /** Resolved destination path, or null if unresolved */
  resolvedPath: string | null;
  /** Whether the link was successfully resolved */
  isResolved: boolean;
}

// ─── Index Status ─────────────────────────────────────────

export interface IndexStatus {
  totalFiles: number;
  indexedFiles: number;
  lastUpdated: number | null;
  isIndexing: boolean;
  stalenessMs: number | null;
  vaultPath: string;
}

// ─── Configuration ───────────────────────────────────────

export interface ServerConfig {
  /** Path to the vault directory */
  vaultPath: string;
  /** MCP server port */
  port: number;
  /** Bearer token for authentication (empty = no auth) */
  authToken: string;
  /** Transport type */
  transport: 'streamable-http' | 'sse';
  /** Whether to enable MCP protocol server (external AI tools integration) */
  mcpEnabled: boolean;
  /** Debounce delay for file watching (ms) */
  watchDebounceMs: number;
  /** Whether to ignore dotfiles/dotdirs */
  ignoreDotfiles: boolean;
  /** Additional glob patterns to ignore */
  ignorePatterns: string[];
  /** Concurrency for initial indexing */
  indexConcurrency: number;
  /** Maximum traversal depth for graph queries */
  maxTraversalDepth: number;
  /** Maximum nodes returned in a single graph query */
  maxGraphNodes: number;
}

export const DEFAULT_CONFIG: ServerConfig = {
  vaultPath: './vault',
  port: 3100,
  authToken: '',
  transport: 'streamable-http',
  mcpEnabled: true,
  watchDebounceMs: 2000,
  ignoreDotfiles: true,
  ignorePatterns: ['.obsidian/**'],
  indexConcurrency: 10,
  maxTraversalDepth: 5,
  maxGraphNodes: 200,
};

// ─── MCP Tool Types ───────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
