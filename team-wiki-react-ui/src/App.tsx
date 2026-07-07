import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Database,
  FileSearch,
  Gauge,
  KeyRound,
  Library,
  Loader2,
  LogOut,
  MessageSquareText,
  Network,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import {
  createModel,
  createUser,
  createVault,
  deleteModel,
  deleteUser,
  deleteVault,
  getMe,
  getOverview,
  getSession,
  getStoredToken,
  getSystemPrompt,
  getUsageSummary,
  getVaultStatus,
  listAdminModels,
  listAdminUsers,
  listAdminVaults,
  listSessions,
  login,
  reindexVault,
  storeToken,
  testModel,
  updateModel,
  updateSystemPrompt,
  updateUser,
  updateVault,
} from './lib/api';
import { streamChat, type ChatEvent } from './lib/sse';
import { cn, compactNumber, formatTime, parseToolCalls } from './lib/utils';
import type { AdminUser, Message, ModelConfig, Overview, ReasoningTrace, Session, SystemPromptResponse, ToolCall, UsageSummary, User, Vault } from './types';

type ViewKey = 'ask' | 'knowledge' | 'people' | 'models' | 'agents' | 'insights' | 'settings';

const navItems: Array<{ key: ViewKey; label: string; icon: typeof MessageSquareText; adminOnly?: boolean }> = [
  { key: 'ask', label: 'Ask', icon: MessageSquareText },
  { key: 'knowledge', label: 'Knowledge', icon: Library, adminOnly: true },
  { key: 'people', label: 'People', icon: Users, adminOnly: true },
  { key: 'models', label: 'Models', icon: BrainCircuit, adminOnly: true },
  { key: 'agents', label: 'Agents', icon: Bot, adminOnly: true },
  { key: 'insights', label: 'Insights', icon: Gauge, adminOnly: true },
  { key: 'settings', label: 'Settings', icon: Settings, adminOnly: true },
];

const quickPrompts = [
  '总结这个知识库的核心内容',
  '列出最重要的 5 份文档',
  '给新人一份阅读路径',
  '这个知识库目前有哪些缺口？',
];

const DEFAULT_SCOPE_KEY = 'team-wiki-react-ui.defaultVaultIds';

