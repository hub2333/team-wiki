import { KnowledgeGraph } from './index.js';
import { VaultWatcher } from '../watcher/index.js';
import { resolveKnowledgeAgentPrompt } from '../agent/prompts.js';
import type { AppConfig } from '../config.js';
import type { Vault } from '../db/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('VaultManager');

export interface GraphContext {
  vault: Vault;
  graph: KnowledgeGraph;
  watcher: VaultWatcher;
  systemPrompt: string;
}

export class VaultGraphManager {
  private contexts = new Map<string, GraphContext>();

  constructor(private readonly baseConfig: AppConfig) {}

  async start(vaults: Vault[]): Promise<void> {
    for (const vault of vaults.filter(v => v.enabled)) {
      await this.startVault(vault);
    }
  }

  async sync(vaults: Vault[]): Promise<void> {
    const enabled = new Map(vaults.filter(v => v.enabled).map(vault => [vault.id, vault]));

    for (const [id, ctx] of this.contexts) {
      const next = enabled.get(id);
      if (!next || next.path !== ctx.vault.path || next.name !== ctx.vault.name) {
        await ctx.watcher.stop();
        this.contexts.delete(id);
      }
    }

    for (const vault of enabled.values()) {
      if (!this.contexts.has(vault.id)) {
        await this.startVault(vault);
      }
    }
  }

  async reindex(vault: Vault): Promise<GraphContext> {
    const existing = this.contexts.get(vault.id);
    if (existing) {
      await existing.watcher.stop();
      this.contexts.delete(vault.id);
    }

    if (!vault.enabled) {
      throw new Error(`Vault is disabled: ${vault.name}`);
    }

    await this.startVault(vault);
    return this.contexts.get(vault.id)!;
  }

  async stop(): Promise<void> {
    for (const ctx of this.contexts.values()) {
      await ctx.watcher.stop();
    }
    this.contexts.clear();
  }

  get(vaultId?: string | null): GraphContext | null {
    if (vaultId) {
      return this.contexts.get(vaultId) ?? null;
    }
    return this.first();
  }

  first(): GraphContext | null {
    return this.contexts.values().next().value ?? null;
  }

  list(): GraphContext[] {
    return [...this.contexts.values()];
  }

  listStatus() {
    return [...this.contexts.values()].map(ctx => ({
      id: ctx.vault.id,
      name: ctx.vault.name,
      path: ctx.vault.path,
      files: ctx.graph.nodes.size,
      status: ctx.graph.getStatus(),
    }));
  }

  private async startVault(vault: Vault): Promise<void> {
    const graph = new KnowledgeGraph();
    const config = {
      ...this.baseConfig,
      vaultPath: vault.path,
    };
    const watcher = new VaultWatcher(graph, config, {
      onIndexingStart: () => log.info('index_start', { vault: vault.name }),
      onIndexingComplete: (elapsed) =>
        log.info('index_done', { vault: vault.name, files: graph.nodes.size, elapsedMs: elapsed }),
      onError: (err) => log.error('watcher_error', { vault: vault.name, msg: err.message }),
      onFileChange: (path, action) => log.debug('file_change', { vault: vault.name, action, path }),
    });
    await watcher.start();
    const systemPrompt = resolveKnowledgeAgentPrompt(graph, config);
    this.contexts.set(vault.id, { vault, graph, watcher, systemPrompt });
  }
}
