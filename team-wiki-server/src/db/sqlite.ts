import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';
import type { DbAdapter, DbConfig, Message, Session } from './types.js';

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

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id, updated_at);
    `);

    this.db = db;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async createSession(userId: string, title?: string): Promise<Session> {
    const db = this.getDb();
    const now = Date.now();
    const id = uuidv4();

    db.prepare(`
      INSERT INTO sessions (id, user_id, title, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, '{}')
    `).run(id, userId, title || 'New Chat', now, now);

    return {
      id,
      userId,
      title: title || 'New Chat',
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const row = this.getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    return row ? mapSessionRow(row) : null;
  }

  async listSessions(userId: string, limit = 50): Promise<Session[]> {
    const rows = this.getDb().prepare(`
      SELECT * FROM sessions WHERE user_id = ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(userId, limit) as any[];

    return rows.map(mapSessionRow);
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

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('SQLite database not initialized. Call init() first.');
    }
    return this.db;
  }
}

function mapSessionRow(row: any): Session {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: JSON.parse(row.metadata || '{}'),
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
