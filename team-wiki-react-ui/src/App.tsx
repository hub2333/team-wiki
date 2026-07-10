import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Database,
  FileSearch,
  Gauge,
  KeyRound,
  Library,
  ListChecks,
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
  Pencil,
  X,
  MoreHorizontal,
} from 'lucide-react';
import {
  createModel,
  createUser,
  createVault,
  deleteModel,
  deleteSession,
  deleteUser,
  deleteVault,
  getMe,
  getAgentConfig,
  getDefaultAgentConfig,
  getOverview,
  getSession,
  getStoredToken,
  getSystemPrompt,
  getUsageSummary,
  getVaultStatus,
  listAdminModels,
  listAdminUsers,
  listAdminVaults,
  listModels,
  listSessions,
  login,
  reindexVault,
  renameSession,
  storeToken,
  testModel,
  testAgentConfig,
  updateModel,
  updateAgentConfig,
  updateSystemPrompt,
  updateUser,
  updateVault,
} from './lib/api';
import { streamChat, type ChatEvent } from './lib/sse';
import { cn, compactNumber, formatTime, parseToolCalls } from './lib/utils';
import type { AdminUser, AgentConfig, AgentProvider, ChatSource, ChatUsage, Message, ModelConfig, Overview, ReasoningTrace, Session, SystemPromptResponse, ToolCall, UsageSummary, User, Vault } from './types';

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
  const [selectedModelId, setSelectedModelId] = useState('');
  const [lastUsedModel, setLastUsedModel] = useState<ModelConfig | null>(null);
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

  const modelsQuery = useQuery({
    queryKey: ['models', token],
    queryFn: () => listModels(token),
    enabled: Boolean(token),
  });
  const models = modelsQuery.data?.models ?? [];
  const selectedModel = models.find(model => model.id === selectedModelId) ?? models.find(model => model.isDefault) ?? models[0] ?? null;

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

  const defaultAgentQuery = useQuery({
    queryKey: ['agent-default', token],
    queryFn: () => getDefaultAgentConfig(token),
    enabled: Boolean(token),
  });

  const adminAgentConfigQuery = useQuery({
    queryKey: ['admin-agent-config', token],
    queryFn: () => getAgentConfig(token),
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
    if (!models.length) return;
    if (selectedModelId && models.some(model => model.id === selectedModelId)) return;
    setSelectedModelId(models.find(model => model.isDefault)?.id ?? models[0].id);
  }, [models, selectedModelId]);

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
    setSelectedModelId('');
    setLastUsedModel(null);
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
    const sessionModelId = typeof data.session.metadata?.modelId === 'string' ? data.session.metadata.modelId : '';
    if (sessionModelId) setSelectedModelId(sessionModelId);
    setLastUsedModel(null);
    setMessages(data.messages || []);
    setError('');
  }

  function startNewSession() {
    setCurrentSessionId(null);
    setMessages([]);
    setError('');
    setStreamingText('');
    setLastUsedModel(null);
    setReasoningTrace(emptyReasoningTrace());
    setSelectedVaultIds(validDefaultVaultIds.length ? validDefaultVaultIds : vaults[0] ? [vaults[0].id] : []);
    setSelectedModelId(models.find(model => model.isDefault)?.id ?? models[0]?.id ?? '');
  }

  function saveDefaultScope(vaultIds: string[]) {
    const next = vaultIds.length ? vaultIds : vaults[0] ? [vaults[0].id] : [];
    setDefaultVaultIds(next);
    storeDefaultVaultIds(next);
    if (!currentSessionId) {
      setSelectedVaultIds(next);
    }
  }

  async function renameChatSession(sessionId: string, title: string) {
    await renameSession(token, sessionId, title);
    await queryClient.invalidateQueries({ queryKey: ['sessions', token] });
  }

  async function deleteChatSessions(sessionIds: string[]) {
    if (!sessionIds.length) return;
    await Promise.all(sessionIds.map(sessionId => deleteSession(token, sessionId)));
    if (currentSessionId && sessionIds.includes(currentSessionId)) {
      startNewSession();
    }
    await queryClient.invalidateQueries({ queryKey: ['sessions', token] });
  }

  async function sendMessage(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || !activeVaultIds.length || isStreaming) return;
    const currentAgent = defaultAgentQuery.data?.agent;
    const agentUsesSelectedModel = currentAgent?.provider !== 'claude_code';
    const statuses = Object.values(vaultStatusesQuery.data ?? {});
    if (statuses.length !== activeVaultIds.length || statuses.some(status => !status.indexed)) {
      setError('所选知识库尚未全部进入运行时索引，请在 Knowledge 页面检查配置。');
      return;
    }
    if (agentUsesSelectedModel && !selectedModel) {
      setError('没有可用模型，请先在 Models 页面配置模型。');
      return;
    }
    if (agentUsesSelectedModel && selectedModel && !selectedModel.hasApiKey) {
      setError(`当前模型「${selectedModel.name}」缺少 API Key，请先在 Models 页面补全。`);
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
      let finalUsage: ChatUsage | undefined;
      let finalSources: ChatSource[] = [];
      await streamChat(
        token,
        { message: text, vaultIds: activeVaultIds, sessionId: currentSessionId, modelId: selectedModel?.id },
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
            if (event.usage) finalUsage = event.usage;
            finalSources = event.sources ?? [];
            if (event.model) setLastUsedModel(event.model as ModelConfig);
          }
          if (event.type === 'error') {
            setError(event.message);
          }
        },
      );

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: fullText,
        toolCalls: fullToolEvents,
        reasoningTrace: finalReasoningTrace,
        usage: finalUsage,
        metadata: {
          ...(finalUsage ? { usage: finalUsage } : {}),
          ...(finalSources.length ? { sources: finalSources } : {}),
        },
      }]);
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
      queryClient.invalidateQueries({ queryKey: ['agent-default', token] }),
      queryClient.invalidateQueries({ queryKey: ['admin-agent-config', token] }),
      queryClient.invalidateQueries({ queryKey: ['models', token] }),
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
            models={models}
            selectedModel={selectedModel}
            lastUsedModel={lastUsedModel}
            agent={defaultAgentQuery.data?.agent}
            modelsLoading={modelsQuery.isLoading}
            selectedModelId={selectedModelId}
            onSelectModel={setSelectedModelId}
            indexed={activeVaultIds.length > 0 && Object.values(vaultStatusesQuery.data ?? {}).length === activeVaultIds.length && Object.values(vaultStatusesQuery.data ?? {}).every(status => status.indexed)}
            messages={messages}
            currentSessionId={currentSessionId}
            onOpenSession={openSession}
            onNewSession={startNewSession}
            onRenameSession={renameChatSession}
            onDeleteSessions={deleteChatSessions}
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
        ) : view === 'agents' ? (
          <AgentsPage
            token={token}
            agent={adminAgentConfigQuery.data?.agent}
            loading={adminAgentConfigQuery.isLoading}
            onChanged={async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['agent-default', token] }),
                queryClient.invalidateQueries({ queryKey: ['admin-agent-config', token] }),
              ]);
            }}
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
  models: ModelConfig[];
  selectedModel: ModelConfig | null;
  lastUsedModel: ModelConfig | null;
  agent?: AgentConfig;
  modelsLoading: boolean;
  selectedModelId: string;
  onSelectModel: (modelId: string) => void;
  indexed: boolean;
  messages: Message[];
  currentSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSessions: (sessionIds: string[]) => Promise<void>;
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
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [renamingSession, setRenamingSession] = useState<Session | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDeleteSessionIds, setPendingDeleteSessionIds] = useState<string[]>([]);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const selectedTitle = props.currentSessionId
    ? props.sessions.find(session => session.id === props.currentSessionId)?.title || 'Ask'
    : 'New chat';
  const scopeText = props.selectedVaults.length
    ? 'Scope: ' + props.selectedVaults.length + ' vaults'
    : 'Scope not set';
  const agentUsesSelectedModel = props.agent?.provider !== 'claude_code';
  const modelReady = props.agent?.provider === 'claude_code' || Boolean(props.selectedModel?.hasApiKey);
  const inputPlaceholder = !props.indexed
    ? 'Knowledge scope is not indexed yet'
    : modelReady
      ? 'Ask a question. Enter to send, Shift+Enter for newline'
      : 'Selected model is missing an API key';
  const filteredSessions = props.sessions.filter(session =>
    ((session.title || '') + ' ' + scopeLabelForSession(session, props.vaults)).toLowerCase().includes(sessionFilter.toLowerCase()),
  );
  const sessionGroups = groupSessionsByTime(filteredSessions);
  const selectedSessionSet = new Set(selectedSessionIds);

  function toggleBulkMode() {
    setBulkMode(prev => !prev);
    setSelectedSessionIds([]);
    setSessionMenuId(null);
  }

  function toggleSessionSelected(sessionId: string) {
    setSelectedSessionIds(prev => prev.includes(sessionId) ? prev.filter(id => id !== sessionId) : [...prev, sessionId]);
  }

  async function deleteSessionsWithConfirm(sessionIds: string[]) {
    if (!sessionIds.length) return;
    setSessionActionBusy(true);
    try {
      await props.onDeleteSessions(sessionIds);
      setSelectedSessionIds([]);
      setBulkMode(false);
      setSessionMenuId(null);
      setPendingDeleteSessionIds([]);
    } finally {
      setSessionActionBusy(false);
    }
  }

  function requestDeleteSessions(sessionIds: string[]) {
    if (!sessionIds.length || sessionActionBusy) return;
    setPendingDeleteSessionIds(sessionIds);
    setSessionMenuId(null);
  }

  function startRenameSession(session: Session) {
    setRenamingSession(session);
    setRenameDraft(session.title || 'New Chat');
    setSessionMenuId(null);
  }

  async function saveRenamedSession() {
    if (!renamingSession || !renameDraft.trim()) return;
    setSessionActionBusy(true);
    try {
      await props.onRenameSession(renamingSession.id, renameDraft.trim());
      setRenamingSession(null);
      setRenameDraft('');
    } finally {
      setSessionActionBusy(false);
    }
  }

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
        <div className="mb-3 grid grid-cols-[minmax(0,1fr)_44px] gap-2">
          <button className="flex h-10 items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800" onClick={props.onNewSession}>
            <MessageSquareText size={16} />
            New chat
          </button>
          <button
            className={cn('flex h-10 items-center justify-center rounded-md border text-sm transition', bulkMode ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950')}
            title={bulkMode ? 'Exit selection' : 'Select chats'}
            aria-label={bulkMode ? 'Exit chat selection' : 'Select chats'}
            onClick={toggleBulkMode}
          >
            {bulkMode ? <X size={16} /> : <ListChecks size={17} />}
          </button>
        </div>
        {bulkMode && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-xs text-teal-800">
            <span>{selectedSessionIds.length} selected</span>
            <button className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-red-600 shadow-sm disabled:opacity-50" disabled={!selectedSessionIds.length || sessionActionBusy} onClick={() => requestDeleteSessions(selectedSessionIds)}>
              {sessionActionBusy ? <Loader2 className="animate-spin" size={13} /> : <Trash2 size={13} />}
              Delete
            </button>
          </div>
        )}

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
                {group.sessions.map(session => {
                  const selected = selectedSessionSet.has(session.id);
                  return (
                    <div key={session.id} className="relative">
                      <button
                        className={cn(
                          'group w-full rounded-md border px-3 py-2.5 pr-9 text-left transition',
                          props.currentSessionId === session.id ? 'border-teal-600 bg-teal-50' : 'border-transparent bg-white/60 hover:border-slate-200 hover:bg-white',
                          bulkMode && selected && 'border-teal-600 bg-teal-50',
                        )}
                        onClick={() => bulkMode ? toggleSessionSelected(session.id) : props.onOpenSession(session.id)}
                      >
                        <div className="flex items-center gap-2">
                          {bulkMode && (
                            <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', selected ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 bg-white text-transparent')}>
                              <CheckCircle2 size={11} />
                            </span>
                          )}
                          <span className="truncate text-sm font-medium text-slate-800">{session.title || 'New Chat'}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                          <span className="truncate">{scopeLabelForSession(session, props.vaults)}</span>
                          <span className="shrink-0">{formatTime(session.updatedAt)}</span>
                        </div>
                      </button>
                      {!bulkMode && (
                        <button
                          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:bg-slate-100 focus:text-slate-700"
                          aria-label="Chat actions"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSessionMenuId(prev => prev === session.id ? null : session.id);
                          }}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      )}
                      {sessionMenuId === session.id && (
                        <div className="absolute right-2 top-9 z-20 w-36 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg shadow-slate-950/10">
                          <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => startRenameSession(session)}>
                            <Pencil size={14} />
                            Rename
                          </button>
                          <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50" onClick={() => requestDeleteSessions([session.id])}>
                            <Trash2 size={14} />
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!filteredSessions.length && (
            <div className="rounded-md border border-dashed border-slate-200 bg-white/70 p-4 text-sm text-slate-500">No chats yet.</div>
          )}
        </div>
      </section>

      {renamingSession && (
        <AdminModal open title="Rename chat" description="Update the chat title shown in the sidebar." onClose={() => setRenamingSession(null)}>
          <div className="space-y-4">
            <Field label="Title" value={renameDraft} onChange={setRenameDraft} />
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60" disabled={!renameDraft.trim() || sessionActionBusy} onClick={saveRenamedSession}>
              {sessionActionBusy ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
              Save title
            </button>
          </div>
        </AdminModal>
      )}

      <DeleteSessionsModal
        open={pendingDeleteSessionIds.length > 0}
        count={pendingDeleteSessionIds.length}
        busy={sessionActionBusy}
        onClose={() => {
          if (!sessionActionBusy) setPendingDeleteSessionIds([]);
        }}
        onConfirm={() => deleteSessionsWithConfirm(pendingDeleteSessionIds)}
      />

      <section className="flex min-h-0 flex-col bg-slate-50/45">
        <header className="border-b border-slate-200/70 bg-white/68 px-8 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-[880px] items-center justify-between gap-6">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{selectedTitle}</h2>
              <p className="mt-1 text-sm text-slate-500">{scopeText}</p>
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
                  <button key={prompt} disabled={!modelReady} className="rounded-lg border border-slate-200 bg-white p-4 text-left text-sm text-slate-700 transition hover:border-teal-700 hover:text-teal-800 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => props.sendMessage(prompt)}>
                    <Search className="mb-3 text-teal-700" size={17} />
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[760px] space-y-5">
              {props.messages.map((message, index) => (
                <ChatBubble key={message.role + '-' + index} message={message} />
              ))}
              {props.isStreaming && (
                <div className="chat-message chat-message-assistant rounded-xl border border-slate-200/70 bg-white px-5 py-4 shadow-sm shadow-slate-200/40">
                    <ReasoningSummary trace={props.reasoningTrace} />
                    <div data-streaming-text className="mt-3">
                      <StreamingMarkdownContent content={props.streamingText || 'Searching selected knowledge...'} />
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
          <div className="mx-auto max-w-[880px] rounded-xl border border-slate-200 bg-white p-2 shadow-sm shadow-slate-200/60">
            <textarea
              className="chat-composer min-h-12 w-full resize-none bg-transparent px-3 py-3 outline-none"
              placeholder={inputPlaceholder}
              value={props.input}
              disabled={!props.indexed || props.isStreaming || !modelReady}
              onChange={event => props.setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  props.sendMessage();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2 px-1 pb-1">
              <ModelPicker
                models={props.models}
                selectedModel={props.selectedModel}
                selectedModelId={props.selectedModelId}
                disabled={props.isStreaming || props.modelsLoading || !props.models.length}
                loading={props.modelsLoading}
                onSelect={props.onSelectModel}
                agentUsesSelectedModel={agentUsesSelectedModel}
                compact
              />
              <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-teal-700 text-white transition hover:bg-teal-800 disabled:opacity-50" disabled={!props.input.trim() || props.isStreaming || !props.indexed || !modelReady} onClick={() => props.sendMessage()}>
                {props.isStreaming ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </footer>
      </section>
    </main>
  );
}
function ModelPicker({ models, selectedModel, selectedModelId, disabled, loading, onSelect, compact = false, agentUsesSelectedModel = true }: {
  models: ModelConfig[];
  selectedModel: ModelConfig | null;
  selectedModelId: string;
  disabled: boolean;
  loading: boolean;
  onSelect: (modelId: string) => void;
  compact?: boolean;
  agentUsesSelectedModel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeModel = selectedModel ?? models.find(model => model.id === selectedModelId) ?? models[0] ?? null;
  const modelHasKeyWarning = agentUsesSelectedModel && Boolean(activeModel && !activeModel.hasApiKey);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className={cn('relative shrink-0', compact ? 'w-auto max-w-[calc(100%-52px)]' : 'w-[340px]')}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center rounded-lg text-left transition disabled:cursor-not-allowed disabled:opacity-60',
          compact
            ? 'h-11 gap-2 px-2.5 text-slate-600 hover:bg-slate-100 hover:text-slate-950'
            : 'h-12 gap-3 border border-slate-200 bg-white px-3 shadow-sm shadow-slate-200/40 hover:border-teal-200 hover:bg-teal-50/30',
          compact && modelHasKeyWarning && 'text-amber-700 hover:bg-amber-50 hover:text-amber-800',
          !compact && modelHasKeyWarning && 'border-amber-200 bg-amber-50/60 hover:border-amber-300 hover:bg-amber-50',
          open && (compact ? 'bg-slate-100 text-slate-950' : 'border-teal-300 ring-4 ring-teal-700/10'),
        )}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={cn('flex shrink-0 items-center justify-center rounded-md', compact ? 'h-6 w-6 text-slate-500' : 'h-8 w-8 bg-teal-50 text-teal-700')}>
          {loading ? <Loader2 className="animate-spin" size={compact ? 14 : 16} /> : <BrainCircuit size={compact ? 14 : 16} />}
        </span>
        <span className={cn('min-w-0', compact ? 'max-w-[140px]' : 'flex-1')}>
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">{activeModel?.name || 'No model'}</span>
            {activeModel?.isDefault && !compact && <span className="rounded-full bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-700">Default</span>}
          </span>
          <span className={cn('mt-0.5 min-w-0 items-center gap-1.5 text-[11px] text-slate-500', compact ? 'hidden' : 'flex')}>
            <span className="truncate">{activeModel ? getProviderName(activeModel.baseUrl) : 'Not configured'}</span>
            {activeModel && <span className="text-slate-300">/</span>}
            {activeModel && <span className="truncate font-mono">{activeModel.model}</span>}
          </span>
        </span>
        <span className={cn('shrink-0 text-xs', compact && 'hidden', !agentUsesSelectedModel ? 'text-teal-700' : activeModel?.hasApiKey ? 'text-emerald-600' : 'text-amber-600')}>
          {!agentUsesSelectedModel ? 'Agent model' : activeModel?.hasApiKey ? 'Ready' : 'Key missing'}
        </span>
        {compact && <ChevronDown className={cn('shrink-0 transition', open && 'rotate-180')} size={14} />}
      </button>

      {open && (
        compact ? (
          <div className="absolute bottom-full right-0 z-30 mb-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-2 shadow-xl shadow-slate-950/12" role="listbox">
            <div className="px-3 pb-1 text-xs text-slate-400">Model</div>
            <div className="max-h-64 overflow-auto px-1.5">
              {models.map(model => {
                const selected = model.id === selectedModelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition hover:bg-slate-100 hover:text-slate-950',
                      selected && 'text-slate-950',
                      !model.hasApiKey && 'text-amber-700 hover:bg-amber-50 hover:text-amber-800',
                    )}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSelect(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-900">{model.name}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">{model.model}</span>
                    </span>
                    {selected && <Check size={15} className="shrink-0 text-slate-600" />}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="absolute right-0 z-30 mt-2 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl shadow-slate-950/12" role="listbox">
            <div className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase text-slate-400">Model routes</div>
            <div className="max-h-72 overflow-auto p-1.5">
              {models.map(model => {
                const selected = model.id === selectedModelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className={cn(
                      'flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition hover:bg-slate-50',
                      selected && 'bg-teal-50',
                    )}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSelect(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 text-transparent')}>
                      <CheckCircle2 size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-900">{model.name}</span>
                        {model.isDefault && <SoftBadge tone="info">Default</SoftBadge>}
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500">{getProviderName(model.baseUrl)} / {model.model}</span>
                    </span>
                    <span className={cn('mt-0.5 rounded-full px-2 py-0.5 text-[11px]', model.hasApiKey ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
                      {model.hasApiKey ? 'Ready' : 'Missing key'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function MarkdownContent({ children, sources = [] }: { children: string; sources?: ChatSource[] }) {
  function highlightSource(event: MouseEvent<HTMLAnchorElement>, href?: string) {
    const sourceMatch = href?.match(/^#source-(\d+)$/);
    if (!sourceMatch) return;

    event.preventDefault();
    const target = document.getElementById(`source-${sourceMatch[1]}`);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('source-highlight');
    window.setTimeout(() => {
      target.classList.add('source-highlight');
    }, 80);
    window.setTimeout(() => {
      target.classList.remove('source-highlight');
    }, 1700);
    window.history.replaceState(null, '', href);
  }

  return (
    <div className="chat-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            const sourceMatch = href?.match(/^#source-(\d+)$/);
            if (sourceMatch) {
              const source = sources[Number(sourceMatch[1]) - 1];
              return (
                <span className="source-ref">
                  <a href={href} onClick={event => highlightSource(event, href)} {...props}>[{sourceMatch[1]}]</a>
                  {source && (
                    <span className="source-preview" role="tooltip">
                      <span className="source-preview-title">{source.title || basenameFromPath(source.path)}</span>
                      <span className="source-preview-path">{source.path}</span>
                      {source.vaultName && <span className="source-preview-vault">{source.vaultName}</span>}
                    </span>
                  )}
                </span>
              );
            }
            return <a href={href} {...props}>{children}</a>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function StreamingMarkdownContent({ content }: { content: string }) {
  return <MarkdownContent>{buildKnowledgeCitationView(content, []).content}</MarkdownContent>;
}

function DeleteSessionsModal({ open, count, busy, onClose, onConfirm }: {
  open: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AdminModal
      open={open}
      title={count === 1 ? 'Delete chat' : 'Delete chats'}
      description={count === 1 ? 'This chat will be removed from your chat history.' : `${count} selected chats will be removed from your chat history.`}
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="flex gap-3 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-red-600 shadow-sm shadow-red-200/40">
            <Trash2 size={16} />
          </span>
          <div>
            <div className="font-semibold text-red-800">This action cannot be undone.</div>
            <div className="mt-0.5 text-red-700/85">The messages in {count === 1 ? 'this chat' : 'these chats'} will no longer appear in the Ask sidebar.</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            className="h-10 rounded-md border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-950 disabled:opacity-60"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex h-10 items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
            Delete
          </button>
        </div>
      </div>
    </AdminModal>
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
  const usage = getMessageUsage(message);
  const citationView = buildKnowledgeCitationView(message.content, getMessageSources(message));
  return (
    <div className={cn('message-row group', isUser ? 'message-row-user' : 'message-row-assistant')}>
      <div className={cn(isUser ? 'message-user-stack' : 'block')}>
        <div className={cn(
          'rounded-xl relative',
          isUser
            ? 'chat-message-user bg-slate-950 px-3.5 py-2.5 text-white shadow-sm shadow-slate-950/10'
            : 'chat-message chat-message-assistant border border-slate-200/70 bg-white px-5 pb-3.5 pt-4 shadow-sm shadow-slate-200/40',
        )}>
          {!isUser && message.reasoningTrace && <ReasoningSummary trace={message.reasoningTrace} />}
          {isUser ? <p>{message.content}</p> : <MarkdownContent sources={citationView.sources}>{citationView.content}</MarkdownContent>}
          {!isUser && citationView.sources.length > 0 && <KnowledgeSources sources={citationView.sources} />}
          {!isUser && (
            <div className="message-footer">
              <CopyMessageButton text={message.content} />
              {(calls.length > 0 || usage) && <MessageMeta calls={calls.length} usage={usage} />}
            </div>
          )}
        </div>
        {isUser ? (
          <div className="message-actions message-actions-user">
            {message.createdAt && <span className="text-[11px] text-slate-400">{formatTime(message.createdAt)}</span>}
            <CopyMessageButton text={message.content} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="message-copy-button" onClick={copyMessage} aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy'}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function KnowledgeSources({ sources }: { sources: ChatSource[] }) {
  const visibleSources = dedupeSources(sources).slice(0, 30);
  if (!visibleSources.length) return null;

  return (
    <div className="mt-5 border-t border-slate-100 pt-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">Sources</div>
      <ol className="space-y-1.5 text-xs leading-5 text-slate-500">
        {visibleSources.map((source, index) => (
          <li id={`source-${index + 1}`} key={`${source.vaultId || 'default'}:${source.path}`} className="source-item flex gap-2 scroll-mt-8">
            <span className="min-w-4 text-right text-slate-400">{index + 1}.</span>
            <span className="min-w-0">
              <span className="font-medium text-slate-600">{source.title || basenameFromPath(source.path)}</span>
              <span className="mx-1.5 text-slate-300">/</span>
              <span className="break-all text-slate-400">{source.path}</span>
              {source.vaultName && <span className="ml-1.5 text-slate-400">({source.vaultName})</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MessageMeta({ calls, usage }: { calls: number; usage?: ChatUsage }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-400">
      {calls > 0 && <span className="rounded-full bg-slate-50 px-2 py-1 text-slate-500">Searches {calls}</span>}
      {usage && <UsagePill usage={usage} />}
    </div>
  );
}

function UsagePill({ usage }: { usage: ChatUsage }) {
  const inputTokens = usage.inputTokens ?? usage.estimatedInputTokens;
  const outputTokens = usage.outputTokens ?? usage.estimatedOutputTokens;
  const items = [
    typeof inputTokens === 'number' ? ['input', formatTokenCount(inputTokens)] : null,
    typeof outputTokens === 'number' ? ['output', formatTokenCount(outputTokens)] : null,
    typeof usage.elapsedMs === 'number' ? ['cost', formatCost(usage.elapsedMs)] : null,
  ].filter(Boolean) as Array<[string, string]>;

  return (
    <span className="inline-flex flex-wrap items-center overflow-hidden rounded-full border border-slate-200 bg-slate-50 text-[11px] text-slate-500">
      {items.map(([label, value], index) => (
        <span key={label} className={cn('px-2 py-1', index > 0 && 'border-l border-slate-200')}>
          <span className="text-slate-400">{label}</span> {value}
        </span>
      ))}
    </span>
  );
}

function getMessageUsage(message: Message): ChatUsage | undefined {
  const usage = message.usage ?? message.metadata?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return usage;
}

function getMessageSources(message: Message): ChatSource[] {
  if (Array.isArray(message.metadata?.sources)) return message.metadata.sources;
  return [];
}

function dedupeSources(sources: ChatSource[]): ChatSource[] {
  const seen = new Set<string>();
  const result: ChatSource[] = [];
  for (const source of sources) {
    if (!source.path) continue;
    const key = `${source.vaultId || 'default'}:${source.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function buildKnowledgeCitationView(content: string, metadataSources: ChatSource[]) {
  const sources = dedupeSources(metadataSources);
  const sourceIndex = new Map<string, number>();

  function ensureSource(path: string) {
    const normalizedPath = normalizeSourcePath(path);
    const key = `default:${normalizedPath}`;
    const existingByPath = sources.findIndex(source => normalizeSourcePath(source.path) === normalizedPath);
    if (existingByPath >= 0) {
      sourceIndex.set(key, existingByPath + 1);
      return existingByPath + 1;
    }
    if (sourceIndex.has(key)) return sourceIndex.get(key)!;

    const nextIndex = sources.length + 1;
    sources.push({
      title: basenameFromPath(normalizedPath),
      path: normalizedPath,
    });
    sourceIndex.set(key, nextIndex);
    return nextIndex;
  }

  const withoutObsidianLinks = content.replace(
    /\s*[—-]\s*\[(\d+)\]\((obsidian:\/\/open\?[^)]+)\)/gi,
    (_match, _label: string, href: string) => {
      const path = extractObsidianFilePath(href);
      if (!path) return '';
      const index = ensureSource(path);
      return ` [[${index}]](#source-${index})`;
    },
  );

  const transformed = withoutObsidianLinks.replace(
    /(?:\*\*)?\s*[\[【]\s*(?:来源|Source)\s*[:：]\s*([^\]】]+?)\s*[\]】]\s*(?:\*\*)?/gi,
    (_match, rawPath: string) => {
      const index = ensureSource(rawPath);
      return `[[${index}]](#source-${index})`;
    },
  );

  const cleaned = transformed.replace(/(\]\(#source-\d+\)(?:\s+\]\(#source-\d+\))*)\s*---/g, '$1');

  return {
    content: cleaned,
    sources,
  };
}

function extractObsidianFilePath(href: string) {
  try {
    const url = new URL(href);
    return normalizeSourcePath(url.searchParams.get('file') || '');
  } catch {
    const match = href.match(/[?&]file=([^&]+)/i);
    return match ? normalizeSourcePath(decodeURIComponent(match[1])) : '';
  }
}

function normalizeSourcePath(path: string) {
  return path
    .replace(/[;；,，。.\s]+$/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function basenameFromPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const file = normalized.split('/').pop() || path;
  return file.replace(/\.md$/i, '');
}

function formatTokenCount(tokens: number) {
  if (tokens >= 1_000_000) return formatMetric(tokens / 1_000_000) + ' M token';
  if (tokens >= 1_000) return formatMetric(tokens / 1_000) + ' K token';
  return String(Math.max(0, Math.round(tokens))) + ' token';
}

function formatMetric(value: number) {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

function formatCost(ms: number) {
  if (ms < 1000) return String(Math.max(0, Math.round(ms))) + 'ms';
  if (ms < 60_000) return String(Math.round(ms / 1000)) + 's';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return String(minutes) + 'm ' + String(seconds) + 's';
}

function KnowledgePage({ token, vaults, loading, onChanged }: { token: string; vaults: Vault[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({ name: '', path: '', enabled: true });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [editingVault, setEditingVault] = useState<Vault | null>(null);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | ''>('');
  const visibleVaults = vaults.filter(vault => `${vault.name} ${vault.path}`.toLowerCase().includes(filter.toLowerCase()));

  function openCreate() {
    setDraft({ name: '', path: '', enabled: true });
    setEditingVault(null);
    setError('');
    setDrawerMode('create');
  }

  function openEdit(vault: Vault) {
    setDraft({ name: vault.name, path: vault.path, enabled: vault.enabled });
    setEditingVault(vault);
    setError('');
    setDrawerMode('edit');
  }

  function closeDrawer() {
    setDrawerMode('');
    setEditingVault(null);
    setError('');
  }

  async function saveVault() {
    if (!draft.name.trim() || !draft.path.trim()) {
      setError('请填写知识库名称和路径。');
      return;
    }
    setSaving(drawerMode === 'edit' && editingVault ? `edit:${editingVault.id}` : 'create');
    setError('');
    try {
      if (drawerMode === 'edit' && editingVault) {
        await updateVault(token, editingVault.id, draft);
      } else {
        await createVault(token, draft);
      }
      await onChanged();
      closeDrawer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存知识库失败');
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
      <div className="space-y-4">
        <AdminStatsBar items={[
          { label: 'Total', value: vaults.length, hint: 'knowledge bases' },
          { label: 'Enabled', value: vaults.filter(vault => vault.enabled).length, tone: 'good' },
          { label: 'Disabled', value: vaults.filter(vault => !vault.enabled).length, tone: vaults.some(vault => !vault.enabled) ? 'warn' : undefined },
          { label: 'Visible', value: visibleVaults.length, hint: filter ? 'filtered' : 'current view' },
        ]} />

        <ResourceToolbar
          search={filter}
          onSearch={setFilter}
          placeholder="按名称或路径过滤知识库"
          action={<PrimaryActionButton onClick={openCreate}>Add knowledge</PrimaryActionButton>}
        />

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
          <div className="grid grid-cols-[minmax(220px,1.1fr)_120px_120px_160px_230px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            <div>Knowledge base</div>
            <div>Status</div>
            <div>Files</div>
            <div>Last indexed</div>
            <div className="text-right">Actions</div>
          </div>
          {visibleVaults.map(vault => (
            <VaultRow
              key={vault.id}
              token={token}
              vault={vault}
              saving={saving}
              onEdit={() => openEdit(vault)}
              onDelete={async () => {
                if (!window.confirm(`删除知识库配置「${vault.name}」？`)) return;
                setSaving(`delete:${vault.id}`);
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
                setSaving(`reindex:${vault.id}`);
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
          {!visibleVaults.length && <div className="p-6"><EmptyPanel text={vaults.length ? '没有匹配的知识库。' : '还没有知识库配置。'} /></div>}
        </section>
        {error && !drawerMode && <InlineError text={error} />}
      </div>

      <AdminModal
        open={Boolean(drawerMode)}
        title={drawerMode === 'edit' ? '编辑知识库' : '新增知识库'}
        description="路径需要是后端机器可访问的 Markdown / Obsidian 目录。"
        onClose={closeDrawer}
      >
        <div className="space-y-4">
          <Field label="名称" value={draft.name} onChange={value => setDraft(prev => ({ ...prev, name: value }))} placeholder="例如：Product Wiki" />
          <Field label="路径" value={draft.path} onChange={value => setDraft(prev => ({ ...prev, path: value }))} placeholder="/mnt/e/wsl/my_project/wiki" />
          <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <span>启用索引</span>
            <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
          </label>
          {error && <InlineError text={error} />}
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60" disabled={Boolean(saving)} onClick={saveVault}>
            {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            保存知识库
          </button>
        </div>
      </AdminModal>
    </AdminShell>
  );
}

function VaultRow({ token, vault, saving, onEdit, onDelete, onReindex }: {
  token: string;
  vault: Vault;
  saving: string;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onReindex: () => Promise<void>;
}) {
  const statusQuery = useQuery({
    queryKey: ['vault-status', token, vault.id],
    queryFn: () => getVaultStatus(token, vault.id),
    enabled: Boolean(token && vault.id),
  });

  const indexed = statusQuery.data?.indexed ?? false;
  const indexing = Boolean(statusQuery.data?.status?.status?.isIndexing);
  const busy = saving.endsWith(`:${vault.id}`);

  return (
    <div className="grid grid-cols-[minmax(220px,1.1fr)_120px_120px_160px_230px] items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-slate-900">{vault.name}</div>
        <div className="mt-1 truncate text-xs text-slate-500">{vault.path}</div>
      </div>
      <div>
        {!vault.enabled ? <SoftBadge>Disabled</SoftBadge> : <StatusPill indexed={indexed} indexing={indexing} />}
      </div>
      <div className="text-sm text-slate-700">{compactNumber(statusQuery.data?.status?.files)}</div>
      <div className="text-sm text-slate-500">{formatTime(statusQuery.data?.status?.status?.lastUpdated)}</div>
      <div className="flex justify-end gap-2">
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60" disabled={busy || !vault.enabled} onClick={onReindex}>
          <RefreshCw size={15} />
          Reindex
        </button>
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50" onClick={onEdit}>
          <Pencil size={15} />
          Edit
        </button>
        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-60" disabled={busy} onClick={onDelete}>
          {busy ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  );
}

function PeoplePage({ token, users, vaults, loading, onChanged }: { token: string; users: AdminUser[]; vaults: Vault[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({ username: '', displayName: '', password: '', role: 'user' as 'admin' | 'user', status: 'active' as 'active' | 'disabled', vaultIds: [] as string[] });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | ''>('');
  const visibleUsers = users.filter(user => `${user.username} ${user.displayName} ${user.role} ${user.status}`.toLowerCase().includes(filter.toLowerCase()));

  function openCreate() {
    setDraft({ username: '', displayName: '', password: '', role: 'user', status: 'active', vaultIds: [] });
    setEditingUser(null);
    setError('');
    setDrawerMode('create');
  }

  function openEdit(user: AdminUser) {
    setDraft({
      username: user.username,
      displayName: user.displayName,
      password: '',
      role: user.role,
      status: user.status,
      vaultIds: user.vaultIds ?? [],
    });
    setEditingUser(user);
    setError('');
    setDrawerMode('edit');
  }

  function closeDrawer() {
    setDrawerMode('');
    setEditingUser(null);
    setError('');
  }

  async function saveUser() {
    if (!draft.username.trim() || (drawerMode === 'create' && !draft.password.trim())) {
      setError('请填写用户名和初始密码。');
      return;
    }
    setSaving(drawerMode === 'edit' && editingUser ? `edit:${editingUser.id}` : 'create');
    setError('');
    try {
      if (drawerMode === 'edit' && editingUser) {
        await updateUser(token, editingUser.id, {
          username: draft.username,
          displayName: draft.displayName,
          role: draft.role,
          status: draft.status,
          vaultIds: draft.vaultIds,
          password: draft.password || undefined,
        });
      } else {
        await createUser(token, draft);
      }
      await onChanged();
      closeDrawer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存用户失败');
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
      <div className="space-y-4">
        <AdminStatsBar items={[
          { label: 'Total', value: users.length, hint: 'members' },
          { label: 'Active', value: users.filter(user => user.status === 'active').length, tone: 'good' },
          { label: 'Admins', value: users.filter(user => user.role === 'admin').length, tone: 'info' },
          { label: 'Disabled', value: users.filter(user => user.status === 'disabled').length, tone: users.some(user => user.status === 'disabled') ? 'warn' : undefined },
        ]} />

        <ResourceToolbar
          search={filter}
          onSearch={setFilter}
          placeholder="按用户名、显示名、角色过滤"
          action={<PrimaryActionButton onClick={openCreate}>Add user</PrimaryActionButton>}
        />

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
          <div className="grid grid-cols-[minmax(220px,1fr)_120px_120px_150px_180px] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            <div>User</div>
            <div>Role</div>
            <div>Status</div>
            <div>Access</div>
            <div className="text-right">Actions</div>
          </div>
          {visibleUsers.map(user => (
            <UserRow
              key={user.id}
              user={user}
              saving={saving}
              onEdit={() => openEdit(user)}
              onDelete={async () => {
                if (!window.confirm(`删除用户「${user.username}」？`)) return;
                setSaving(`delete:${user.id}`);
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
          {!visibleUsers.length && <div className="p-6"><EmptyPanel text={users.length ? '没有匹配的用户。' : '还没有用户。'} /></div>}
        </section>
        {error && !drawerMode && <InlineError text={error} />}
      </div>

      <AdminModal
        open={Boolean(drawerMode)}
        title={drawerMode === 'edit' ? '编辑用户' : '新增用户'}
        description="管理员默认拥有全部知识库访问权限。"
        onClose={closeDrawer}
      >
        <div className="space-y-4">
          <Field label="用户名" value={draft.username} onChange={value => setDraft(prev => ({ ...prev, username: value }))} />
          <Field label="显示名" value={draft.displayName} onChange={value => setDraft(prev => ({ ...prev, displayName: value }))} />
          <Field label={drawerMode === 'edit' ? '新密码' : '初始密码'} value={draft.password} onChange={value => setDraft(prev => ({ ...prev, password: value }))} type="password" placeholder={drawerMode === 'edit' ? '留空不改' : undefined} />
          <SelectField label="角色" value={draft.role} onChange={value => setDraft(prev => ({ ...prev, role: value as 'admin' | 'user' }))} options={[['user', '普通用户'], ['admin', '管理员']]} />
          <SelectField label="状态" value={draft.status} onChange={value => setDraft(prev => ({ ...prev, status: value as 'active' | 'disabled' }))} options={[['active', '启用'], ['disabled', '停用']]} />
          <VaultChecks vaults={vaults} selected={draft.vaultIds} onChange={vaultIds => setDraft(prev => ({ ...prev, vaultIds }))} disabled={draft.role === 'admin'} />
          {error && <InlineError text={error} />}
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60" disabled={Boolean(saving)} onClick={saveUser}>
            {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            保存用户
          </button>
        </div>
      </AdminModal>
    </AdminShell>
  );
}

function UserRow({ user, saving, onEdit, onDelete }: {
  user: AdminUser;
  saving: string;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const busy = saving.endsWith(`:${user.id}`);

  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_120px_120px_150px_180px] items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-slate-900">{user.displayName || user.username}</div>
        <div className="mt-1 truncate text-xs text-slate-500">{user.username} · Created {formatTime(user.createdAt)}</div>
      </div>
      <div><SoftBadge tone={user.role === 'admin' ? 'info' : 'neutral'}>{user.role === 'admin' ? 'Admin' : 'User'}</SoftBadge></div>
      <div><SoftBadge tone={user.status === 'active' ? 'good' : 'neutral'}>{user.status === 'active' ? 'Active' : 'Disabled'}</SoftBadge></div>
      <div className="text-sm text-slate-600">{user.role === 'admin' ? 'All vaults' : `${user.vaultIds?.length ?? 0} vaults`}</div>
      <div className="flex justify-end gap-2">
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50" onClick={onEdit}>
          <Pencil size={15} />
          Edit
        </button>
        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-60" disabled={busy} onClick={onDelete}>
          {busy ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
        </button>
      </div>
    </div>
  );
}

function ModelsPage({ token, models, loading, onChanged }: { token: string; models: ModelConfig[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({
    name: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKey: '',
    enabled: true,
    isDefault: false,
  });
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [testResult, setTestResult] = useState('');
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | ''>('');
  const visibleModels = models.filter(model => `${model.name} ${model.baseUrl} ${model.model}`.toLowerCase().includes(filter.toLowerCase()));

  function openCreate() {
    setDraft({
      name: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKey: '',
      enabled: true,
      isDefault: false,
    });
    setEditingModel(null);
    setError('');
    setDrawerMode('create');
  }

  function openEdit(model: ModelConfig) {
    setDraft({
      name: model.name,
      baseUrl: model.baseUrl,
      model: model.model,
      apiKey: '',
      enabled: model.enabled,
      isDefault: model.isDefault,
    });
    setEditingModel(model);
    setError('');
    setDrawerMode('edit');
  }

  function closeDrawer() {
    setDrawerMode('');
    setEditingModel(null);
    setError('');
  }

  async function saveModel() {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      setError('请填写模型名称、Base URL 和模型名。');
      return;
    }
    setSaving(drawerMode === 'edit' && editingModel ? `edit:${editingModel.id}` : 'create');
    setError('');
    try {
      if (drawerMode === 'edit' && editingModel) {
        await updateModel(token, editingModel.id, {
          name: draft.name,
          baseUrl: draft.baseUrl,
          model: draft.model,
          apiKey: draft.apiKey || undefined,
          enabled: draft.enabled,
          isDefault: draft.isDefault,
        });
      } else {
        await createModel(token, draft);
      }
      await onChanged();
      closeDrawer();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存模型失败');
    } finally {
      setSaving('');
    }
  }

  return (
    <AdminShell
      icon={BrainCircuit}
      title="Models"
      description="Manage model routes, provider endpoints, API keys, and the default model used by Ask."
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="space-y-5">
        <AdminStatsBar items={[
          { label: 'Total', value: models.length, hint: 'model routes' },
          { label: 'Enabled', value: models.filter(model => model.enabled).length, tone: 'good' },
          { label: 'Default', value: models.find(model => model.isDefault)?.model || '-', hint: models.find(model => model.isDefault)?.name },
          { label: 'Missing keys', value: models.filter(model => !model.hasApiKey).length, tone: models.some(model => !model.hasApiKey) ? 'warn' : 'good' },
        ]} />

        <ResourceToolbar
          search={filter}
          onSearch={setFilter}
          placeholder="Filter by name, base URL, or model"
          action={<PrimaryActionButton onClick={openCreate}>Add model</PrimaryActionButton>}
        />

        {testResult && (
          <div className="flex items-start gap-3 rounded-lg border border-teal-100 bg-teal-50 px-4 py-3 text-sm text-teal-800 shadow-sm shadow-teal-900/5">
            <Activity className="mt-0.5 shrink-0" size={16} />
            <span className="min-w-0 break-words">{testResult}</span>
          </div>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm shadow-slate-200/40">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div>
              <div className="text-sm font-semibold text-slate-900">Configured routes</div>
              <div className="mt-1 text-xs text-slate-500">One route can be marked as default for Ask sessions.</div>
            </div>
            <div className="text-xs text-slate-500">{visibleModels.length} shown</div>
          </div>
          <div className="grid gap-3">
            {visibleModels.map(model => (
              <ModelRow
                key={model.id}
                model={model}
                saving={saving}
                onEdit={() => openEdit(model)}
                onDelete={async () => {
                  if (!window.confirm(`Delete model config "${model.name}"?`)) return;
                  setSaving(`delete:${model.id}`);
                  setError('');
                  try {
                    await deleteModel(token, model.id);
                    await onChanged();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Delete model failed');
                  } finally {
                    setSaving('');
                  }
                }}
                onTest={async () => {
                  setSaving(`test:${model.id}`);
                  setError('');
                  setTestResult('');
                  try {
                    const result = await testModel(token, model.id);
                    const latency = typeof result.latencyMs === 'number' ? ` (${result.latencyMs}ms)` : '';
                    setTestResult(`${model.name}: ${result.ok ? 'OK' : 'Failed'}${latency} - ${result.message}`);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Test model failed');
                  } finally {
                    setSaving('');
                  }
                }}
              />
            ))}
            {!visibleModels.length && <EmptyPanel text={models.length ? 'No model config matches the filter.' : 'No model configs yet.'} />}
          </div>
        </section>
        {error && !drawerMode && <InlineError text={error} />}
      </div>

      <AdminModal
        open={Boolean(drawerMode)}
        title={drawerMode === 'edit' ? 'Edit model route' : 'Add model route'}
        description="Use any OpenAI-compatible endpoint. API keys are never shown after saving."
        onClose={closeDrawer}
      >
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Display name" value={draft.name} onChange={value => setDraft(prev => ({ ...prev, name: value }))} placeholder="Default DeepSeek" />
            <Field label="Model" value={draft.model} onChange={value => setDraft(prev => ({ ...prev, model: value }))} />
          </div>
          <Field label="Base URL" value={draft.baseUrl} onChange={value => setDraft(prev => ({ ...prev, baseUrl: value }))} />
          <Field label="API Key" value={draft.apiKey} onChange={value => setDraft(prev => ({ ...prev, apiKey: value }))} type="password" placeholder={editingModel?.hasApiKey ? 'Configured. Leave blank to keep current key.' : undefined} />
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
              <span>Enabled</span>
              <input type="checkbox" checked={draft.enabled} onChange={event => setDraft(prev => ({ ...prev, enabled: event.target.checked }))} />
            </label>
            <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
              <span>Default</span>
              <input type="checkbox" checked={draft.isDefault} onChange={event => setDraft(prev => ({ ...prev, isDefault: event.target.checked }))} />
            </label>
          </div>
          {error && <InlineError text={error} />}
          <button className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-slate-950 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60" disabled={Boolean(saving)} onClick={saveModel}>
            {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            Save model
          </button>
        </div>
      </AdminModal>
    </AdminShell>
  );
}

function ModelRow({ model, saving, onEdit, onDelete, onTest }: {
  model: ModelConfig;
  saving: string;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onTest: () => Promise<void>;
}) {
  const busy = saving.endsWith(`:${model.id}`);
  const provider = getProviderName(model.baseUrl);

  return (
    <article className={cn(
      'group grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-lg border bg-white p-4 transition hover:border-teal-200 hover:shadow-md hover:shadow-slate-200/50',
      model.isDefault ? 'border-teal-200 ring-1 ring-teal-100' : 'border-slate-200',
      !model.enabled && 'bg-slate-50/70',
    )}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700">
            <BrainCircuit size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-slate-950">{model.name}</h3>
              {model.isDefault && <SoftBadge tone="info">Default</SoftBadge>}
              <SoftBadge tone={model.enabled ? 'good' : 'neutral'}>{model.enabled ? 'Enabled' : 'Disabled'}</SoftBadge>
              <SoftBadge tone={model.hasApiKey ? 'good' : 'warn'}>{model.hasApiKey ? 'Key ready' : 'Missing key'}</SoftBadge>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{model.model}</span>
              <span className="text-slate-300">/</span>
              <span>{provider}</span>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-slate-500"><Network size={13} /> Endpoint</div>
          <div className="min-w-0 truncate font-mono text-slate-700">{model.baseUrl}</div>
          <div className="flex items-center gap-1.5 font-medium text-slate-500"><KeyRound size={13} /> Secret</div>
          <div className={cn('min-w-0 truncate', model.hasApiKey ? 'text-emerald-700' : 'text-amber-700')}>{model.hasApiKey ? 'API key configured' : 'Add an API key before using this route'}</div>
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-2">
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800 disabled:opacity-60" disabled={busy} onClick={onTest}>
          {saving === `test:${model.id}` ? <Loader2 className="animate-spin" size={15} /> : <Activity size={15} />}
          Test
        </button>
        <button className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50" onClick={onEdit}>
          <Pencil size={15} />
          Edit
        </button>
        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-60" disabled={busy} onClick={onDelete} aria-label="Delete model">
          {saving === `delete:${model.id}` ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
        </button>
      </div>
    </article>
  );
}

function AgentsPage({ token, agent, loading, onChanged }: {
  token: string;
  agent?: AgentConfig;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentConfig>({ provider: 'openai_agents', claudeModel: '', maxTurns: 8 });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (agent) setDraft(agent);
  }, [agent]);

  async function saveAgent() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await updateAgentConfig(token, draft);
      await onChanged();
      setMessage('Agent strategy saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save agent failed');
    } finally {
      setSaving(false);
    }
  }

  async function testAgent() {
    setTesting(true);
    setError('');
    setMessage('');
    try {
      const result = await testAgentConfig(token, draft);
      const latency = typeof result.latencyMs === 'number' && result.latencyMs > 0 ? ` (${result.latencyMs}ms)` : '';
      setMessage(`${result.ok ? 'OK' : 'Failed'}${latency} - ${result.message}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test agent failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <AdminShell
      icon={Bot}
      title="Agents"
      description="配置问答策略运行时。Agent 负责工具调用和 loop，模型路由仍在 Models 页面自由选择。"
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="space-y-5">
        <AdminStatsBar items={[
          { label: 'Active', value: draft.provider === 'claude_code' ? 'Claude' : 'OpenAI', hint: 'agent runtime', tone: 'info' },
          { label: 'Tools', value: 13, hint: 'knowledge tools', tone: 'good' },
          { label: 'Max turns', value: draft.maxTurns, hint: 'loop limit' },
          { label: 'Model source', value: draft.provider === 'claude_code' ? 'Agent' : 'Ask', hint: draft.provider === 'claude_code' ? 'Claude login' : 'selected model' },
        ]} />

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
            <div className="mb-5">
              <h2 className="text-base font-semibold text-slate-950">Default agent runtime</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                The selected agent controls tool selection, tool loop, and final synthesis. Users can still choose any enabled model route from Ask.
              </p>
            </div>

            <div className="space-y-5">
              <SelectField
                label="Agent runtime"
                value={draft.provider}
                onChange={value => setDraft(prev => ({ ...prev, provider: value as AgentProvider }))}
                options={[
                  ['openai_agents', 'OpenAI Agents SDK'],
                  ['claude_code', 'Claude Code Agent SDK'],
                ]}
              />

              {draft.provider === 'claude_code' ? (
                <div className="space-y-4">
                  <Field
                    label="Claude model alias"
                    value={draft.claudeModel}
                    onChange={value => setDraft(prev => ({ ...prev, claudeModel: value }))}
                    placeholder="留空使用 Claude Code 默认模型，或填 sonnet / opus"
                  />
                  <NumberField
                    label="Max turns"
                    value={draft.maxTurns}
                    min={1}
                    max={20}
                    onChange={value => setDraft(prev => ({ ...prev, maxTurns: value }))}
                  />
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-600">
                    Claude Code Agent uses the server's local Claude login. TeamWiki only exposes read-only knowledge tools to it.
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-600">
                  OpenAI Agents SDK uses the model selected in Ask or the default model route configured in Models.
                </div>
              )}

              {error && <InlineError text={error} />}
              {message && <div className="rounded-lg border border-teal-100 bg-teal-50 px-3 py-2 text-sm text-teal-800">{message}</div>}

              <div className="flex flex-wrap items-center gap-2">
                <button className="flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving || testing} onClick={saveAgent}>
                  {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                  Save agent
                </button>
                <button className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-600 hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800 disabled:opacity-60" disabled={saving || testing} onClick={testAgent}>
                  {testing ? <Loader2 className="animate-spin" size={16} /> : <Activity size={16} />}
                  Test runtime
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
            <h2 className="text-base font-semibold text-slate-950">Runtime map</h2>
            <div className="mt-4 space-y-3 text-sm">
              <RuntimeLine active={draft.provider === 'openai_agents'} title="OpenAI Agents SDK" detail="Agent loop + TeamWiki direct tools + selected model route" />
              <RuntimeLine active={draft.provider === 'claude_code'} title="Claude Code Agent SDK" detail="Local Claude login + in-process custom tools + optional Claude model alias" />
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function RuntimeLine({ active, title, detail }: { active: boolean; title: string; detail: string }) {
  return (
    <div className={cn('rounded-lg border px-3 py-3', active ? 'border-teal-200 bg-teal-50' : 'border-slate-100 bg-slate-50')}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-slate-900">{title}</span>
        <SoftBadge tone={active ? 'good' : 'neutral'}>{active ? 'Active' : 'Standby'}</SoftBadge>
      </div>
      <div className="mt-1 text-xs leading-5 text-slate-500">{detail}</div>
    </div>
  );
}

function getProviderName(baseUrl: string) {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('deepseek')) return 'DeepSeek';
  if (lower.includes('openai')) return 'OpenAI';
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'Local';
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, '');
  } catch {
    return 'Custom provider';
  }
}

function InsightsPage({ overview, usage, vaults, models, users }: { overview?: Overview; usage?: UsageSummary; vaults: Vault[]; models: ModelConfig[]; users: AdminUser[] }) {
  const vaultById = (vaultId: string | null) => vaultId ? vaults.find(vault => vault.id === vaultId) ?? null : null;
  return (
    <AdminShell icon={Gauge} title="Insights" description="基础运行概览。后续会接入问答次数、token 用量和用户排行。">
      <div className="grid grid-cols-4 gap-4">
        <InfoPanel label="Users" value={overview?.users ?? users.length} />
        <InfoPanel label="Active users" value={overview?.activeUsers ?? users.filter(user => user.status === 'active').length} />
        <InfoPanel label="Questions" value={usage?.totalQuestions ?? 0} />
        <InfoPanel label="Tokens" value={formatTokenCount(usage?.totalTokens ?? 0)} />
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
            {(usage?.byVault ?? []).map(item => {
              const vault = vaultById(item.vaultId);
              const unlinked = !vault;
              return (
                <div key={item.vaultId || 'none'} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{vault?.name || 'Unlinked vault'}</span>
                      {unlinked && (
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-200 bg-amber-50 text-[10px] font-semibold text-amber-700"
                          title="This usage record points to a vault that no longer exists, was deleted, or is not available in the current vault configuration."
                        >
                          ?
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{formatTokenCount(item.totalTokens)}</div>
                  </div>
                  <span className="rounded-full bg-teal-50 px-2 py-1 text-xs text-teal-700">{item.totalQuestions} questions</span>
                </div>
              );
            })}
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

const RECOMMENDED_SYSTEM_PROMPT_TEMPLATE = `你是一个面向团队知识库的中文 AI 助手。

目标：
1. 基于团队知识库回答问题、梳理概念、解释流程、分析影响范围和发现风险。
2. 始终尊重知识库证据边界，不把检索不到的内容编造成事实。
3. 当问题可能跨多个知识库时，明确区分不同知识库中的证据。

工作方式：
1. 优先使用工具检索和读取原始文档，再给出结论。
2. 没有足够证据时，直接说明“不确定”或“未找到足够依据”。
3. 涉及流程、依赖、影响范围、风险、版本变化时，主动扩大检索范围。
4. 默认使用中文回答，技术名词可以保留英文。

来源要求：
1. 核心论点必须标注来源路径。
2. 没有 read_note 支撑时，不要把 search 结果里的标题直接当成事实结论。
3. 不要伪造来源路径。

回答风格：
1. 先给结论，再给依据。
2. 长回答优先分点。
3. 来源格式优先使用：[来源: path/to/file.md]。`;

function SystemPromptPage({ token, prompt, loading, onChanged }: { token: string; prompt?: SystemPromptResponse; loading: boolean; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [selectedVaultId, setSelectedVaultId] = useState('');
  const [previewMode, setPreviewMode] = useState<'runtime' | 'base'>('runtime');
  const [activeTab, setActiveTab] = useState<'behavior' | 'sources' | 'safety' | 'advanced'>('behavior');
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
  const sourceLabel = prompt?.source === 'database' ? 'Database' : prompt?.source === 'environment' ? 'Environment' : prompt?.source === 'default' ? 'Default template' : '-';
  const draftStats = useMemo(() => {
    const trimmed = draft.trim();
    return {
      chars: draft.length,
      lines: draft ? draft.split('\n').length : 0,
      sections: (trimmed.match(/\n\d+\./g) ?? []).length,
    };
  }, [draft]);
  const qualityChecks = useMemo(() => {
    const text = draft.toLowerCase();
    return [
      {
        label: 'Evidence boundary',
        description: 'The assistant should say when evidence is insufficient instead of inventing facts.',
        ok: /insufficient|not enough|uncertain|unknown|do not invent|do not fabricate|evidence/.test(text),
      },
      {
        label: 'Source paths',
        description: 'Important claims should keep knowledge-base source paths or source labels.',
        ok: /source|sources|path|citation|citations/.test(text),
      },
      {
        label: 'Tool-first reading',
        description: 'The assistant should search and read original notes before drawing conclusions.',
        ok: /read_note|search|read|tool/.test(text),
      },
      {
        label: 'Team context',
        description: 'The prompt should fit Chinese team knowledge-base collaboration.',
        ok: /vault|team|knowledge|knowledge base|chinese/.test(text),
      },
    ];
  }, [draft]);
  const passedChecks = qualityChecks.filter(item => item.ok).length;
  const previewText = previewMode === 'base' ? draft : selectedPreview?.prompt || 'No runtime preview.';
  const tabs = [
    { key: 'behavior' as const, label: 'Behavior' },
    { key: 'sources' as const, label: 'Sources' },
    { key: 'safety' as const, label: 'Safety' },
    { key: 'advanced' as const, label: 'Advanced' },
  ];

  async function save() {
    if (!draft.trim()) {
      setError('System prompt cannot be empty.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await updateSystemPrompt(token, draft);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save system prompt.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      icon={Settings}
      title="Settings"
      description="Configure how the Ask agent behaves, cites sources, and handles uncertain answers."
      action={<RefreshButton loading={loading} onClick={onChanged} />}
    >
      <div className="space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-950">Agent settings</h2>
                <SoftBadge tone={dirty ? 'warn' : 'good'}>{dirty ? 'Unsaved' : 'Synced'}</SoftBadge>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
                Current policy: knowledge-first answers, source-aware citations, and conservative handling when evidence is weak.
              </p>
            </div>
            <div className="grid grid-cols-4 gap-3 text-right text-xs">
              <div>
                <div className="font-semibold text-slate-950">{sourceLabel}</div>
                <div className="mt-1 text-slate-500">Source</div>
              </div>
              <div>
                <div className="font-semibold text-slate-950">{passedChecks}/{qualityChecks.length}</div>
                <div className="mt-1 text-slate-500">Health</div>
              </div>
              <div>
                <div className="font-semibold text-slate-950">{prompt?.effectivePrompts.length ?? 0}</div>
                <div className="mt-1 text-slate-500">Previews</div>
              </div>
              <div>
                <div className="font-semibold text-slate-950">{draftStats.chars}</div>
                <div className="mt-1 text-slate-500">Chars</div>
              </div>
            </div>
          </div>
        </section>

        <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={cn('h-9 rounded-md px-3 text-sm font-medium transition', activeTab === tab.key ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'behavior' && (
          <div className="grid grid-cols-2 gap-4">
            <SettingsPolicyCard title="Knowledge first" status="Enabled" description="The agent searches selected vaults before forming an answer." />
            <SettingsPolicyCard title="Answer language" status="Chinese by default" description="Technical terms can remain in English when that is clearer." />
            <SettingsPolicyCard title="Answer structure" status="Conclusion first" description="Long answers prefer concise sections and bullet points." />
            <SettingsPolicyCard title="Multi-vault reasoning" status="Separated evidence" description="When multiple vaults are selected, evidence should remain attributable to each vault." />
          </div>
        )}

        {activeTab === 'sources' && (
          <div className="grid grid-cols-2 gap-4">
            <SettingsPolicyCard title="Required citations" status="Recommended" description="Core claims should include source paths from the knowledge base." />
            <SettingsPolicyCard title="No fabricated sources" status="Enabled" description="The agent should not invent source paths or treat search titles as facts." />
            <SettingsPolicyCard title="Runtime previews" status={(prompt?.effectivePrompts.length ?? 0) + ' vaults'} description="Each enabled vault receives a runtime prompt assembled from the base policy." />
            <SettingsPolicyCard title="Source format" status="Path-based" description="Preferred answer format keeps source paths readable and traceable." />
          </div>
        )}

        {activeTab === 'safety' && (
          <div className="grid grid-cols-2 gap-4">
            <SettingsPolicyCard title="Weak evidence" status="Say uncertain" description="When the knowledge base is insufficient, the assistant should say so directly." />
            <SettingsPolicyCard title="High-stakes topics" status="Careful answers" description="Medical, legal, and financial answers should avoid overconfident guidance." />
            <SettingsPolicyCard title="Scope boundary" status="Knowledge-scoped" description="The agent should not present missing knowledge-base content as confirmed fact." />
            <SettingsPolicyCard title="Prompt health" status={passedChecks + '/' + qualityChecks.length + ' checks'} description="These checks are heuristics for the advanced base prompt." tone={passedChecks === qualityChecks.length ? 'good' : 'warn'} />
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-5">
            <section className="rounded-xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold">Base system prompt</h2>
                    <SoftBadge tone={dirty ? 'warn' : 'good'}>{dirty ? 'Unsaved' : 'Synced'}</SoftBadge>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    Advanced editor for the raw policy passed to the Ask agent.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:border-slate-300 hover:text-slate-950"
                    onClick={() => setDraft(RECOMMENDED_SYSTEM_PROMPT_TEMPLATE)}
                  >
                    <Sparkles size={15} />
                    Template
                  </button>
                  <button className="flex h-10 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm text-white hover:bg-slate-800 disabled:opacity-60" disabled={saving || !dirty} onClick={save}>
                    {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                    Save
                  </button>
                </div>
              </div>
              {error && <div className="px-5 pt-4"><InlineError text={error} /></div>}
              <div className="p-5">
                <textarea
                  className="min-h-[520px] w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-6 outline-none transition focus:border-teal-700 focus:bg-white focus:ring-4 focus:ring-teal-700/10"
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  placeholder="Enter system prompt"
                />
              </div>
            </section>

            <aside className="space-y-4">
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30">
                <div className="mb-4 flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                    <ShieldCheck size={19} />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold">Quality checks</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-500">Quick heuristics before saving the advanced prompt.</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {qualityChecks.map(item => (
                    <div key={item.label} className="flex gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
                      {item.ok ? <CheckCircle2 className="mt-0.5 text-emerald-600" size={16} /> : <CircleAlert className="mt-0.5 text-amber-600" size={16} />}
                      <div>
                        <div className="text-sm font-medium text-slate-800">{item.label}</div>
                        <div className="mt-0.5 text-xs leading-5 text-slate-500">{item.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">Preview</h2>
                    <p className="mt-1 text-sm leading-6 text-slate-500">Inspect the base prompt or one runtime vault prompt.</p>
                  </div>
                  <div className="flex rounded-md border border-slate-200 bg-slate-50 p-1">
                    {(['runtime', 'base'] as const).map(mode => (
                      <button
                        key={mode}
                        className={cn('h-8 rounded px-2.5 text-xs font-medium transition', previewMode === mode ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
                        onClick={() => setPreviewMode(mode)}
                      >
                        {mode === 'runtime' ? 'Runtime' : 'Base'}
                      </button>
                    ))}
                  </div>
                </div>
                {previewMode === 'runtime' && (
                  <div className="mt-4">
                    <SelectField
                      label="Vault"
                      value={selectedPreview?.vaultId ?? ''}
                      onChange={setSelectedVaultId}
                      options={(prompt?.effectivePrompts ?? []).map(item => [item.vaultId, item.vaultName])}
                    />
                  </div>
                )}
              </section>

              <section className="max-h-[500px] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100 shadow-sm shadow-slate-200/30">
                <pre className="whitespace-pre-wrap break-words text-xs leading-6">{previewText}</pre>
              </section>
            </aside>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function SettingsPolicyCard({ title, status, description, tone = 'info' }: { title: string; status: string; description: string; tone?: 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
        </div>
        <SoftBadge tone={tone}>{status}</SoftBadge>
      </div>
    </section>
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

function AdminStatsBar({ items }: { items: Array<{ label: string; value: string | number; hint?: string; tone?: 'good' | 'warn' | 'bad' | 'info' }> }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      {items.map(item => (
        <div key={item.label} className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm shadow-slate-200/30">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">{item.label}</div>
          <div className={cn(
            'mt-2 text-2xl font-semibold',
            item.tone === 'good' && 'text-emerald-700',
            item.tone === 'warn' && 'text-amber-700',
            item.tone === 'bad' && 'text-red-700',
            item.tone === 'info' && 'text-teal-700',
          )}>{item.value}</div>
          {item.hint && <div className="mt-1 truncate text-xs text-slate-500">{item.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function ResourceToolbar({ search, onSearch, placeholder, action }: {
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm shadow-slate-200/30">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-2.5 text-slate-400" size={15} />
        <input
          className="h-10 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none transition focus:border-teal-700 focus:bg-white focus:ring-4 focus:ring-teal-700/10"
          value={search}
          placeholder={placeholder}
          onChange={event => onSearch(event.target.value)}
        />
      </div>
      {action}
    </div>
  );
}

function PrimaryActionButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800" onClick={onClick}>
      <Plus size={16} />
      {children}
    </button>
  );
}

function SoftBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
      tone === 'neutral' && 'bg-slate-100 text-slate-600',
      tone === 'good' && 'bg-emerald-50 text-emerald-700',
      tone === 'warn' && 'bg-amber-50 text-amber-700',
      tone === 'bad' && 'bg-red-50 text-red-700',
      tone === 'info' && 'bg-teal-50 text-teal-700',
    )}>
      {children}
    </span>
  );
}

function AdminModal({ open, title, description, children, onClose }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 py-6">
      <button className="absolute inset-0 cursor-default bg-slate-950/35 backdrop-blur-sm" aria-label="关闭弹窗" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[calc(100vh-48px)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/80 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}
          </div>
          <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 shadow-sm shadow-slate-200/40 hover:bg-slate-950 hover:text-white" aria-label="关闭弹窗" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {children}
        </div>
      </section>
    </div>
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

function NumberField({ label, value, onChange, min, max }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-500">{label}</span>
      <input
        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-700 focus:ring-4 focus:ring-teal-700/10"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={event => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
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
