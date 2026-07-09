import { Pool } from 'pg';
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

export class PostgresAdapter implements DbAdapter {
  private pool: Pool | null = null;

  constructor(private readonly config: DbConfig) {}

  async init(): Promise<void> {
    if (this.pool) return;
    if (!this.config.url) {
      throw new Error('DATABASE_URL is required when DB_PROVIDER=postgres');
    }

    const pool = new Pool({
      connectionString: this.config.url,
      max: this.config.poolMax,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_vaults (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, vault_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        updated_by TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        vault_id TEXT,
        title TEXT NOT NULL DEFAULT 'New Chat',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await pool.query(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS vault_id TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at BIGINT NOT NULL
      );
    `);

    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        vault_id TEXT,
        session_id TEXT,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        total_tokens BIGINT DEFAULT 0,
        elapsed_ms BIGINT DEFAULT 0,
        created_at BIGINT NOT NULL
      );
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_vault ON sessions(vault_id, updated_at);');

    this.pool = pool;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async createSession(userId: string, title?: string, vaultId?: string | null, metadata?: Record<string, unknown>): Promise<Session> {
    const pool = this.getPool();
    const now = Date.now();
    const id = uuidv4();
    const sessionTitle = title || 'New Chat';
    const sessionMetadata = metadata ?? {};

    await pool.query(`
      INSERT INTO sessions (id, user_id, vault_id, title, created_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, userId, vaultId ?? null, sessionTitle, now, now, sessionMetadata]);

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
    const result = await this.getPool().query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
  }

  async listSessions(userId: string, limit = 50, vaultId?: string | null): Promise<Session[]> {
    const result = await this.getPool().query(`
          SELECT * FROM sessions WHERE user_id = $1
          ORDER BY updated_at DESC LIMIT $2
        `, [userId, Math.max(limit * 3, limit)]);

    const sessions = result.rows.map(mapSessionRow);
    return (vaultId ? sessions.filter(session => sessionVaultIds(session).includes(vaultId)) : sessions).slice(0, limit);
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.getPool().query(
      'UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3',
      [title, Date.now(), sessionId]
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.getPool().query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  async addMessage(msg: Message): Promise<number> {
    const pool = this.getPool();
    const now = msg.createdAt ?? Date.now();

    const result = await pool.query(`
      INSERT INTO messages (session_id, role, content, tool_calls, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [msg.sessionId, msg.role, msg.content, msg.toolCalls ?? null, msg.metadata ?? {}, now]);

    await pool.query(
      'UPDATE sessions SET updated_at = $1 WHERE id = $2',
      [now, msg.sessionId]
    );

    return Number(result.rows[0]?.id ?? 0);
  }

  async getMessages(sessionId: string, limit = 100): Promise<Message[]> {
    const result = await this.getPool().query(`
      SELECT * FROM messages WHERE session_id = $1
      ORDER BY created_at ASC LIMIT $2
    `, [sessionId, limit]);

    return result.rows.map(mapMessageRow);
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

    await this.getPool().query(`
      INSERT INTO users (id, username, display_name, role, status, password_hash, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [user.id, user.username, user.displayName, user.role, user.status, user.passwordHash, now, now]);
    return user;
  }

  async updateUser(id: string, patch: UpdateUserInput): Promise<User | null> {
    const current = await this.getUser(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await this.getPool().query(`
      UPDATE users
      SET username = $1, display_name = $2, role = $3, status = $4, password_hash = $5, updated_at = $6
      WHERE id = $7
    `, [next.username, next.displayName, next.role, next.status, next.passwordHash, next.updatedAt, id]);
    return (await this.getUser(id))!;
  }

  async deleteUser(id: string): Promise<void> {
    await this.getPool().query('DELETE FROM users WHERE id = $1', [id]);
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.getPool().query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const result = await this.getPool().query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async listUsers(): Promise<User[]> {
    const result = await this.getPool().query('SELECT * FROM users ORDER BY created_at ASC');
    return result.rows.map(mapUserRow);
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

    await this.getPool().query(`
      INSERT INTO vaults (id, name, path, enabled, created_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [vault.id, vault.name, vault.path, vault.enabled, now, now, vault.metadata]);
    return vault;
  }

  async updateVault(id: string, patch: UpdateVaultInput): Promise<Vault | null> {
    const current = await this.getVault(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await this.getPool().query(`
      UPDATE vaults
      SET name = $1, path = $2, enabled = $3, metadata = $4, updated_at = $5
      WHERE id = $6
    `, [next.name, next.path, next.enabled, next.metadata, next.updatedAt, id]);
    return (await this.getVault(id))!;
  }

  async deleteVault(id: string): Promise<void> {
    await this.getPool().query('DELETE FROM vaults WHERE id = $1', [id]);
  }

  async getVault(id: string): Promise<Vault | null> {
    const result = await this.getPool().query('SELECT * FROM vaults WHERE id = $1', [id]);
    return result.rows[0] ? mapVaultRow(result.rows[0]) : null;
  }

  async listVaults(options?: { enabledOnly?: boolean }): Promise<Vault[]> {
    const result = options?.enabledOnly
      ? await this.getPool().query('SELECT * FROM vaults WHERE enabled = true ORDER BY created_at ASC')
      : await this.getPool().query('SELECT * FROM vaults ORDER BY created_at ASC');
    return result.rows.map(mapVaultRow);
  }

  async setUserVaults(userId: string, vaultIds: string[]): Promise<void> {
    const pool = this.getPool();
    await pool.query('DELETE FROM user_vaults WHERE user_id = $1', [userId]);
    for (const vaultId of vaultIds) {
      await pool.query(`
        INSERT INTO user_vaults (user_id, vault_id)
        VALUES ($1, $2) ON CONFLICT DO NOTHING
      `, [userId, vaultId]);
    }
  }

  async getUserVaultIds(userId: string): Promise<string[]> {
    const result = await this.getPool().query('SELECT vault_id FROM user_vaults WHERE user_id = $1', [userId]);
    return result.rows.map(row => String(row.vault_id));
  }

  async createModelConfig(input: CreateModelConfigInput): Promise<ModelConfig> {
    const now = Date.now();
    const id = uuidv4();
    if (input.isDefault) {
      await this.getPool().query('UPDATE model_configs SET is_default = false');
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

    await this.getPool().query(`
      INSERT INTO model_configs (id, name, base_url, model, api_key, enabled, is_default, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [model.id, model.name, model.baseUrl, model.model, model.apiKey, model.enabled, model.isDefault, now, now]);
    return model;
  }

  async updateModelConfig(id: string, patch: UpdateModelConfigInput): Promise<ModelConfig | null> {
    const current = await this.getModelConfig(id);
    if (!current) return null;
    if (patch.isDefault) {
      await this.getPool().query('UPDATE model_configs SET is_default = false WHERE id <> $1', [id]);
    }
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await this.getPool().query(`
      UPDATE model_configs
      SET name = $1, base_url = $2, model = $3, api_key = $4, enabled = $5, is_default = $6, updated_at = $7
      WHERE id = $8
    `, [next.name, next.baseUrl, next.model, next.apiKey, next.enabled, next.isDefault, next.updatedAt, id]);
    return (await this.getModelConfig(id))!;
  }

  async deleteModelConfig(id: string): Promise<void> {
    await this.getPool().query('DELETE FROM model_configs WHERE id = $1', [id]);
  }

  async getModelConfig(id: string): Promise<ModelConfig | null> {
    const result = await this.getPool().query('SELECT * FROM model_configs WHERE id = $1', [id]);
    return result.rows[0] ? mapModelConfigRow(result.rows[0]) : null;
  }

  async getDefaultModelConfig(): Promise<ModelConfig | null> {
    const result = await this.getPool().query(`
      SELECT * FROM model_configs
      WHERE enabled = true
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `);
    return result.rows[0] ? mapModelConfigRow(result.rows[0]) : null;
  }

  async listModelConfigs(): Promise<ModelConfig[]> {
    const result = await this.getPool().query('SELECT * FROM model_configs ORDER BY is_default DESC, created_at ASC');
    return result.rows.map(mapModelConfigRow);
  }

  async getSetting(key: string): Promise<AppSetting | null> {
    const result = await this.getPool().query('SELECT * FROM app_settings WHERE key = $1', [key]);
    return result.rows[0] ? mapSettingRow(result.rows[0]) : null;
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<AppSetting> {
    const now = Date.now();
    await this.getPool().query(`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
    `, [key, value, now, updatedBy ?? null]);
    return { key, value, updatedAt: now, updatedBy: updatedBy ?? null };
  }

  async addUsageEvent(event: UsageEventInput): Promise<void> {
    await this.getPool().query(`
      INSERT INTO usage_events (
        user_id, vault_id, session_id, input_tokens, output_tokens, total_tokens, elapsed_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      event.userId,
      event.vaultId ?? null,
      event.sessionId ?? null,
      event.inputTokens ?? 0,
      event.outputTokens ?? 0,
      event.totalTokens ?? 0,
      event.elapsedMs ?? 0,
      Date.now(),
    ]);
  }

  async getUsageSummary(): Promise<UsageSummary> {
    const total = await this.getPool().query(`
      SELECT
        COUNT(*) AS total_questions,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(elapsed_ms), 0) AS total_elapsed_ms
      FROM usage_events
    `);
    const byUser = await this.getPool().query(`
      SELECT user_id, COUNT(*) AS total_questions, COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_events
      GROUP BY user_id
      ORDER BY total_questions DESC
      LIMIT 10
    `);
    const byVault = await this.getPool().query(`
      SELECT vault_id, COUNT(*) AS total_questions, COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_events
      GROUP BY vault_id
      ORDER BY total_questions DESC
      LIMIT 10
    `);
    const totalRow = total.rows[0] ?? {};

    return {
      totalQuestions: Number(totalRow.total_questions ?? 0),
      totalTokens: Number(totalRow.total_tokens ?? 0),
      totalElapsedMs: Number(totalRow.total_elapsed_ms ?? 0),
      byUser: byUser.rows.map(row => ({
        userId: String(row.user_id),
        totalQuestions: Number(row.total_questions),
        totalTokens: Number(row.total_tokens),
      })),
      byVault: byVault.rows.map(row => ({
        vaultId: row.vault_id ? String(row.vault_id) : null,
        totalQuestions: Number(row.total_questions),
        totalTokens: Number(row.total_tokens),
      })),
    };
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized. Call init() first.');
    }
    return this.pool;
  }
}

function mapSessionRow(row: any): Session {
  const metadata = row.metadata ?? {};
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
    metadata: row.metadata ?? {},
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
    metadata: row.metadata ?? {},
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
