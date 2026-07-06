import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { DbAdapter, DbConfig, Message, Session } from './types.js';

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
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Chat',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at BIGINT NOT NULL
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id, updated_at);
    `);

    this.pool = pool;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async createSession(userId: string, title?: string): Promise<Session> {
    const pool = this.getPool();
    const now = Date.now();
    const id = uuidv4();
    const sessionTitle = title || 'New Chat';

    await pool.query(`
      INSERT INTO sessions (id, user_id, title, created_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
    `, [id, userId, sessionTitle, now, now]);

    return {
      id,
      userId,
      title: sessionTitle,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const result = await this.getPool().query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
  }

  async listSessions(userId: string, limit = 50): Promise<Session[]> {
    const result = await this.getPool().query(`
      SELECT * FROM sessions WHERE user_id = $1
      ORDER BY updated_at DESC LIMIT $2
    `, [userId, limit]);

    return result.rows.map(mapSessionRow);
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
      INSERT INTO messages (session_id, role, content, tool_calls, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [msg.sessionId, msg.role, msg.content, msg.toolCalls ?? null, now]);

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

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized. Call init() first.');
    }
    return this.pool;
  }
}

function mapSessionRow(row: any): Session {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: row.metadata ?? {},
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
