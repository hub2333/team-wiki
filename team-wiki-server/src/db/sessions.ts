import { getDb } from './index.js';
export type { Message, Session } from './types.js';
import type { Message, Session } from './types.js';

export async function createSession(userId: string, title?: string, vaultId?: string | null, metadata?: Record<string, unknown>): Promise<Session> {
  return getDb().createSession(userId, title, vaultId, metadata);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return getDb().getSession(sessionId);
}

export async function listSessions(userId: string, limit = 50, vaultId?: string | null): Promise<Session[]> {
  return getDb().listSessions(userId, limit, vaultId);
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await getDb().updateSessionTitle(sessionId, title);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await getDb().deleteSession(sessionId);
}

export async function addMessage(msg: Message): Promise<number> {
  return getDb().addMessage(msg);
}

export async function getMessages(sessionId: string, limit = 100): Promise<Message[]> {
  return getDb().getMessages(sessionId, limit);
}
