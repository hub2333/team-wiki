/**
 * Markdown parser: extracts structured metadata from Obsidian-flavored markdown files.
 *
 * Architecture:
 * 1. gray-matter strips frontmatter (YAML between --- delimiters)
 * 2. remark-parse builds an AST from the body
 * 3. AST walker extracts headings, then scans text nodes for wikilinks/tags
 * 4. remark-parse already excludes code block content from text nodes,
 *    so no explicit excluded-ranges tracking is needed for CommonMark syntax.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root, Heading as MdastHeading, Text, Code, InlineCode, Yaml } from 'mdast';

import type {
  CachedMetadata,
  Wikilink,
  Heading,
  Tag,
  BlockId,
  Range,
  Position,
  FrontmatterLink,
} from '../types.js';

// ─── Helpers ──────────────────────────────────────────────

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function posFromOffset(
  content: string,
  offset: number
): Position {
  const before = content.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    col: lines[lines.length - 1].length + 1,
    offset,
  };
}

function rangeFromOffsets(
  content: string,
  startOffset: number,
  endOffset: number
): Range {
  return {
    start: posFromOffset(content, startOffset),
    end: posFromOffset(content, endOffset),
  };
}

// ─── Wikilink & Tag Patterns ──────────────────────────────

// Wikilink: [[Target]], [[Target|Alias]], [[Target#Section]], [[Target#^block-id]]
// Also handles ![[Embed]]
const WIKILINK_RE = /(!?)\[\[([^\]]+)\]\]/g;

// Tag: #tag or #nested/tag (but not ## heading, not # in URLs)
// Must not be preceded by alphanumeric, must not be followed by alphanumeric (for partial matching)
// Excluding code blocks handled by AST walking
const TAG_RE = /(?:^|\s)(#[^\s#\[\]()]+)/g;

// Block ID: ^block-id at start of line (after optional whitespace)
const BLOCK_ID_RE = /^\s*\^([a-zA-Z0-9_-]+)\s*$/gm;

// ─── Wikilink Parser ──────────────────────────────────────

function parseWikilinkTarget(raw: string): {
  target: string;
  section?: string;
  blockRef?: string;
  alias?: string;
} {
  let text = raw;

  // Split off display text
  const pipeIdx = text.lastIndexOf('|');
  let alias: string | undefined;
  if (pipeIdx >= 0) {
    alias = text.slice(pipeIdx + 1);
    text = text.slice(0, pipeIdx);
  }

  // Split off block reference ^block-id
  const blockIdx = text.indexOf('^');
  let blockRef: string | undefined;
  if (blockIdx >= 0) {
    blockRef = text.slice(blockIdx + 1);
    text = text.slice(0, blockIdx);
  }

  // Split off section heading #Heading
  const hashIdx = text.indexOf('#');
  let section: string | undefined;
  if (hashIdx >= 0) {
    section = text.slice(hashIdx + 1);
    text = text.slice(0, hashIdx);
  }

  return { target: text || raw, section, blockRef, alias };
}

// ─── Main Parse Function ──────────────────────────────────

export function parseMarkdownFile(filePath: string): CachedMetadata {
  const content = readFileSync(filePath, 'utf-8');
  const stat = statSync(filePath);

  // 1. Parse frontmatter with gray-matter
  const parsed = matter(content);
  const frontmatter = (parsed.data || {}) as Record<string, unknown>;
  const body = parsed.content;

  // 2. Detect frontmatter links
  const frontmatterLinks = extractFrontmatterLinks(frontmatter);

  // 3. Compute hash (on full content including frontmatter)
  const contentHash = md5(content);

  // 4. Parse body with remark
  const mdast = unified().use(remarkParse).parse(body);

  // 5. Extract headings from AST
  const headings = extractHeadings(body, mdast);

  // 6. Extract wikilinks and tags from text nodes (outside code blocks)
  const links: Wikilink[] = [];
  const embeds: Wikilink[] = [];
  const tags: Tag[] = [];

  extractFromAst(body, mdast, links, embeds, tags);

  // 7. Extract block IDs from body (line-based, works across all contexts)
  const blocks = extractBlockIds(body);

  // 8. Build filename info
  const pathParts = filePath.replace(/\\/g, '/').split('/');
  const filename = pathParts[pathParts.length - 1] ?? '';
  const dotIdx = filename.lastIndexOf('.');
  const basename = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
  const extension = dotIdx >= 0 ? filename.slice(dotIdx + 1) : '';

  return {
    path: filePath,
    basename,
    extension,
    frontmatter,
    frontmatterLinks,
    links,
    embeds,
    tags,
    headings,
    blocks,
    content,
    contentHash,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
}

// ─── Parse In-Memory (for testing / streaming) ────────────

export function parseMarkdownContent(
  content: string,
  virtualPath: string
): CachedMetadata {
  const parsed = matter(content);
  const frontmatter = (parsed.data || {}) as Record<string, unknown>;
  const body = parsed.content;

  const frontmatterLinks = extractFrontmatterLinks(frontmatter);
  const contentHash = md5(content);
  const mdast = unified().use(remarkParse).parse(body);

  const headings = extractHeadings(body, mdast);
  const links: Wikilink[] = [];
  const embeds: Wikilink[] = [];
  const tags: Tag[] = [];

  extractFromAst(body, mdast, links, embeds, tags);
  const blocks = extractBlockIds(body);

  const pathParts = virtualPath.replace(/\\/g, '/').split('/');
  const filename = pathParts[pathParts.length - 1] ?? '';
  const dotIdx = filename.lastIndexOf('.');
  const basename = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
  const extension = dotIdx >= 0 ? filename.slice(dotIdx + 1) : '';

  return {
    path: virtualPath,
    basename,
    extension,
    frontmatter,
    frontmatterLinks,
    links,
    embeds,
    tags,
    headings,
    blocks,
    content: body,
    contentHash,
    mtime: Date.now(),
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

// ─── Frontmatter Link Extraction ──────────────────────────

function extractFrontmatterLinks(
  fm: Record<string, unknown>
): FrontmatterLink[] {
  const result: FrontmatterLink[] = [];

  for (const [key, value] of Object.entries(fm)) {
    if (typeof value === 'string') {
      // Detect [[wikilinks]] in frontmatter string values
      const links = value.match(/\[\[([^\]]+)\]\]/g);
      if (links) {
        for (const link of links) {
          const inner = link.slice(2, -2);
          const pipeIdx = inner.indexOf('|');
          const linkText = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
          const displayText = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : undefined;
          result.push({ key, link: linkText, original: link, displayText });
        }
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          const links = item.match(/\[\[([^\]]+)\]\]/g);
          if (links) {
            for (const link of links) {
              const inner = link.slice(2, -2);
              result.push({ key, link: inner, original: link });
            }
          }
        }
      }
    }
  }

  return result;
}

// ─── Headings Extraction ──────────────────────────────────

function extractHeadings(
  body: string,
  mdast: Root
): Heading[] {
  const headings: Heading[] = [];

  visit(mdast, 'heading', (node: MdastHeading) => {
    const text = node.children
      .filter((c): c is Text => c.type === 'text')
      .map(c => c.value)
      .join('');

    const startOffset = node.position?.start.offset ?? 0;
    const endOffset = node.position?.end.offset ?? 0;

    headings.push({
      text,
      level: node.depth,
      position: rangeFromOffsets(body, startOffset, endOffset),
    });
  });

  return headings;
}

// ─── AST Text Extraction (wikilinks & tags) ───────────────

function extractFromAst(
  body: string,
  mdast: Root,
  links: Wikilink[],
  embeds: Wikilink[],
  tags: Tag[]
): void {
  // Walk all text nodes that are NOT inside code blocks or YAML frontmatter
  visit(mdast, (node: unknown) => {
    // Skip YAML frontmatter nodes (already handled by gray-matter)
    if ((node as Yaml).type === 'yaml') {
      return; // skip, children won't be visited automatically in this visit mode
    }
    // Skip code blocks and inline code
    if ((node as Code).type === 'code') return;
    if ((node as InlineCode).type === 'inlineCode') return;

    // Only process text nodes
    if ((node as Text).type !== 'text') return;
    const textNode = node as Text;
    if (!textNode.value || !textNode.position) return;

    const text = textNode.value;
    const baseOffset = textNode.position.start.offset;
    if (baseOffset === undefined) return;

    const offset = baseOffset; // captured for TS narrowing

    // Extract wikilinks and embeds
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(text)) !== null) {
      const isEmbed = match[1] === '!';
      const inner = match[2];
      const parsed = parseWikilinkTarget(inner);
      const startOffset = offset + match.index;
      const endOffset = startOffset + match[0].length;

      const wl: Wikilink = {
        target: parsed.target,
        alias: parsed.alias,
        section: parsed.section,
        blockRef: parsed.blockRef,
        isEmbed,
        original: match[0],
        position: rangeFromOffsets(body, startOffset, endOffset),
      };

      if (isEmbed) {
        embeds.push(wl);
      } else {
        links.push(wl);
      }
    }

    // Extract tags
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(text)) !== null) {
      const tagName = match[1];
      // Exclude heading markers (## or more)
      if (/^#{2,}/.test(tagName)) continue;

      const startOffset = offset + match.index + (match[0].length - match[1].length);
      const endOffset = startOffset + tagName.length;

      tags.push({
        name: tagName,
        position: rangeFromOffsets(body, startOffset, endOffset),
      });
    }
  });
}

// ─── Block ID Extraction ──────────────────────────────────

function extractBlockIds(body: string): BlockId[] {
  const blocks: BlockId[] = [];
  let match: RegExpExecArray | null;
  BLOCK_ID_RE.lastIndex = 0;
  while ((match = BLOCK_ID_RE.exec(body)) !== null) {
    blocks.push({
      id: match[1],
      position: rangeFromOffsets(body, match.index, match.index + match[0].length),
    });
  }
  return blocks;
}

// ─── Path Utilities ──────────────────────────────────────

/**
 * Normalize a file path to use forward slashes and remove trailing slash.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Get the vault-relative path given an absolute path and vault root.
 */
export function getRelativePath(absolutePath: string, vaultRoot: string): string {
  const rel = absolutePath.replace(vaultRoot, '');
  return normalizePath(rel).replace(/^\//, '');
}
