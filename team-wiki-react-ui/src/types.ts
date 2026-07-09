export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: number;
  updatedAt: number;
}

export interface AdminUser extends User {
  vaultIds: string[];
  newPassword?: string;
}

export interface Vault {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface VaultStatus {
  id: string;
  name: string;
  path: string;
  files: number;
  status: {
    totalFiles: number;
    indexedFiles: number;
    lastUpdated: number | null;
    isIndexing: boolean;
    stalenessMs: number | null;
    vaultPath: string;
  };
}

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
  apiKey?: string;
}

export interface Overview {
  users: number;
  activeUsers: number;
  vaults: number;
  enabledVaults: number;
  models: number;
  enabledModels: number;
  defaultModel: string;
}

export interface UsageSummary {
  totalQuestions: number;
  totalTokens: number;
  totalElapsedMs: number;
  byUser: Array<{ userId: string; totalQuestions: number; totalTokens: number }>;
  byVault: Array<{ vaultId: string | null; totalQuestions: number; totalTokens: number }>;
}

export interface Session {
  id: string;
  userId: string;
  vaultId?: string | null;
  vaultIds?: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id?: number;
  sessionId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: string | ToolCall[];
  reasoningTrace?: ReasoningTrace;
  metadata?: Record<string, unknown> & { usage?: ChatUsage };
  usage?: ChatUsage;
  createdAt?: number;
}

export interface ChatUsage {
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedTotalTokens?: number;
}

export interface ToolCall {
  tool: string;
  args?: unknown;
  result?: string;
  durationMs?: number;
  vaultId?: string | null;
  vaultName?: string;
}

export interface ChatSource {
  title: string;
  path: string;
  vaultId?: string | null;
  vaultName?: string;
  snippet?: string;
  score?: number;
  tags?: string[];
}

export type ReasoningStatus = 'queued' | 'searching' | 'reading' | 'done' | 'weak_evidence' | 'error';

export interface ReasoningStep {
  type: 'tool_start' | 'tool_end';
  tool: string;
  args?: unknown;
  result?: string;
  durationMs?: number;
  createdAt: number;
}

export interface ReasoningLane {
  vaultId: string;
  vaultName: string;
  status: ReasoningStatus;
  startedAt?: number;
  durationMs?: number;
  steps: ReasoningStep[];
  sources: ChatSource[];
  summary?: string;
}

export interface ReasoningTrace {
  phase: 'idle' | 'retrieval' | 'synthesis' | 'done';
  lanes: ReasoningLane[];
  synthesis?: {
    status: 'idle' | 'running' | 'done';
    startedAt?: number;
    durationMs?: number;
  };
}

export interface SystemPromptResponse {
  basePrompt: string;
  source: 'database' | 'environment' | 'default';
  updatedAt: number | null;
  updatedBy: string | null;
  effectivePrompts: Array<{
    vaultId: string;
    vaultName: string;
    prompt: string;
  }>;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface MeResponse {
  user: User;
  vaults: Vault[];
}
