import type { AdminUser, LoginResponse, MeResponse, Message, ModelConfig, Overview, Session, SystemPromptResponse, UsageSummary, Vault, VaultStatus } from '../types';

const TOKEN_KEY = 'team-wiki-react-ui.token';

export function getStoredToken() {
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function storeToken(token: string) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    throw new Error(await readError(res));
  }

  return res.json() as Promise<T>;
}

export function login(username: string, password: string) {
  return apiFetch<LoginResponse>('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function getMe(token: string) {
  return apiFetch<MeResponse>('/api/me', token);
}

export function listSessions(token: string, vaultIds: string[]) {
  const query = vaultIds.length ? `?vaultIds=${encodeURIComponent(vaultIds.join(','))}` : '';
  return apiFetch<{ sessions: Session[] }>(`/api/sessions${query}`, token);
}

export function getSession(token: string, sessionId: string) {
  return apiFetch<{ session: Session; messages: Message[] }>(`/api/sessions/${sessionId}`, token);
}

export function renameSession(token: string, sessionId: string, title: string) {
  return apiFetch<{ session: Session }>(`/api/sessions/${sessionId}`, token, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
}

export function deleteSession(token: string, sessionId: string) {
  return apiFetch<{ ok: boolean }>(`/api/sessions/${sessionId}`, token, { method: 'DELETE' });
}

export function getVaultStatus(token: string, vaultId: string) {
  return apiFetch<{ vault: unknown; status: VaultStatus | null; indexed: boolean }>(
    `/api/vaults/${vaultId}/status`,
    token,
  );
}

export function getOverview(token: string) {
  return apiFetch<Overview>('/api/admin/overview', token);
}

export function listAdminVaults(token: string) {
  return apiFetch<{ vaults: Vault[] }>('/api/admin/vaults', token);
}

export function createVault(token: string, input: { name: string; path: string; enabled?: boolean }) {
  return apiFetch<{ vault: Vault }>('/api/admin/vaults', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateVault(token: string, id: string, input: Partial<Pick<Vault, 'name' | 'path' | 'enabled'>>) {
  return apiFetch<{ vault: Vault }>(`/api/admin/vaults/${id}`, token, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteVault(token: string, id: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/vaults/${id}`, token, { method: 'DELETE' });
}

export function reindexVault(token: string, id: string) {
  return apiFetch<{ ok: boolean; status: VaultStatus | null }>(`/api/admin/vaults/${id}/reindex`, token, { method: 'POST' });
}

export function listAdminUsers(token: string) {
  return apiFetch<{ users: AdminUser[] }>('/api/admin/users', token);
}

export function createUser(token: string, input: {
  username: string;
  displayName?: string;
  password: string;
  role: 'admin' | 'user';
  status?: 'active' | 'disabled';
  vaultIds: string[];
}) {
  return apiFetch<{ user: AdminUser }>('/api/admin/users', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateUser(token: string, id: string, input: Partial<AdminUser> & { password?: string }) {
  return apiFetch<{ user: AdminUser; vaultIds: string[] }>(`/api/admin/users/${id}`, token, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteUser(token: string, id: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/users/${id}`, token, { method: 'DELETE' });
}

export function listAdminModels(token: string) {
  return apiFetch<{ models: ModelConfig[] }>('/api/admin/models', token);
}

export function listModels(token: string) {
  return apiFetch<{ models: ModelConfig[] }>('/api/models', token);
}

export function createModel(token: string, input: {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled?: boolean;
  isDefault?: boolean;
}) {
  return apiFetch<{ model: ModelConfig }>('/api/admin/models', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateModel(token: string, id: string, input: Partial<ModelConfig>) {
  return apiFetch<{ model: ModelConfig }>(`/api/admin/models/${id}`, token, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteModel(token: string, id: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/models/${id}`, token, { method: 'DELETE' });
}

export function testModel(token: string, id: string) {
  return apiFetch<{ ok: boolean; checks: Record<string, boolean>; message: string; latencyMs?: number; status?: number }>(`/api/admin/models/${id}/test`, token, { method: 'POST' });
}

export function getUsageSummary(token: string) {
  return apiFetch<UsageSummary>('/api/admin/usage/summary', token);
}

export function getSystemPrompt(token: string) {
  return apiFetch<SystemPromptResponse>('/api/admin/system-prompt', token);
}

export function updateSystemPrompt(token: string, basePrompt: string) {
  return apiFetch<SystemPromptResponse>('/api/admin/system-prompt', token, {
    method: 'PUT',
    body: JSON.stringify({ basePrompt }),
  });
}

async function readError(res: Response) {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return body.error || body.message || text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}
