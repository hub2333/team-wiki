import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { getRequestUserId, requireAdmin } from '../auth/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { ModelConfig, User } from '../db/types.js';
import type { VaultGraphManager } from '../graph/manager.js';
import {
  DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT,
  SYSTEM_PROMPT_SETTING_KEY,
  buildKnowledgeAgentPromptFromBase,
} from '../agent/prompts.js';

export const DEV_JWT_SECRET = 'team-wiki-local-dev-secret';

export function getJwtSecret(config: AppConfig): string {
  return config.jwtSecret || DEV_JWT_SECRET;
}

export function createPublicAuthRouter(config: AppConfig): Router {
  const router = Router();

  router.post('/auth/login', async (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const user = await getDb().getUserByUsername(username);
    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      getJwtSecret(config),
      { expiresIn: '7d' }
    );

    res.json({ token, user: publicUser(user) });
  });

  return router;
}

export function createProductRouter(config: AppConfig, vaultManager?: VaultGraphManager): Router {
  const router = Router();

  router.get('/me', async (req: Request, res: Response) => {
    const user = await getDb().getUser(getRequestUserId(req));
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const vaults = await getAccessibleVaults(user);
    res.json({ user: publicUser(user), vaults });
  });

  router.get('/vaults', async (req: Request, res: Response) => {
    const user = await getDb().getUser(getRequestUserId(req));
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ vaults: await getAccessibleVaults(user) });
  });

  router.get('/vaults/:id/status', async (req: Request, res: Response) => {
    const user = await getDb().getUser(getRequestUserId(req));
    const vaultId = routeId(req);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const accessible = await getAccessibleVaults(user);
    if (!accessible.some(vault => vault.id === vaultId)) {
      res.status(403).json({ error: 'Vault access denied' });
      return;
    }
    const status = vaultManager?.listStatus().find(item => item.id === vaultId) ?? null;
    const vault = accessible.find(item => item.id === vaultId) ?? null;
    res.json({
      vault,
      status,
      indexed: Boolean(status),
    });
  });

  router.get('/models/default', async (_req: Request, res: Response) => {
    const model = await getDb().getDefaultModelConfig();
    res.json({ model: model ? publicModel(model) : null });
  });

  router.get('/admin/overview', requireAdmin, async (_req: Request, res: Response) => {
    const [users, vaults, models] = await Promise.all([
      getDb().listUsers(),
      getDb().listVaults(),
      getDb().listModelConfigs(),
    ]);
    res.json({
      users: users.length,
      activeUsers: users.filter(user => user.status === 'active').length,
      vaults: vaults.length,
      enabledVaults: vaults.filter(vault => vault.enabled).length,
      models: models.length,
      enabledModels: models.filter(model => model.enabled).length,
      defaultModel: models.find(model => model.isDefault)?.model || config.aiModel,
    });
  });

  router.get('/admin/system-prompt', requireAdmin, async (_req: Request, res: Response) => {
    const setting = await getDb().getSetting(SYSTEM_PROMPT_SETTING_KEY);
    const basePrompt = setting?.value || config.agentSystemPrompt || DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT;
    const contexts = vaultManager?.list() ?? [];
    res.json({
      basePrompt,
      source: setting ? 'database' : config.agentSystemPrompt ? 'environment' : 'default',
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
      effectivePrompts: contexts.map(ctx => ({
        vaultId: ctx.vault.id,
        vaultName: ctx.vault.name,
        prompt: buildKnowledgeAgentPromptFromBase(ctx.graph, basePrompt),
      })),
    });
  });

  router.put('/admin/system-prompt', requireAdmin, async (req: Request, res: Response) => {
    const basePrompt = String(req.body?.basePrompt || '').trim();
    if (!basePrompt) {
      res.status(400).json({ error: 'System prompt cannot be empty' });
      return;
    }
    const setting = await getDb().setSetting(SYSTEM_PROMPT_SETTING_KEY, basePrompt, getRequestUserId(req));
    const contexts = vaultManager?.list() ?? [];
    res.json({
      basePrompt: setting.value,
      source: 'database',
      updatedAt: setting.updatedAt,
      updatedBy: setting.updatedBy ?? null,
      effectivePrompts: contexts.map(ctx => ({
        vaultId: ctx.vault.id,
        vaultName: ctx.vault.name,
        prompt: buildKnowledgeAgentPromptFromBase(ctx.graph, setting.value),
      })),
    });
  });

  router.get('/admin/users', requireAdmin, async (_req: Request, res: Response) => {
    const users = await getDb().listUsers();
    const rows = await Promise.all(users.map(async user => ({
      ...publicUser(user),
      vaultIds: await getDb().getUserVaultIds(user.id),
    })));
    res.json({ users: rows });
  });

  router.post('/admin/users', requireAdmin, async (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const user = await getDb().createUser({
      username,
      displayName: String(req.body?.displayName || username).trim(),
      role: req.body?.role === 'admin' ? 'admin' : 'user',
      status: req.body?.status === 'disabled' ? 'disabled' : 'active',
      passwordHash: hashPassword(password),
    });
    await getDb().setUserVaults(user.id, normalizeIdList(req.body?.vaultIds));
    res.status(201).json({ user: publicUser(user) });
  });

  router.put('/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
    const patch: any = {
      username: req.body?.username ? String(req.body.username).trim() : undefined,
      displayName: req.body?.displayName ? String(req.body.displayName).trim() : undefined,
      role: req.body?.role === 'admin' ? 'admin' : req.body?.role === 'user' ? 'user' : undefined,
      status: req.body?.status === 'disabled' ? 'disabled' : req.body?.status === 'active' ? 'active' : undefined,
    };
    if (req.body?.password) {
      patch.passwordHash = hashPassword(String(req.body.password));
    }
    Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);
    const user = await getDb().updateUser(routeId(req), patch);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (Array.isArray(req.body?.vaultIds)) {
      await getDb().setUserVaults(user.id, normalizeIdList(req.body.vaultIds));
    }
    res.json({ user: publicUser(user), vaultIds: await getDb().getUserVaultIds(user.id) });
  });

  router.delete('/admin/users/:id', requireAdmin, async (req: Request, res: Response) => {
    await getDb().deleteUser(routeId(req));
    res.json({ ok: true });
  });

  router.get('/admin/vaults', requireAdmin, async (_req: Request, res: Response) => {
    res.json({ vaults: await getDb().listVaults() });
  });

  router.post('/admin/vaults', requireAdmin, async (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const path = String(req.body?.path || '').trim();
    if (!name || !path) {
      res.status(400).json({ error: 'Vault name and path are required' });
      return;
    }
    const vault = await getDb().createVault({
      name,
      path,
      enabled: req.body?.enabled !== false,
    });
    const admins = (await getDb().listUsers()).filter(user => user.role === 'admin');
    for (const admin of admins) {
      const ids = new Set(await getDb().getUserVaultIds(admin.id));
      ids.add(vault.id);
      await getDb().setUserVaults(admin.id, [...ids]);
    }
    await syncVaultManager(vaultManager);
    res.status(201).json({ vault });
  });

  router.put('/admin/vaults/:id', requireAdmin, async (req: Request, res: Response) => {
    const vault = await getDb().updateVault(routeId(req), {
      name: req.body?.name ? String(req.body.name).trim() : undefined,
      path: req.body?.path ? String(req.body.path).trim() : undefined,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    });
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' });
      return;
    }
    await syncVaultManager(vaultManager);
    res.json({ vault });
  });

  router.delete('/admin/vaults/:id', requireAdmin, async (req: Request, res: Response) => {
    await getDb().deleteVault(routeId(req));
    await syncVaultManager(vaultManager);
    res.json({ ok: true });
  });

  router.post('/admin/vaults/:id/reindex', requireAdmin, async (req: Request, res: Response) => {
    const vault = await getDb().getVault(routeId(req));
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' });
      return;
    }
    if (!vault.enabled) {
      res.status(409).json({ error: 'Vault is disabled' });
      return;
    }
    const ctx = await vaultManager?.reindex(vault);
    res.json({
      ok: true,
      status: ctx
        ? {
            id: vault.id,
            name: vault.name,
            path: vault.path,
            files: ctx.graph.nodes.size,
            status: ctx.graph.getStatus(),
          }
        : null,
    });
  });

  router.get('/admin/models', requireAdmin, async (_req: Request, res: Response) => {
    const models = await getDb().listModelConfigs();
    res.json({ models: models.map(publicModel) });
  });

  router.post('/admin/models', requireAdmin, async (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    const baseUrl = String(req.body?.baseUrl || '').trim();
    const model = String(req.body?.model || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!name || !baseUrl || !model) {
      res.status(400).json({ error: 'Model name, base URL, and model are required' });
      return;
    }
    const created = await getDb().createModelConfig({
      name,
      baseUrl,
      model,
      apiKey,
      enabled: req.body?.enabled !== false,
      isDefault: Boolean(req.body?.isDefault),
    });
    res.status(201).json({ model: publicModel(created) });
  });

  router.put('/admin/models/:id', requireAdmin, async (req: Request, res: Response) => {
    const current = await getDb().getModelConfig(routeId(req));
    if (!current) {
      res.status(404).json({ error: 'Model config not found' });
      return;
    }
    const model = await getDb().updateModelConfig(routeId(req), {
      name: req.body?.name ? String(req.body.name).trim() : undefined,
      baseUrl: req.body?.baseUrl ? String(req.body.baseUrl).trim() : undefined,
      model: req.body?.model ? String(req.body.model).trim() : undefined,
      apiKey: req.body?.apiKey ? String(req.body.apiKey).trim() : current.apiKey,
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      isDefault: typeof req.body?.isDefault === 'boolean' ? req.body.isDefault : undefined,
    });
    res.json({ model: model ? publicModel(model) : null });
  });

  router.delete('/admin/models/:id', requireAdmin, async (req: Request, res: Response) => {
    await getDb().deleteModelConfig(routeId(req));
    res.json({ ok: true });
  });

  router.post('/admin/models/:id/test', requireAdmin, async (req: Request, res: Response) => {
    const model = await getDb().getModelConfig(routeId(req));
    if (!model) {
      res.status(404).json({ error: 'Model config not found' });
      return;
    }
    const checks = {
      enabled: model.enabled,
      hasBaseUrl: Boolean(model.baseUrl),
      hasModel: Boolean(model.model),
      hasApiKey: Boolean(model.apiKey),
    };
    res.json({
      ok: Object.values(checks).every(Boolean),
      checks,
      message: Object.values(checks).every(Boolean)
        ? 'Model configuration is complete. Live provider calls are not executed by this dry-run test.'
        : 'Model configuration is incomplete.',
    });
  });

  router.get('/admin/usage/summary', requireAdmin, async (_req: Request, res: Response) => {
    res.json(await getDb().getUsageSummary());
  });

  return router;
}

async function getAccessibleVaults(user: User) {
  const vaults = await getDb().listVaults({ enabledOnly: user.role !== 'admin' });
  if (user.role === 'admin') return vaults;
  const allowed = new Set(await getDb().getUserVaultIds(user.id));
  return vaults.filter(vault => allowed.has(vault.id));
}

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicModel(model: ModelConfig) {
  return {
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    model: model.model,
    enabled: model.enabled,
    isDefault: model.isDefault,
    hasApiKey: Boolean(model.apiKey),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function normalizeIdList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map(id => String(id)).filter(Boolean)
    : [];
}

function routeId(req: Request): string {
  return String(req.params.id);
}

async function syncVaultManager(vaultManager?: VaultGraphManager): Promise<void> {
  if (!vaultManager) return;
  await vaultManager.sync(await getDb().listVaults({ enabledOnly: true }));
}
