import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';
import type {
  CreateModelConfigInput,
  CreateUserInput,
  CreateVaultInput,
  DbAdapter,
  DbConfig,
  Message,
  ModelConfig,
  Session,
  AppSetting,
  UpdateModelConfigInput,
  UpdateUserInput,
  UpdateVaultInput,
  UsageEventInput,
  UsageSummary,
  User,
  Vault,
} from './types.js';

export class SqliteAdapter implements DbAdapter {
  private db: DatabaseSync | null = null;

  constructor(private readonly config: DbConfig) {}

  async init(): Promise<void> {
    if (this.db) return;

    const dir = dirname(this.config.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new DatabaseSync(this.config.path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS user_vaults (
        user_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        PRIMARY KEY (user_id, vault_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        vault_id TEXT,
        title TEXT DEFAULT 'New Chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        vault_id TEXT,
        session_id TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        elapsed_ms INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id, updated_at);

    `);

    this.db = db;
    this.ensureColumn('sessions', 'vault_id', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_vault
        ON sessions(vault_id, updated_at);
    `);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async createSession(userId: string, title?: string, vaultId?: string | null, metadata?: Record<string, unknown>): Promise<Session> {
    const db = this.getDb();
    const now = Date.now();
    const id = uuidv4();
    const sessionTitle = title || 'New Chat';
    const sessionMetadata = metadata ?? {};

    db.prepare(`
      INSERT INTO sessions (id, user_id, vault_id, title, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, vaultId ?? null, sessionTitle, now, now, JSON.stringify(sessionMetadata));

    return {
      id,
      userId,
      vaultId: vaultId ?? null,
      vaultIds: parseVaultIds(sessionMetadata, vaultId),
      title: sessionTitle,
      createdAt: now,
      updatedAt: now,
      metadata: sessionMetadata,
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const row = this.getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    return row ? mapSessionRow(row) : null;
  }

  async listSessions(userId: string, limit = 50, vaultId?: string | null): Promise<Session[]> {
    const db = this.getDb();
    const rows = db.prepare(`
          SELECT * FROM sessions WHERE user_id = ?
          ORDER BY updated_at DESC LIMIT ?
        `).all(userId, Math.max(limit * 3, limit)) as any[];

    const sessions = rows.map(mapSessionRow);
    return (vaultId ? sessions.filter(session => sessionVaultIds(session).includes(vaultId)) : sessions).slice(0, limit);
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    this.getDb()
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const db = this.getDb();
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  async addMessage(msg: Message): Promise<number> {
    const db = this.getDb();
    const now = msg.createdAt ?? Date.now();

    const result = db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msg.sessionId, msg.role, msg.content, msg.toolCalls ?? null, now) as {
      lastInsertRowid?: number | bigint;
    };

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(now, msg.sessionId);

    return Number(result.lastInsertRowid ?? 0);
  }

  async getMessages(sessionId: string, limit = 100): Promise<Message[]> {
    const rows = this.getDb().prepare(`
      SELECT * FROM messages WHERE session_id = ?
      ORDER BY created_at ASC LIMIT ?
    `).all(sessionId, limit) as any[];

    return rows.map(mapMessageRow);
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const now = Date.now();
    const id = uuidv4();
    const user = {
      id,
      username: input.username,
      displayName: input.displayName || input.username,
      role: input.role || 'user',
      status: input.status || 'active',
      passwordHash: input.passwordHash,
      createdAt: now,
      updatedAt: now,
    } satisfies User;

    this.getDb().prepare(`
      INSERT INTO users (id, username, display_name, role, status, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.displayName, user.role, user.status, user.passwordHash, now, now);

    return user;
  }

  async updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    const current = await this.getUser(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.getDb().prepare(`
      UPDATE users
      SET username = ?, display_name = ?, role = ?, status = ?, password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(next.username, next.displayName, next.role, next.status, next.passwordHash, next.updatedAt, id);
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  async getUser(id: string): Promise<User | null> {
    const row = this.getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    return row ? mapUserRow(row) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const row = this.getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    return row ? mapUserRow(row) : null;
  }

  async listUsers(): Promise<User[]> {
    const rows = this.getDb().prepare('SELECT * FROM users ORDER BY created_at ASC').all() as any[];
    return rows.map(mapUserRow);
  }

  async createVault(input: CreateVaultInput): Promise<Vault> {
    const now = Date.now();
    const id = uuidv4();
    const vault = {
      id,
      name: input.name,
      path: input.path,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    } satisfies Vault;

    this.getDb().prepare(`
      INSERT INTO vaults (id, name, path, enabled, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(vault.id, vault.name, vault.path, vault.enabled ? 1 : 0, now, now, JSON.stringify(vault.metadata));

    return vault;
  }

  async updateVault(id: string, patch: UpdateVaultInput): Promise<Vault | null> {
    const current = await this.getVault(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.getDb().prepare(`
      UPDATE vaults
      SET name = ?, path = ?, enabled = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.path, next.enabled ? 1 : 0, JSON.stringify(next.metadata), next.updatedAt, id);
    return (await this.getVault(id))!;
  }

  async deleteVault(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM vaults WHERE id = ?').run(id);
  }

  async getVault(id: string): Promise<Vault | null> {
    const row = this.getDb().prepare('SELECT * FROM vaults WHERE id = ?').get(id) as any;
    return row ? mapVaultRow(row) : null;
  }

  async listVaults(options?: { enabledOnly?: boolean }): Promise<Vault[]> {
    const rows = options?.enabledOnly
      ? this.getDb().prepare('SELECT * FROM vaults WHERE enabled = 1 ORDER BY created_at ASC').all() as any[]
      : this.getDb().prepare('SELECT * FROM vaults ORDER BY created_at ASC').all() as any[];
    return rows.map(mapVaultRow);
  }

  async setUserVaults(userId: string, vaultIds: string[]): Promise<void> {
    const db = this.getDb();
    db.prepare('DELETE FROM user_vaults WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT OR IGNORE INTO user_vaults (user_id, vault_id) VALUES (?, ?)');
    for (const vaultId of vaultIds) {
      insert.run(userId, vaultId);
    }
  }

  async getUserVaultIds(userId: string): Promise<string[]> {
    const rows = this.getDb().prepare('SELECT vault_id FROM user_vaults WHERE user_id = ?').all(userId) as any[];
    return rows.map(row => String(row.vault_id));
  }

  async createModelConfig(input: CreateModelConfigInput): Promise<ModelConfig> {
    const now = Date.now();
    const id = uuidv4();
    if (input.isDefault) {
      this.getDb().prepare('UPDATE model_configs SET is_default = 0').run();
    }

    const model = {
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    } satisfies ModelConfig;

    this.getDb().prepare(`
      INSERT INTO model_configs (id, name, base_url, model, api_key, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model.id, model.name, model.baseUrl, model.model, model.apiKey, model.enabled ? 1 : 0, model.isDefault ? 1 : 0, now, now);

    return model;
  }

  async updateModelConfig(id: string, patch: UpdateModelConfigInput): Promise<ModelConfig | null> {
    const current = await this.getModelConfig(id);
    if (!current) return null;
    if (patch.isDefault) {
      this.getDb().prepare('UPDATE model_configs SET is_default = 0 WHERE id <> ?').run(id);
    }
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.getDb().prepare(`
      UPDATE model_configs
      SET name = ?, base_url = ?, model = ?, api_key = ?, enabled = ?, is_default = ?, updated_at = ?
      WHERE id = ?
    `).run(next.name, next.baseUrl, next.model, next.apiKey, next.enabled ? 1 : 0, next.isDefault ? 1 : 0, next.updatedAt, id);
    return (await this.getModelConfig(id))!;
  }

  async deleteModelConfig(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM model_configs WHERE id = ?').run(id);
  }

  async getModelConfig(id: string): Promise<ModelConfig | null> {
    const row = this.getDb().prepare('SELECT * FROM model_configs WHERE id = ?').get(id) as any;
    return row ? mapModelConfigRow(row) : null;
  }

  async getDefaultModelConfig(): Promise<ModelConfig | null> {
    const row = this.getDb()
      .prepare('SELECT * FROM model_configs WHERE enabled = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1')
      .get() as any;
    return row ? mapModelConfigRow(row) : null;
  }

  async listModelConfigs(): Promise<ModelConfig[]> {
    const rows = this.getDb().prepare('SELECT * FROM model_configs ORDER BY is_default DESC, created_at ASC').all() as any[];
    return rows.map(mapModelConfigRow);
  }

  async getSetting(key: string): Promise<AppSetting | null> {
    const row = this.getDb().prepare('SELECT * FROM app_settings WHERE key = ?').get(key) as any;
    return row ? mapSettingRow(row) : null;
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<AppSetting> {
    const now = Date.now();
    this.getDb().prepare(`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(key, value, now, updatedBy ?? null);
    return { key, value, updatedAt: now, updatedBy: updatedBy ?? null };
  }

  async addUsageEvent(event: UsageEventInput): Promise<void> {
    this.getDb().prepare(`
      INSERT INTO usage_events (
        user_id, vault_id, session_id, input_tokens, output_tokens, total_tokens, elapsed_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.userId,
      event.vaultId ?? null,
      event.sessionId ?? null,
      event.inputTokens ?? 0,
      event.outputTokens ?? 0,
      event.totalTokens ?? 0,
      event.elapsedMs ?? 0,
      Date.now()
    );
  }

  async getUsageSummary(): Promise<UsageSummary> {
    const db = this.getDb();
    const total = db.prepare(`
      SELECT
        COUNT(*) AS total_questions,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(elapsed_ms), 0) AS total_elapsed_ms
      FROM usage_events
    `).get() as any;
    const byUser = db.prepare(`
      SELECT user_id, COUNT(*) AS total_questions, COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_events
      GROUP BY user_id
      ORDER BY total_questions DESC
      LIMIT 10
    `).all() as any[];
    const byVault = db.prepare(`
      SELECT vault_id, COUNT(*) AS total_questions, COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_events
      GROUP BY vault_id
      ORDER BY total_questions DESC
      LIMIT 10
    `).all() as any[];

    return {
      totalQuestions: Number(total.total_questions ?? 0),
      totalTokens: Number(total.total_tokens ?? 0),
      totalElapsedMs: Number(total.total_elapsed_ms ?? 0),
      byUser: byUser.map(row => ({
        userId: String(row.user_id),
        totalQuestions: Number(row.total_questions),
        totalTokens: Number(row.total_tokens),
      })),
      byVault: byVault.map(row => ({
        vaultId: row.vault_id ? String(row.vault_id) : null,
        totalQuestions: Number(row.total_questions),
        totalTokens: Number(row.total_tokens),
      })),
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.getDb().prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some(col => col.name === column)) {
      this.getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('SQLite database not initialized. Call init() first.');
    }
    return this.db;
  }
}

function mapSessionRow(row: any): Session {
  const metadata = JSON.parse(row.metadata || '{}');
  return {
    id: row.id,
    userId: row.user_id,
    vaultId: row.vault_id ?? null,
    vaultIds: parseVaultIds(metadata, row.vault_id ?? null),
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata,
  };
}

function mapMessageRow(row: any): Message {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function mapUserRow(row: any): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapVaultRow(row: any): Vault {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

function mapModelConfigRow(row: any): ModelConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapSettingRow(row: any): AppSetting {
  return {
    key: row.key,
    value: row.value,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

function sessionVaultIds(session: Session): string[] {
  return session.vaultIds && session.vaultIds.length
    ? session.vaultIds
    : session.vaultId
      ? [session.vaultId]
      : [];
}

function parseVaultIds(metadata: Record<string, unknown>, fallback?: string | null): string[] {
  const raw = metadata.vaultIds;
  if (Array.isArray(raw)) {
    return raw.map(id => String(id)).filter(Boolean);
  }
  return fallback ? [fallback] : [];
}
