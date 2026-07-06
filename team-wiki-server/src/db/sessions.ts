/**
 * Session CRUD operations.
 * Each session represents a conversation thread with the AI agent.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from './index.js';

export interface Session {
  id: string;
  userId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface Message {
  id?: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: string; // JSON string of tool calls
  createdAt?: number;
}

// ─── Session Operations ───────────────────────────────────

export function createSession(userId: string, title?: string): Session {
  const db = getDb();
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

export function getSession(sessionId: string): Session | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

export function listSessions(userId: string, limit = 50): Session[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(userId, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    metadata: JSON.parse(r.metadata || '{}'),
  }));
}

export function updateSessionTitle(sessionId: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), sessionId);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ─── Message Operations ───────────────────────────────────

export function addMessage(msg: Message): number {
  const db = getDb();
  const now = msg.createdAt ?? Date.now();

  const result = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(msg.sessionId, msg.role, msg.content, msg.toolCalls ?? null, now);

  // Update session's updated_at
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(now, msg.sessionId);

  return Number(result.lastInsertRowid);
}

export function getMessages(sessionId: string, limit = 100): Message[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM messages WHERE session_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(sessionId, limit) as any[];

  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls ?? undefined,
    createdAt: r.created_at,
  }));
}