function loadDefaultVaultIds(): string[] {
  try {
    const raw = window.localStorage.getItem(DEFAULT_SCOPE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(id => String(id)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function storeDefaultVaultIds(vaultIds: string[]) {
  window.localStorage.setItem(DEFAULT_SCOPE_KEY, JSON.stringify(vaultIds));
}

function emptyReasoningTrace(): ReasoningTrace {
  return {
    phase: 'idle',
    lanes: [],
    synthesis: { status: 'idle' },
  };
}

function applyReasoningEvent(trace: ReasoningTrace, event: ChatEvent): ReasoningTrace {
  const now = Date.now();
  if (event.type === 'sub_agent_start') {
    return upsertReasoningLane({ ...trace, phase: 'retrieval' }, event.vaultId, event.vaultName, lane => ({
      ...lane,
      status: event.status,
      startedAt: lane.startedAt ?? now,
    }));
  }
  if (event.type === 'sub_agent_progress') {
    return upsertReasoningLane({ ...trace, phase: 'retrieval' }, event.vaultId, event.vaultName, lane => ({
      ...lane,
      status: event.status,
      steps: [...lane.steps, { ...event.step, createdAt: now }],
    }));
  }
  if (event.type === 'sub_agent_done') {
    return upsertReasoningLane({ ...trace, phase: 'retrieval' }, event.vaultId, event.vaultName, lane => ({
      ...lane,
      status: event.status,
      durationMs: event.durationMs,
      summary: event.summary,
      sources: event.sources ?? [],
    }));
  }
  if (event.type === 'synthesis_start') {
    return {
      ...trace,
      phase: 'synthesis',
      synthesis: { status: 'running', startedAt: now },
    };
  }
  if (event.type === 'synthesis_done') {
    return {
      ...trace,
      phase: 'done',
      synthesis: { ...trace.synthesis, status: 'done', durationMs: event.durationMs },
    };
  }
  return trace;
}

function upsertReasoningLane(
  trace: ReasoningTrace,
  vaultId: string,
  vaultName: string,
  update: (lane: ReasoningTrace['lanes'][number]) => ReasoningTrace['lanes'][number],
): ReasoningTrace {
  const existing = trace.lanes.find(lane => lane.vaultId === vaultId);
  const base = existing ?? {
    vaultId,
    vaultName,
    status: 'queued' as const,
    steps: [],
    sources: [],
  };
  const nextLane = update(base);
  return {
    ...trace,
    lanes: existing
      ? trace.lanes.map(lane => lane.vaultId === vaultId ? nextLane : lane)
      : [...trace.lanes, nextLane],
  };
}

export default function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(getStoredToken);
  const [view, setView] = useState<ViewKey>('ask');
  const [defaultVaultIds, setDefaultVaultIds] = useState(loadDefaultVaultIds);
  const [selectedVaultIds, setSelectedVaultIds] = useState<string[]>([]);
  const [scopeSettingsOpen, setScopeSettingsOpen] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [reasoningTrace, setReasoningTrace] = useState<ReasoningTrace>(emptyReasoningTrace);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');

  const meQuery = useQuery({
    queryKey: ['me', token],
    queryFn: () => getMe(token),
    enabled: Boolean(token),
  });

  const user = meQuery.data?.user;
  const vaults = meQuery.data?.vaults ?? [];
  const activeVaultIds = selectedVaultIds.filter(id => vaults.some(vault => vault.id === id));
  const selectedVaults = vaults.filter(vault => activeVaultIds.includes(vault.id));
  const validDefaultVaultIds = useMemo(
    () => defaultVaultIds.filter(id => vaults.some(vault => vault.id === id)),
    [defaultVaultIds, vaults],
  );

  const sessionsQuery = useQuery({
    queryKey: ['sessions', token],
    queryFn: () => listSessions(token, []),
    enabled: Boolean(token),
  });

  const vaultStatusesQuery = useQuery({
    queryKey: ['vault-statuses', token, activeVaultIds],
    queryFn: async () => {
      const entries = await Promise.all(activeVaultIds.map(async id => [id, await getVaultStatus(token, id)] as const));
      return Object.fromEntries(entries);
    },
    enabled: Boolean(token && activeVaultIds.length),
  });

  const overviewQuery = useQuery({
    queryKey: ['overview', token],
    queryFn: () => getOverview(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  const adminVaultsQuery = useQuery({
    queryKey: ['admin-vaults', token],
    queryFn: () => listAdminVaults(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  const adminUsersQuery = useQuery({
    queryKey: ['admin-users', token],
    queryFn: () => listAdminUsers(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  const adminModelsQuery = useQuery({
    queryKey: ['admin-models', token],
    queryFn: () => listAdminModels(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  const usageQuery = useQuery({
    queryKey: ['usage-summary', token],
    queryFn: () => getUsageSummary(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  const systemPromptQuery = useQuery({
    queryKey: ['system-prompt', token],
    queryFn: () => getSystemPrompt(token),
    enabled: Boolean(token && user?.role === 'admin'),
  });

  useEffect(() => {
    if (!activeVaultIds.length && vaults[0]) {
      setSelectedVaultIds(validDefaultVaultIds.length ? validDefaultVaultIds : [vaults[0].id]);
    }
  }, [activeVaultIds.length, validDefaultVaultIds, vaults]);

  useEffect(() => {
    if (meQuery.error) {
      clearAuth();
    }
  }, [meQuery.error]);

  const visibleNav = useMemo(() => {
    return navItems.filter(item => !item.adminOnly || user?.role === 'admin');
  }, [user?.role]);

  function applyToken(nextToken: string) {
    setToken(nextToken);
    storeToken(nextToken);
  }

  function clearAuth() {
    setToken('');
    storeToken('');
    setMessages([]);
    setCurrentSessionId(null);
    setReasoningTrace(emptyReasoningTrace());
    queryClient.clear();
  }

  async function openSession(sessionId: string) {
    const data = await getSession(token, sessionId);
    setCurrentSessionId(sessionId);
    const sessionVaultIds = data.session.vaultIds?.length
      ? data.session.vaultIds
      : data.session.vaultId
        ? [data.session.vaultId]
        : [];
    if (sessionVaultIds.length) {
      setSelectedVaultIds(sessionVaultIds);
    }
    setMessages(data.messages || []);
    setError('');
  }

  function startNewSession() {
    setCurrentSessionId(null);
    setMessages([]);
    setError('');
    setStreamingText('');
    setReasoningTrace(emptyReasoningTrace());
    setSelectedVaultIds(validDefaultVaultIds.length ? validDefaultVaultIds : vaults[0] ? [vaults[0].id] : []);
  }

  function saveDefaultScope(vaultIds: string[]) {
    const next = vaultIds.length ? vaultIds : vaults[0] ? [vaults[0].id] : [];
    setDefaultVaultIds(next);
    storeDefaultVaultIds(next);
    if (!currentSessionId) {
      setSelectedVaultIds(next);
    }
  }

  async function sendMessage(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || !activeVaultIds.length || isStreaming) return;
    const statuses = Object.values(vaultStatusesQuery.data ?? {});
    if (statuses.length !== activeVaultIds.length || statuses.some(status => !status.indexed)) {
      setError('所选知识库尚未全部进入运行时索引，请在 Knowledge 页面检查配置。');
      return;
    }

    setInput('');
    setError('');
    setIsStreaming(true);
    setStreamingText('');
    setReasoningTrace(emptyReasoningTrace());
    setMessages(prev => [...prev, { role: 'user', content: text }]);

    try {
      let finalSessionId = currentSessionId;
      let fullText = '';
      let fullToolEvents: ToolCall[] = [];
      let finalReasoningTrace = emptyReasoningTrace();
      await streamChat(
        token,
        { message: text, vaultIds: activeVaultIds, sessionId: currentSessionId },
        (event: ChatEvent) => {
          if (
            event.type === 'sub_agent_start' ||
            event.type === 'sub_agent_progress' ||
            event.type === 'sub_agent_done' ||
            event.type === 'synthesis_start' ||
            event.type === 'synthesis_done'
          ) {
            setReasoningTrace(prev => {
              const next = applyReasoningEvent(prev, event);
              finalReasoningTrace = next;
              return next;
            });
          }
          if (event.type === 'text') {
            fullText += event.content;
            setStreamingText(prev => prev + event.content);
          }
          if (event.type === 'tool_start') {
            fullToolEvents = [...fullToolEvents, { tool: event.tool, args: event.args }];
          }
          if (event.type === 'tool_end') {
            const next = [...fullToolEvents];
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].tool === event.tool && !next[i].result) {
                next[i] = { ...next[i], result: event.result, durationMs: event.durationMs };
                break;
              }
            }
            fullToolEvents = next;
          }
          if (event.type === 'done') {
            finalSessionId = event.sessionId ?? finalSessionId;
            if (event.sessionId) setCurrentSessionId(event.sessionId);
          }
          if (event.type === 'error') {
            setError(event.message);
          }
        },
      );

      setMessages(prev => [...prev, { role: 'assistant', content: fullText, toolCalls: fullToolEvents, reasoningTrace: finalReasoningTrace }]);
      if (finalSessionId) setCurrentSessionId(finalSessionId);
      await queryClient.invalidateQueries({ queryKey: ['sessions', token] });
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败');
    } finally {
      setIsStreaming(false);
      setStreamingText('');
    }
  }

  async function refreshAdminData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['me', token] }),
      queryClient.invalidateQueries({ queryKey: ['overview', token] }),
      queryClient.invalidateQueries({ queryKey: ['admin-vaults', token] }),
      queryClient.invalidateQueries({ queryKey: ['admin-users', token] }),
      queryClient.invalidateQueries({ queryKey: ['admin-models', token] }),
      queryClient.invalidateQueries({ queryKey: ['usage-summary', token] }),
      queryClient.invalidateQueries({ queryKey: ['vault-status'] }),
    ]);
  }

  if (!token) {
    return <LoginScreen onLogin={applyToken} />;
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,#e7f6f1,transparent_34%),linear-gradient(135deg,#f7fafc,#eef4f8_48%,#fff7ed)] text-slate-950">
      <div className="grid h-screen grid-cols-[280px_minmax(0,1fr)] overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-slate-200/80 bg-white/82 p-4 backdrop-blur-xl">
          <div className="mb-5 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-700 text-white">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Team Wiki</div>
              <div className="truncate text-xs text-slate-500">{user?.displayName || user?.username}</div>
            </div>
          </div>

          <nav className="space-y-1">
            {visibleNav.map(item => (
              <button
                key={item.key}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm text-slate-600 transition',
                  view === item.key ? 'bg-slate-950 text-white shadow-sm' : 'hover:bg-slate-100 hover:text-slate-950',
                )}
                onClick={() => setView(item.key)}
              >
                <item.icon size={17} />
                {item.label}
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-slate-600">
              <ShieldCheck size={14} />
              {user?.role === 'admin' ? 'Administrator' : 'Member'}
            </div>
            <button className="mb-2 flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:text-slate-950" onClick={() => setScopeSettingsOpen(true)}>
              <Settings size={15} />
              Knowledge scope
            </button>
            <button className="flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:text-slate-950" onClick={clearAuth}>
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        </aside>

        {view === 'ask' ? (
          <AskWorkspace
            user={user}
            vaults={vaults}
            selectedVaults={selectedVaults}
            sessions={sessionsQuery.data?.sessions ?? []}
            sessionsLoading={sessionsQuery.isLoading}
            indexed={activeVaultIds.length > 0 && Object.values(vaultStatusesQuery.data ?? {}).length === activeVaultIds.length && Object.values(vaultStatusesQuery.data ?? {}).every(status => status.indexed)}
            messages={messages}
            currentSessionId={currentSessionId}
            onOpenSession={openSession}
            onNewSession={startNewSession}
            input={input}
            setInput={setInput}
            sendMessage={sendMessage}
            streamingText={streamingText}
            isStreaming={isStreaming}
            reasoningTrace={reasoningTrace}
            error={error}
          />
        ) : view === 'knowledge' ? (
          <KnowledgePage
            token={token}
            vaults={adminVaultsQuery.data?.vaults ?? []}
            loading={adminVaultsQuery.isLoading}
            onChanged={refreshAdminData}
          />
        ) : view === 'people' ? (
          <PeoplePage
            token={token}
            users={adminUsersQuery.data?.users ?? []}
            vaults={adminVaultsQuery.data?.vaults ?? []}
            loading={adminUsersQuery.isLoading}
            onChanged={refreshAdminData}
          />
        ) : view === 'models' ? (
          <ModelsPage
            token={token}
            models={adminModelsQuery.data?.models ?? []}
            loading={adminModelsQuery.isLoading}
            onChanged={refreshAdminData}
          />
        ) : view === 'insights' ? (
          <InsightsPage overview={overviewQuery.data} usage={usageQuery.data} vaults={adminVaultsQuery.data?.vaults ?? vaults} models={adminModelsQuery.data?.models ?? []} users={adminUsersQuery.data?.users ?? []} />
        ) : view === 'settings' ? (
          <SystemPromptPage
            token={token}
            prompt={systemPromptQuery.data}
            loading={systemPromptQuery.isLoading}
            onChanged={async () => {
              await queryClient.invalidateQueries({ queryKey: ['system-prompt', token] });
            }}
          />
        ) : (
          <PlaceholderPage view={view} overview={overviewQuery.data} vaults={vaults} />
        )}
        {scopeSettingsOpen && (
          <PersonalScopeModal
            vaults={vaults}
            selected={validDefaultVaultIds.length ? validDefaultVaultIds : activeVaultIds}
            onClose={() => setScopeSettingsOpen(false)}
            onSave={(vaultIds) => {
              saveDefaultScope(vaultIds);
              setScopeSettingsOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setLoading(true);
    setError('');
    try {
      const data = await login(username, password);
      onLogin(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <section className="grid w-full max-w-5xl grid-cols-[1.1fr_.9fr] overflow-hidden rounded-xl border border-slate-200 bg-white/88 shadow-2xl shadow-slate-900/10 backdrop-blur">
        <div className="flex min-h-[520px] flex-col justify-between bg-slate-950 p-10 text-white">
          <div>
            <div className="mb-10 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1 text-xs text-teal-100">
              <Sparkles size={14} />
              Private AI knowledge workspace
            </div>
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight">把团队文档变成可追溯的 AI 问答工作台。</h1>
            <p className="mt-5 max-w-lg text-sm leading-7 text-slate-300">
              选择知识库、查看索引状态、追踪回答来源。管理员可以管理用户、模型和知识库边界。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs text-slate-300">
            <Metric label="Vault aware" value="Multi KB" />
            <Metric label="Access" value="Scoped" />
            <Metric label="Output" value="Sources" />
          </div>
        </div>

        <div className="p-10">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-700">Sign in</p>
            <h2 className="mt-2 text-2xl font-semibold">进入 Team Wiki</h2>
            <p className="mt-2 text-sm text-slate-500">默认开发账号为 admin / admin123。</p>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">用户名</span>
              <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10" value={username} onChange={event => setUsername(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">密码</span>
              <input className="h-11 w-full rounded-md border border-slate-200 px-3 outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10" type="password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => event.key === 'Enter' && submit()} />
            </label>
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <button className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white transition hover:bg-teal-800 disabled:opacity-60" disabled={loading} onClick={submit}>
              {loading ? <Loader2 className="animate-spin" size={16} /> : <KeyRound size={16} />}
              登录
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function groupSessionsByTime(sessions: Session[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;
  const groups = [
    { label: 'Today', sessions: [] as Session[] },
    { label: 'Yesterday', sessions: [] as Session[] },
    { label: 'Previous 7 days', sessions: [] as Session[] },
    { label: 'Older', sessions: [] as Session[] },
  ];

  for (const session of sessions) {
    const updatedAt = session.updatedAt || 0;
    if (updatedAt >= todayStart) groups[0].sessions.push(session);
    else if (updatedAt >= yesterdayStart) groups[1].sessions.push(session);
    else if (updatedAt >= weekStart) groups[2].sessions.push(session);
    else groups[3].sessions.push(session);
  }

  return groups.filter(group => group.sessions.length > 0);
}

function scopeLabelForSession(session: Session, vaults: Vault[]) {
  const ids = session.vaultIds?.length ? session.vaultIds : session.vaultId ? [session.vaultId] : [];
  if (!ids.length) return 'No scope';
  if (ids.length === 1) {
    return vaults.find(vault => vault.id === ids[0])?.name || '1 vault';
  }
  return `${ids.length} vaults`;
}

function PersonalScopeModal({ vaults, selected, onClose, onSave }: {
  vaults: Vault[];
  selected: string[];
  onClose: () => void;
  onSave: (vaultIds: string[]) => void;
}) {
  const [draft, setDraft] = useState(selected);
  const selectedSet = new Set(draft);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 p-6 backdrop-blur-sm">
      <section className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/20">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Knowledge scope</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">New chats use this default knowledge range. Existing chats keep their original scope.</p>
        </div>
        <div className="max-h-[360px] space-y-2 overflow-auto">
          {vaults.map(vault => (
            <label key={vault.id} className="flex cursor-pointer items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={selectedSet.has(vault.id)}
                onChange={event => {
                  const next = new Set(draft);
                  if (event.target.checked) next.add(vault.id);
                  else next.delete(vault.id);
                  setDraft([...next]);
                }}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-800">{vault.name}</span>
                <span className="block truncate text-xs text-slate-500">{vault.path}</span>
              </span>
            </label>
          ))}
          {!vaults.length && <div className="rounded-md border border-dashed border-slate-200 p-4 text-sm text-slate-500">No available knowledge bases.</div>}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:text-slate-950" onClick={onClose}>Cancel</button>
          <button className="h-10 rounded-md bg-slate-950 px-4 text-sm text-white hover:bg-slate-800 disabled:opacity-50" disabled={!draft.length} onClick={() => onSave(draft)}>Save</button>
        </div>
      </section>
    </div>
  );
}

function AskWorkspace(props: {
  user?: User;
  vaults: Vault[];
  selectedVaults: Vault[];
  sessions: Session[];
  sessionsLoading: boolean;
  indexed: boolean;
  messages: Message[];
  currentSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  input: string;
  setInput: (value: string) => void;
  sendMessage: (preset?: string) => void;
  streamingText: string;
  isStreaming: boolean;
  reasoningTrace: ReasoningTrace;
  error: string;
}) {
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [sessionFilter, setSessionFilter] = useState('');
  const selectedTitle = props.currentSessionId
    ? props.sessions.find(session => session.id === props.currentSessionId)?.title || 'Ask'
    : 'New chat';
  const scopeText = props.selectedVaults.length
    ? 'Scope: ' + props.selectedVaults.length + ' vaults'
    : 'Scope not set';
  const filteredSessions = props.sessions.filter(session =>
    ((session.title || '') + ' ' + scopeLabelForSession(session, props.vaults)).toLowerCase().includes(sessionFilter.toLowerCase()),
  );
  const sessionGroups = groupSessionsByTime(filteredSessions);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: props.isStreaming ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    props.messages.length,
    props.streamingText,
    props.isStreaming,
    props.reasoningTrace.phase,
    props.reasoningTrace.lanes.length,
    props.reasoningTrace.lanes.reduce((sum, lane) => sum + lane.steps.length, 0),
  ]);

  return (
    <main className="grid min-h-0 grid-cols-[300px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col border-r border-slate-200/80 bg-white/70 p-4">
        <button className="mb-3 flex h-10 items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800" onClick={props.onNewSession}>
          <MessageSquareText size={16} />
          New chat
        </button>

        <label className="relative mb-4 block">
          <Search className="pointer-events-none absolute left-3 top-2.5 text-slate-400" size={15} />
          <input
            className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10"
            value={sessionFilter}
            onChange={event => setSessionFilter(event.target.value)}
            placeholder="Search chats"
          />
        </label>

        <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Chats
          {props.sessionsLoading && <Loader2 className="animate-spin" size={14} />}
        </div>

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {sessionGroups.map(group => (
            <div key={group.label} className="mb-5">
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{group.label}</div>
              <div className="space-y-1.5">
                {group.sessions.map(session => (
                  <button
                    key={session.id}
                    className={cn(
                      'group w-full rounded-md border px-3 py-2.5 text-left transition',
                      props.currentSessionId === session.id ? 'border-teal-600 bg-teal-50' : 'border-transparent bg-white/60 hover:border-slate-200 hover:bg-white',
                    )}
                    onClick={() => props.onOpenSession(session.id)}
                  >
                    <div className="truncate text-sm font-medium text-slate-800">{session.title || 'New Chat'}</div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span className="truncate">{scopeLabelForSession(session, props.vaults)}</span>
                      <span className="shrink-0">{formatTime(session.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!filteredSessions.length && (
            <div className="rounded-md border border-dashed border-slate-200 bg-white/70 p-4 text-sm text-slate-500">No chats yet.</div>
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-col bg-slate-50/45">
        <header className="border-b border-slate-200/70 bg-white/68 px-8 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-[880px] items-center justify-between gap-6">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{selectedTitle}</h2>
              <p className="mt-1 text-sm text-slate-500">{scopeText}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">
              <Network size={14} />
              {props.user?.role === 'admin' ? 'Full access' : 'Scoped access'}
            </div>
          </div>
        </header>

        <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-auto px-8 py-10">
          {!props.messages.length && !props.isStreaming ? (
            <div className="mx-auto mt-[10vh] max-w-[760px] text-center">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl border border-teal-100 bg-teal-50 text-teal-700">
                <FileSearch size={26} />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Ask your team knowledge</h1>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-slate-500">
                New chats use your personal knowledge scope. You can change it from Knowledge scope in the sidebar.
              </p>
              <div className="mt-7 grid grid-cols-2 gap-3">
                {quickPrompts.map(prompt => (
                  <button key={prompt} className="rounded-lg border border-slate-200 bg-white p-4 text-left text-sm text-slate-700 transition hover:border-teal-700 hover:text-teal-800" onClick={() => props.sendMessage(prompt)}>
                    <Search className="mb-3 text-teal-700" size={17} />
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[880px] space-y-6">
              {props.messages.map((message, index) => (
                <ChatBubble key={message.role + '-' + index} message={message} />
              ))}
              {props.isStreaming && (
                <div className="flex justify-start">
                  <div className="max-w-[82%] rounded-lg border border-slate-200 bg-white p-4 text-sm leading-7 shadow-sm shadow-slate-200/40">
                    <ReasoningSummary trace={props.reasoningTrace} />
                    <div data-streaming-text className="mt-3">
                      <MarkdownContent>{props.streamingText || 'Searching selected knowledge...'}</MarkdownContent>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200/70 bg-white/72 px-8 py-4 backdrop-blur">
          {props.error && (
            <div className="mx-auto mb-3 flex max-w-[880px] items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <CircleAlert size={16} />
              {props.error}
            </div>
          )}
          <div className="mx-auto flex max-w-[880px] items-end gap-3 rounded-xl border border-slate-200 bg-white p-2 shadow-sm shadow-slate-200/60">
            <textarea
              className="min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-sm outline-none"
              placeholder={props.indexed ? 'Ask a question. Enter to send, Shift+Enter for newline' : 'Knowledge scope is not indexed yet'}
              value={props.input}
              disabled={!props.indexed || props.isStreaming}
              onChange={event => props.setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  props.sendMessage();
                }
              }}
            />
            <button className="flex h-11 w-11 items-center justify-center rounded-lg bg-teal-700 text-white transition hover:bg-teal-800 disabled:opacity-50" disabled={!props.input.trim() || props.isStreaming || !props.indexed} onClick={() => props.sendMessage()}>
              {props.isStreaming ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}
function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="prose-lite">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function ReasoningSummary({ trace }: { trace: ReasoningTrace }) {
  const [open, setOpen] = useState(false);
  if (!trace.lanes.length && trace.synthesis?.status !== 'running') return null;
  const stepCount = trace.lanes.reduce((sum, lane) => sum + lane.steps.length, 0);
  const statusText = trace.phase === 'synthesis'
    ? '综合中'
    : trace.phase === 'done'
      ? '检索完成'
      : '检索中';
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50">
      <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-slate-700" onClick={() => setOpen(prev => !prev)}>
        <span>{statusText} · 已检索 {stepCount} 步</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="border-t border-slate-200 p-3">
          <ReasoningLanes trace={trace} compact />
        </div>
      )}
    </div>
  );
}

export function ReasoningDisclosure({ trace, defaultOpen = false }: { trace: ReasoningTrace; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!trace.lanes.length && trace.synthesis?.status !== 'running') return null;
  const doneLanes = trace.lanes.filter(lane => lane.status === 'done' || lane.status === 'weak_evidence').length;
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50">
      <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-slate-700" onClick={() => setOpen(prev => !prev)}>
        <span>推理过程 · {doneLanes}/{trace.lanes.length} 个知识库完成 · {trace.phase === 'synthesis' ? '正在综合' : trace.phase === 'done' ? '已完成' : '检索中'}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="border-t border-slate-200 p-3">
          <ReasoningLanes trace={trace} compact />
        </div>
      )}
    </div>
  );
}

function ReasoningLanes({ trace, compact = false }: { trace: ReasoningTrace; compact?: boolean }) {
  return (
    <div className="space-y-2">
      {trace.lanes.map(lane => (
        <div key={lane.vaultId} className="rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-slate-800">{lane.vaultName}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{reasoningStatusLabel(lane.status)}</div>
            </div>
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px]', reasoningStatusClass(lane.status))}>{lane.steps.length} steps</span>
          </div>
          {lane.summary && !compact && <p className="mb-2 line-clamp-4 text-xs leading-5 text-slate-600">{lane.summary}</p>}
          <div className="space-y-1.5">
            {lane.steps.slice(compact ? -3 : -6).map((step, index) => (
              <div key={`${step.createdAt}-${index}`} className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                  <span className="truncate">{step.type === 'tool_start' ? '开始' : '完成'} · {step.tool}</span>
                  {typeof step.durationMs === 'number' && <span className="shrink-0">{step.durationMs}ms</span>}
                </div>
                {step.result && <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500">{step.result}</p>}
              </div>
            ))}
            {!lane.steps.length && <div className="rounded border border-dashed border-slate-200 px-2 py-2 text-xs text-slate-500">等待检索事件...</div>}
          </div>
          {!!lane.sources.length && (
            <div className="mt-2 flex flex-wrap gap-1">
              {lane.sources.slice(0, 4).map(source => (
                <span key={`${source.vaultId || lane.vaultId}:${source.path}`} className="max-w-full truncate rounded-full bg-teal-50 px-2 py-0.5 text-[10px] text-teal-700">{source.title}</span>
              ))}
            </div>
          )}
        </div>
      ))}
      {trace.synthesis?.status !== 'idle' && (
        <div className="rounded-md border border-indigo-100 bg-indigo-50 p-3 text-xs text-indigo-800">
          {trace.synthesis?.status === 'running' ? '正在综合各知识库线索...' : `综合完成${trace.synthesis?.durationMs ? ` · ${trace.synthesis.durationMs}ms` : ''}`}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return <span className={cn('text-slate-400 transition', open && 'rotate-90')}>›</span>;
}

function reasoningStatusLabel(status: ReasoningTrace['lanes'][number]['status']) {
  return {
    queued: '等待中',
    searching: '检索中',
    reading: '读取文档',
    done: '线索完成',
    weak_evidence: '证据不足',
    error: '失败',
  }[status];
}

function reasoningStatusClass(status: ReasoningTrace['lanes'][number]['status']) {
  if (status === 'done') return 'bg-emerald-50 text-emerald-700';
  if (status === 'weak_evidence') return 'bg-amber-50 text-amber-700';
  if (status === 'error') return 'bg-red-50 text-red-700';
  return 'bg-slate-100 text-slate-600';
}

function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const calls = parseToolCalls(message.toolCalls);
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[82%] rounded-lg p-4 text-sm leading-7', isUser ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white shadow-sm shadow-slate-200/40')}>
        {!isUser && message.reasoningTrace && <ReasoningSummary trace={message.reasoningTrace} />}
        {isUser ? <p>{message.content}</p> : <MarkdownContent>{message.content}</MarkdownContent>}
        {!isUser && calls.length > 0 && (
          <div className="mt-3 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">检索 {calls.length} 次</div>
        )}
      </div>
    </div>
  );
}

function KnowledgePage({ token, vaults, loading, onChanged }: { token: string; vaults: Vault[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({ name: '', path: '', enabled: true });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const visibleVaults = vaults.filter(vault => `${vault.name} ${vault.path}`.toLowerCase().includes(filter.toLowerCase()));

  async function addVault() {
    if (!draft.name.trim() || !draft.path.trim()) {
      setError('请填写知识库名称和路径。');
      return;
    }
    setSaving('new');
    setError('');
    try {
      await createVault(token, draft);
      setDraft({ name: '', path: '', enabled: true });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增知识库失败');
    } finally {
      setSaving('');
    }
  }

  return (
    <AdminShell
      icon={Library}
      title="Knowledge"
      description="管理团队知识库路径、启用状态和运行时索引健康。新增或修改知识库后，后端会同步运行时索引。"
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5">
        <section className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <Field label="搜索知识库" value={filter} onChange={setFilter} placeholder="按名称或路径过滤" />
          </div>
          {visibleVaults.map(vault => (
            <VaultRow
              key={vault.id}
              token={token}
              vault={vault}
              saving={saving === vault.id || saving === `${vault.id}:reindex`}
              onSave={async (next) => {
                setSaving(vault.id);
                setError('');
                try {
                  await updateVault(token, vault.id, next);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '保存失败');
                } finally {
                  setSaving('');
                }
              }}
              onDelete={async () => {
                if (!window.confirm(`删除知识库配置「${vault.name}」？`)) return;
                setSaving(vault.id);
                setError('');
                try {
                  await deleteVault(token, vault.id);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除失败');
                } finally {
                  setSaving('');
                }
              }}
              onReindex={async () => {
                setSaving(`${vault.id}:reindex`);
                setError('');
                try {
                  await reindexVault(token, vault.id);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '重建索引失败');
                } finally {
                  setSaving('');
                }
              }}
            />
          ))}
          {!visibleVaults.length && <EmptyPanel text={vaults.length ? '没有匹配的知识库。' : '还没有知识库配置。'} />}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold">新增知识库</h2>
          <p className="mt-1 text-sm text-slate-500">路径需要是后端机器可访问的 Markdown / Obsidian 目录。</p>
          <div className="mt-5 space-y-4">
            <Field label="名称" value={draft.name} onChange={value => setDraft(prev => ({ ...prev, name: value }))} placeholder="例如：Product Wiki" />
            <Field label="路径" value={draft.path} onChange={value => setDraft(prev => ({ ...prev, path: value }))} placeholder="D:\\WorkSpace\\Wiki" />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
              启用并建立索引
            </label>
            {error && <InlineError text={error} />}
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-teal-700 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60" disabled={saving === 'new'} onClick={addVault}>
              {saving === 'new' ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
              添加知识库
            </button>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function VaultRow({ token, vault, saving, onSave, onDelete, onReindex }: {
  token: string;
  vault: Vault;
  saving: boolean;
  onSave: (vault: Partial<Vault>) => Promise<void>;
  onDelete: () => Promise<void>;
  onReindex: () => Promise<void>;
}) {
  const [name, setName] = useState(vault.name);
  const [path, setPath] = useState(vault.path);
  const [enabled, setEnabled] = useState(vault.enabled);
  const statusQuery = useQuery({
    queryKey: ['vault-status', token, vault.id],
    queryFn: () => getVaultStatus(token, vault.id),
    enabled: Boolean(token && vault.id),
  });

  useEffect(() => {
    setName(vault.name);
    setPath(vault.path);
    setEnabled(vault.enabled);
  }, [vault]);

  const indexed = statusQuery.data?.indexed ?? false;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{vault.name}</h3>
            <StatusPill indexed={indexed} indexing={Boolean(statusQuery.data?.status?.status?.isIndexing)} />
          </div>
          <p className="mt-1 text-xs text-slate-500">{vault.path}</p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>{compactNumber(statusQuery.data?.status?.files)} files</div>
          <div>{formatTime(statusQuery.data?.status?.status?.lastUpdated)}</div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_1.4fr_auto] gap-3">
        <Field label="名称" value={name} onChange={setName} />
        <Field label="路径" value={path} onChange={setPath} />
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-600">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          启用
        </label>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60" disabled={saving} onClick={onReindex}>
          <RefreshCw size={15} />
          重建索引
        </button>
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-red-600 hover:bg-red-50" onClick={onDelete}>
          <Trash2 size={15} />
          删除
        </button>
        <button className="flex h-9 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving} onClick={() => onSave({ name, path, enabled })}>
          {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
    </article>
  );
}

function PeoplePage({ token, users, vaults, loading, onChanged }: { token: string; users: AdminUser[]; vaults: Vault[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({ username: '', displayName: '', password: '', role: 'user' as 'admin' | 'user', vaultIds: [] as string[] });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const visibleUsers = users.filter(user => `${user.username} ${user.displayName} ${user.role} ${user.status}`.toLowerCase().includes(filter.toLowerCase()));

  async function addUser() {
    if (!draft.username.trim() || !draft.password.trim()) {
      setError('请填写用户名和初始密码。');
      return;
    }
    setSaving('new');
    setError('');
    try {
      await createUser(token, { ...draft, status: 'active' });
      setDraft({ username: '', displayName: '', password: '', role: 'user', vaultIds: [] });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增用户失败');
    } finally {
      setSaving('');
    }
  }

  return (
    <AdminShell
      icon={Users}
      title="People"
      description="管理成员、角色和知识库授权。普通用户只会看到被授权的知识库。"
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5">
        <section className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <Field label="搜索用户" value={filter} onChange={setFilter} placeholder="按用户名、显示名、角色过滤" />
          </div>
          {visibleUsers.map(user => (
            <UserRow
              key={user.id}
              user={user}
              vaults={vaults}
              saving={saving === user.id}
              onSave={async (next) => {
                setSaving(user.id);
                setError('');
                try {
                  await updateUser(token, user.id, next);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '保存用户失败');
                } finally {
                  setSaving('');
                }
              }}
              onDelete={async () => {
                if (!window.confirm(`删除用户「${user.username}」？`)) return;
                setSaving(user.id);
                setError('');
                try {
                  await deleteUser(token, user.id);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除用户失败');
                } finally {
                  setSaving('');
                }
              }}
            />
          ))}
          {!visibleUsers.length && <EmptyPanel text={users.length ? '没有匹配的用户。' : '还没有用户。'} />}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold">新增用户</h2>
          <p className="mt-1 text-sm text-slate-500">创建后可立即分配知识库访问范围。</p>
          <div className="mt-5 space-y-4">
            <Field label="用户名" value={draft.username} onChange={value => setDraft(prev => ({ ...prev, username: value }))} />
            <Field label="显示名" value={draft.displayName} onChange={value => setDraft(prev => ({ ...prev, displayName: value }))} />
            <Field label="初始密码" value={draft.password} onChange={value => setDraft(prev => ({ ...prev, password: value }))} type="password" />
            <SelectField label="角色" value={draft.role} onChange={value => setDraft(prev => ({ ...prev, role: value as 'admin' | 'user' }))} options={[['user', '普通用户'], ['admin', '管理员']]} />
            <VaultChecks vaults={vaults} selected={draft.vaultIds} onChange={vaultIds => setDraft(prev => ({ ...prev, vaultIds }))} disabled={draft.role === 'admin'} />
            {error && <InlineError text={error} />}
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-teal-700 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60" disabled={saving === 'new'} onClick={addUser}>
              {saving === 'new' ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
              添加用户
            </button>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function UserRow({ user, vaults, saving, onSave, onDelete }: {
  user: AdminUser;
  vaults: Vault[];
  saving: boolean;
  onSave: (patch: Partial<AdminUser> & { password?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [vaultIds, setVaultIds] = useState(user.vaultIds ?? []);
  const [password, setPassword] = useState('');

  useEffect(() => {
    setDisplayName(user.displayName);
    setRole(user.role);
    setStatus(user.status);
    setVaultIds(user.vaultIds ?? []);
    setPassword('');
  }, [user]);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="font-semibold">{user.username}</h3>
          <p className="mt-1 text-xs text-slate-500">Created {formatTime(user.createdAt)}</p>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-xs', status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{status}</span>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="显示名" value={displayName} onChange={setDisplayName} />
        <SelectField label="角色" value={role} onChange={value => setRole(value as 'admin' | 'user')} options={[['user', '普通用户'], ['admin', '管理员']]} />
        <SelectField label="状态" value={status} onChange={value => setStatus(value as 'active' | 'disabled')} options={[['active', '启用'], ['disabled', '停用']]} />
        <Field label="新密码" value={password} onChange={setPassword} type="password" placeholder="留空不改" />
      </div>

      <div className="mt-4">
        <VaultChecks vaults={vaults} selected={vaultIds} onChange={setVaultIds} disabled={role === 'admin'} />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-red-600 hover:bg-red-50" onClick={onDelete}>
          <Trash2 size={15} />
          删除
        </button>
        <button className="flex h-9 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving} onClick={() => onSave({ displayName, role, status, vaultIds, password: password || undefined })}>
          {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
    </article>
  );
}

function ModelsPage({ token, models, loading, onChanged }: { token: string; models: ModelConfig[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({ name: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: '', enabled: true, isDefault: false });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [testResult, setTestResult] = useState('');
  const visibleModels = models.filter(model => `${model.name} ${model.baseUrl} ${model.model}`.toLowerCase().includes(filter.toLowerCase()));

  async function addModel() {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      setError('请填写模型名称、Base URL 和模型名。');
      return;
    }
    setSaving('new');
    setError('');
    try {
      await createModel(token, draft);
      setDraft({ name: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', apiKey: '', enabled: true, isDefault: false });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增模型失败');
    } finally {
      setSaving('');
    }
  }

  return (
    <AdminShell
      icon={BrainCircuit}
      title="Models"
      description="配置默认模型和 OpenAI-compatible API。模型 Key 不会在前端回显。"
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_380px] gap-5">
        <section className="space-y-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <Field label="搜索模型" value={filter} onChange={setFilter} placeholder="按名称、Base URL、模型名过滤" />
            {testResult && <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">{testResult}</div>}
          </div>
          {visibleModels.map(model => (
            <ModelRow
              key={model.id}
              model={model}
              saving={saving === model.id || saving === `${model.id}:test`}
              onSave={async (next) => {
                setSaving(model.id);
                setError('');
                try {
                  await updateModel(token, model.id, next);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '保存模型失败');
                } finally {
                  setSaving('');
                }
              }}
              onDelete={async () => {
                if (!window.confirm(`删除模型配置「${model.name}」？`)) return;
                setSaving(model.id);
                setError('');
                try {
                  await deleteModel(token, model.id);
                  await onChanged();
                } catch (err) {
                  setError(err instanceof Error ? err.message : '删除模型失败');
                } finally {
                  setSaving('');
                }
              }}
              onTest={async () => {
                setSaving(`${model.id}:test`);
                setError('');
                setTestResult('');
                try {
                  const result = await testModel(token, model.id);
                  setTestResult(`${model.name}: ${result.ok ? 'OK' : 'Incomplete'} - ${result.message}`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : '测试模型失败');
                } finally {
                  setSaving('');
                }
              }}
            />
          ))}
          {!visibleModels.length && <EmptyPanel text={models.length ? '没有匹配的模型配置。' : '还没有模型配置。'} />}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold">新增模型</h2>
          <p className="mt-1 text-sm text-slate-500">支持 DeepSeek、OpenAI 或兼容 OpenAI API 的服务。</p>
          <div className="mt-5 space-y-4">
            <Field label="名称" value={draft.name} onChange={value => setDraft(prev => ({ ...prev, name: value }))} placeholder="Default DeepSeek" />
            <Field label="Base URL" value={draft.baseUrl} onChange={value => setDraft(prev => ({ ...prev, baseUrl: value }))} />
            <Field label="Model" value={draft.model} onChange={value => setDraft(prev => ({ ...prev, model: value }))} />
            <Field label="API Key" value={draft.apiKey} onChange={value => setDraft(prev => ({ ...prev, apiKey: value }))} type="password" />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
              启用
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={draft.isDefault} onChange={event => setDraft(prev => ({ ...prev, isDefault: event.target.checked }))} />
              设为默认
            </label>
            {error && <InlineError text={error} />}
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-teal-700 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60" disabled={saving === 'new'} onClick={addModel}>
              {saving === 'new' ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
              添加模型
            </button>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function ModelRow({ model, saving, onSave, onDelete, onTest }: { model: ModelConfig; saving: boolean; onSave: (patch: Partial<ModelConfig>) => Promise<void>; onDelete: () => Promise<void>; onTest: () => Promise<void> }) {
  const [name, setName] = useState(model.name);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl);
  const [modelName, setModelName] = useState(model.model);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(model.enabled);
  const [isDefault, setIsDefault] = useState(model.isDefault);

  useEffect(() => {
    setName(model.name);
    setBaseUrl(model.baseUrl);
    setModelName(model.model);
    setEnabled(model.enabled);
    setIsDefault(model.isDefault);
    setApiKey('');
  }, [model]);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{model.name}</h3>
            {model.isDefault && <span className="rounded-full bg-teal-50 px-2 py-1 text-xs text-teal-700">Default</span>}
          </div>
          <p className="mt-1 text-xs text-slate-500">{model.baseUrl}</p>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-xs', model.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{model.enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="名称" value={name} onChange={setName} />
        <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} />
        <Field label="Model" value={modelName} onChange={setModelName} />
        <Field label="API Key" value={apiKey} onChange={setApiKey} type="password" placeholder={model.hasApiKey ? '已配置，留空不改' : '未配置'} />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex gap-5">
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label>
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={isDefault} onChange={event => setIsDefault(event.target.checked)} />默认</label>
        </div>
        <div className="flex gap-2">
          <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60" disabled={saving} onClick={onTest}><Activity size={15} />测试</button>
          <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-red-600 hover:bg-red-50" onClick={onDelete}><Trash2 size={15} />删除</button>
          <button className="flex h-9 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving} onClick={() => onSave({ name, baseUrl, model: modelName, apiKey: apiKey || undefined, enabled, isDefault })}>
            {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
            保存
          </button>
        </div>
      </div>
    </article>
  );
}

function InsightsPage({ overview, usage, vaults, models, users }: { overview?: Overview; usage?: UsageSummary; vaults: Vault[]; models: ModelConfig[]; users: AdminUser[] }) {
  const vaultName = (vaultId: string | null) => vaults.find(vault => vault.id === vaultId)?.name || '(unknown)';
  return (
    <AdminShell icon={Gauge} title="Insights" description="基础运行概览。后续会接入问答次数、token 用量和用户排行。">
      <div className="grid grid-cols-4 gap-4">
        <InfoPanel label="Users" value={overview?.users ?? users.length} />
        <InfoPanel label="Active users" value={overview?.activeUsers ?? users.filter(user => user.status === 'active').length} />
        <InfoPanel label="Questions" value={usage?.totalQuestions ?? 0} />
        <InfoPanel label="Tokens" value={compactNumber(usage?.totalTokens)} />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold">Knowledge health</h2>
          <div className="mt-4 space-y-3">
            {vaults.map(vault => (
              <div key={vault.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{vault.name}</div>
                  <div className="text-xs text-slate-500">{vault.path}</div>
                </div>
                <span className={cn('rounded-full px-2 py-1 text-xs', vault.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{vault.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold">Usage by vault</h2>
          <div className="mt-4 space-y-3">
            {(usage?.byVault ?? []).map(item => (
              <div key={item.vaultId || 'none'} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{vaultName(item.vaultId)}</div>
                  <div className="text-xs text-slate-500">{compactNumber(item.totalTokens)} tokens</div>
                </div>
                <span className="rounded-full bg-teal-50 px-2 py-1 text-xs text-teal-700">{item.totalQuestions} questions</span>
              </div>
            ))}
            {!usage?.byVault?.length && <EmptyPanel text="还没有问答用量数据。" />}
          </div>
        </section>
      </div>

      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold">Model routing</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {models.map(model => (
            <div key={model.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
              <div>
                <div className="text-sm font-medium">{model.name}</div>
                <div className="text-xs text-slate-500">{model.model}</div>
              </div>
              <span className={cn('rounded-full px-2 py-1 text-xs', model.isDefault ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-500')}>{model.isDefault ? 'Default' : 'Standby'}</span>
            </div>
          ))}
        </div>
      </section>
    </AdminShell>
  );
}

function SystemPromptPage({ token, prompt, loading, onChanged }: { token: string; prompt?: SystemPromptResponse; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [selectedVaultId, setSelectedVaultId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (prompt?.basePrompt) {
      setDraft(prompt.basePrompt);
    }
    if (!selectedVaultId && prompt?.effectivePrompts?.[0]) {
      setSelectedVaultId(prompt.effectivePrompts[0].vaultId);
    }
  }, [prompt?.basePrompt, prompt?.effectivePrompts, selectedVaultId]);

  const selectedPreview = prompt?.effectivePrompts.find(item => item.vaultId === selectedVaultId) ?? prompt?.effectivePrompts[0];
  const dirty = Boolean(prompt && draft.trim() !== prompt.basePrompt.trim());

  async function save() {
    if (!draft.trim()) {
      setError('系统提示词不能为空。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await updateSystemPrompt(token, draft);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存系统提示词失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      icon={Settings}
      title="Settings"
      description="查看和修改当前生效的系统提示词。基础提示词会持久化保存，运行时会按知识库追加索引摘要。"
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Base system prompt</h2>
              <p className="mt-1 text-sm text-slate-500">
                当前来源：{prompt?.source ?? '-'} · 更新：{formatTime(prompt?.updatedAt ?? undefined)}
              </p>
            </div>
            <button className="flex h-10 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving || !dirty} onClick={save}>
              {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
              Save
            </button>
          </div>
          {error && <div className="mb-3"><InlineError text={error} /></div>}
          <textarea
            className="min-h-[520px] w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-6 outline-none transition focus:border-teal-700 focus:bg-white focus:ring-4 focus:ring-teal-700/10"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="输入系统提示词"
          />
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold">Effective preview</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">预览基础提示词与所选知识库运行时摘要拼接后的最终内容。</p>
            <div className="mt-4">
              <SelectField
                label="知识库"
                value={selectedPreview?.vaultId ?? ''}
                onChange={setSelectedVaultId}
                options={(prompt?.effectivePrompts ?? []).map(item => [item.vaultId, item.vaultName])}
              />
            </div>
          </section>

          <section className="max-h-[620px] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100">
            <pre className="whitespace-pre-wrap break-words text-xs leading-6">{selectedPreview?.prompt || '暂无运行时预览。'}</pre>
          </section>
        </aside>
      </div>
    </AdminShell>
  );
}

function PlaceholderPage({ view, overview, vaults }: { view: ViewKey; overview?: any; vaults: Vault[] }) {
  const meta = {
    knowledge: ['Knowledge', '管理知识库路径、启用状态和索引健康。', Library],
    people: ['People', '维护用户、角色和知识库授权。', Users],
    models: ['Models', '配置默认模型、Base URL 和 API Key。', BrainCircuit],
    agents: ['Agents', '后续用于切换 OpenAI Agent、Claude Code Agent 等策略。', Bot],
    insights: ['Insights', '查看用量、运行状态和系统健康。', Gauge],
    settings: ['Settings', '系统级配置入口。', Settings],
    ask: ['Ask', '知识库问答。', MessageSquareText],
  }[view] as [string, string, typeof Library];
  const Icon = meta[2];

  return (
    <main className="min-h-0 overflow-auto p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-white text-teal-700 shadow-sm shadow-slate-200">
            <Icon size={24} />
          </div>
          <h1 className="text-2xl font-semibold">{meta[0]}</h1>
          <p className="mt-2 text-sm text-slate-500">{meta[1]}</p>
        </div>
        <div className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">React workspace v0.1</div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <InfoPanel label="Users" value={overview?.users ?? '-'} />
        <InfoPanel label="Enabled vaults" value={overview?.enabledVaults ?? vaults.filter(v => v.enabled).length} />
        <InfoPanel label="Models" value={overview?.enabledModels ?? '-'} />
        <InfoPanel label="Default model" value={overview?.defaultModel ?? '-'} />
      </div>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-base font-semibold">Next build step</h2>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-500">
          当前阶段先建立现代 AI 工作台的导航、主题和 Ask 页面。下一阶段会把这个页面替换为完整的管理表格、抽屉表单和聚合统计。
        </p>
      </section>
    </main>
  );
}

function AdminShell({ icon: Icon, title, description, action, children }: {
  icon: typeof Library;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-0 overflow-auto p-8">
      <div className="mb-8 flex items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white text-teal-700 shadow-sm shadow-slate-200">
            <Icon size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-500">{description}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </main>
  );
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:text-slate-950 disabled:opacity-60"
      disabled={loading || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {loading || busy ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
      Refresh
    </button>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-500">{label}</span>
      <input
        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-500">{label}</span>
      <select
        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10"
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>{labelText}</option>
        ))}
      </select>
    </label>
  );
}

function VaultChecks({ vaults, selected, disabled, onChange }: {
  vaults: Vault[];
  selected: string[];
  disabled?: boolean;
  onChange: (vaultIds: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-slate-500">知识库授权</div>
      {disabled ? (
        <div className="rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-sm text-teal-700">管理员默认拥有全部知识库访问权限。</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {vaults.map(vault => (
            <label key={vault.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={selectedSet.has(vault.id)}
                onChange={event => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(vault.id);
                  else next.delete(vault.id);
                  onChange([...next]);
                }}
              />
              <span className="truncate">{vault.name}</span>
            </label>
          ))}
          {!vaults.length && <div className="rounded-md border border-dashed border-slate-200 p-3 text-sm text-slate-500">暂无可授权知识库。</div>}
        </div>
      )}
    </div>
  );
}

function InlineError({ text }: { text: string }) {
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{text}</div>;
}

function EmptyPanel({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-slate-200 bg-white/70 p-8 text-center text-sm text-slate-500">{text}</div>;
}

function StatusPill({ indexed, indexing }: { indexed: boolean; indexing: boolean }) {
  if (indexing) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700"><Loader2 className="animate-spin" size={12} />Indexing</span>;
  }
  return indexed
    ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700"><CheckCircle2 size={12} />Ready</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 text-xs text-red-700"><CircleAlert size={12} />Missing</span>;
}

export function InfoCard({ icon: Icon, label, value, tone }: { icon: typeof Database; label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
        <Icon size={14} />
        {label}
      </div>
      <div className={cn('text-sm font-semibold', tone === 'good' && 'text-emerald-700', tone === 'bad' && 'text-red-700')}>{value}</div>
    </div>
  );
}

function InfoPanel({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-3 truncate text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">{label}</div>
      <div className="mt-2 font-semibold text-white">{value}</div>
    </div>
  );
}
