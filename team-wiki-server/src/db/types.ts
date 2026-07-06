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
  toolCalls?: string;
  createdAt?: number;
}

export interface DbConfig {
  provider: 'sqlite' | 'postgres';
  path: string;
  url: string;
  ssl: boolean;
  poolMax: number;
}

export interface DbAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  createSession(userId: string, title?: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  listSessions(userId: string, limit?: number): Promise<Session[]>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  addMessage(msg: Message): Promise<number>;
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
}
