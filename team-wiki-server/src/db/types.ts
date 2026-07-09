export interface Session {
  id: string;
  userId: string;
  vaultId?: string | null;
  vaultIds?: string[];
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
  metadata?: Record<string, unknown>;
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
  createSession(userId: string, title?: string, vaultId?: string | null, metadata?: Record<string, unknown>): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  listSessions(userId: string, limit?: number, vaultId?: string | null): Promise<Session[]>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  addMessage(msg: Message): Promise<number>;
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
  createUser(input: CreateUserInput): Promise<User>;
  updateUser(id: string, patch: UpdateUserInput): Promise<User | null>;
  deleteUser(id: string): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  createVault(input: CreateVaultInput): Promise<Vault>;
  updateVault(id: string, patch: UpdateVaultInput): Promise<Vault | null>;
  deleteVault(id: string): Promise<void>;
  getVault(id: string): Promise<Vault | null>;
  listVaults(options?: { enabledOnly?: boolean }): Promise<Vault[]>;
  setUserVaults(userId: string, vaultIds: string[]): Promise<void>;
  getUserVaultIds(userId: string): Promise<string[]>;
  createModelConfig(input: CreateModelConfigInput): Promise<ModelConfig>;
  updateModelConfig(id: string, patch: UpdateModelConfigInput): Promise<ModelConfig | null>;
  deleteModelConfig(id: string): Promise<void>;
  getModelConfig(id: string): Promise<ModelConfig | null>;
  getDefaultModelConfig(): Promise<ModelConfig | null>;
  listModelConfigs(): Promise<ModelConfig[]>;
  getSetting(key: string): Promise<AppSetting | null>;
  setSetting(key: string, value: string, updatedBy?: string | null): Promise<AppSetting>;
  addUsageEvent(event: UsageEventInput): Promise<void>;
  getUsageSummary(): Promise<UsageSummary>;
}

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash: string;
}

export interface UpdateUserInput {
  username?: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash?: string;
}

export interface Vault {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface CreateVaultInput {
  name: string;
  path: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateVaultInput {
  name?: string;
  path?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: number;
  updatedBy?: string | null;
}

export interface CreateModelConfigInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface UpdateModelConfigInput {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface UsageEventInput {
  userId: string;
  vaultId?: string | null;
  sessionId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  elapsedMs?: number;
}

export interface UsageSummary {
  totalQuestions: number;
  totalTokens: number;
  totalElapsedMs: number;
  byUser: Array<{ userId: string; totalQuestions: number; totalTokens: number }>;
  byVault: Array<{ vaultId: string | null; totalQuestions: number; totalTokens: number }>;
}
