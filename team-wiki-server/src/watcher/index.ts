/**
 * File system watcher that monitors the vault for changes.
 *
 * Uses chokidar with debounce to batch rapid changes.
 * On git pull, multiple files change rapidly — debounce prevents
 * redundant re-indexing of the same file.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { readdirSync, statSync, type Stats } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, relative } from 'node:path';
import pMap from 'p-map';
import { type KnowledgeGraph } from '../graph/index.js';
import { parseMarkdownFile } from '../parser/index.js';
import type { ServerConfig } from '../types.js';

export interface WatcherEvents {
  onIndexingStart?: () => void;
  onIndexingComplete?: (elapsed: number) => void;
  onError?: (error: Error) => void;
  onFileChange?: (path: string, action: 'add' | 'change' | 'unlink' | 'rename') => void;
}

export class VaultWatcher {
  private graph: KnowledgeGraph;
  private config: ServerConfig;
  private watcher: FSWatcher | null = null;
  private events?: WatcherEvents;
  private pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  private isShuttingDown = false;
  private operationQueue: Array<() => Promise<void>> = [];
  private isProcessing = false;

  constructor(graph: KnowledgeGraph, config: ServerConfig, events?: WatcherEvents) {
    this.graph = graph;
    this.config = config;
    this.events = events;
  }

  /**
   * Start watching the vault directory.
   * Returns the KnowledgeGraph ready to use (initial index built).
   */
  async start(): Promise<KnowledgeGraph> {
    // 1. Build initial index
    await this.buildInitialIndex();

    // 2. Start file watcher
    this.startWatcher();

    return this.graph;
  }

  /**
   * Stop watching and clean up.
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // Clear pending debounce timers
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();
  }

  /**
   * Trigger a full reindex from scratch.
   */
  async fullReindex(): Promise<void> {
    await this.buildInitialIndex();
  }

  // ─── Initial Index Build ──────────────────────────────

  private async buildInitialIndex(): Promise<void> {
    const startTime = Date.now();
    this.events?.onIndexingStart?.();

    try {
      // Scan vault recursively for .md files
      const mdFiles = this.scanForMarkdownFiles(this.config.vaultPath);

      // Parse files with concurrency control
      const metadatas = await pMap(
        mdFiles,
        (filePath: string) => {
          try {
            return parseMarkdownFile(filePath);
          } catch (err) {
            this.events?.onError?.(err instanceof Error ? err : new Error(String(err)));
            return null;
          }
        },
        { concurrency: this.config.indexConcurrency }
      );

      const valid = metadatas.filter((m): m is NonNullable<typeof m> => m !== null);

      // Build the graph
      this.graph.build(valid, this.config.vaultPath);

      const elapsed = Date.now() - startTime;
      this.events?.onIndexingComplete?.(elapsed);
    } catch (err) {
      this.events?.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Recursively scan a directory for .md files, respecting ignore patterns.
   */
  private scanForMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    const ignorePatterns = this.config.ignorePatterns ?? [];

    const walk = (currentDir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(currentDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const relPath = relative(this.config.vaultPath, fullPath);

        // Check ignore patterns
        if (this.config.ignoreDotfiles && entry.startsWith('.')) continue;
        if (ignorePatterns.some(p => relPath.startsWith(p.replace(/\*\*$/, '')))) continue;

        let stats: Stats;
        try {
          stats = statSync(fullPath);
        } catch {
          continue;
        }

        if (stats.isDirectory()) {
          walk(fullPath);
        } else if (stats.isFile() && entry.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }

  // ─── File Watcher ─────────────────────────────────────

  private startWatcher(): void {
    const ignorePatterns: Array<string | RegExp> = [...(this.config.ignorePatterns ?? [])];
    if (this.config.ignoreDotfiles) {
      ignorePatterns.push(/(^|[\\/])\../);
    }

    this.watcher = chokidar.watch(this.config.vaultPath, {
      ignored: ignorePatterns,
      persistent: true,
      ignoreInitial: true, // we already built the initial index
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath: string) => {
        if (!filePath.endsWith('.md')) return;
        this.events?.onFileChange?.(filePath, 'add');
        this.debounceReindex(filePath);
      })
      .on('change', (filePath: string) => {
        if (!filePath.endsWith('.md')) return;
        this.events?.onFileChange?.(filePath, 'change');
        this.debounceReindex(filePath);
      })
      .on('unlink', (filePath: string) => {
        if (!filePath.endsWith('.md')) return;
        this.events?.onFileChange?.(filePath, 'unlink');
        this.debounceReindex(filePath);
      });
  }

  /**
   * Debounce re-index requests for the same file.
   * Prevents redundant processing during batch operations (e.g., git pull).
   */
  private debounceReindex(filePath: string): void {
    if (this.isShuttingDown) return;

    // Cancel existing timer for this file
    const existing = this.pendingChanges.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.pendingChanges.delete(filePath);
      this.enqueueOperation(() => this.processFileChange(filePath));
    }, this.config.watchDebounceMs);

    this.pendingChanges.set(filePath, timer);
  }

  /**
   * Process a file change event (add/change/unlink).
   */
  private async processFileChange(filePath: string): Promise<void> {
    try {
      // Get vault-relative path
      const relPath = relative(this.config.vaultPath, filePath).replace(/\\/g, '/');

      // Check if file still exists
      try {
        await access(filePath);

        // File exists: parse and upsert
        const metadata = parseMarkdownFile(filePath);
        // Fix path to be vault-relative
        metadata.path = relPath;
        this.graph.upsertFile(metadata);
      } catch {
        // File doesn't exist: remove from index
        const pathToRemove = this.graph.has(relPath) ? relPath : filePath;
        if (this.graph.has(pathToRemove)) {
          this.graph.removeFile(pathToRemove);
        }
      }
    } catch (err) {
      this.events?.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─── Operation Queue ──────────────────────────────────

  private enqueueOperation(op: () => Promise<void>): void {
    this.operationQueue.push(op);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.operationQueue.length > 0) {
      const op = this.operationQueue.shift();
      if (op) {
        try {
          await op();
        } catch (err) {
          console.error('[Watcher] op_failed', err);
        }
      }
    }

    this.isProcessing = false;
  }
}
