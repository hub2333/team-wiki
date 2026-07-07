import { getDb } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { hashPassword } from '../auth/password.js';

export async function bootstrapProductData(config: AppConfig): Promise<void> {
  const db = getDb();

  let users = await db.listUsers();
  if (users.length === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    await db.createUser({
      username,
      displayName: 'Administrator',
      role: 'admin',
      status: 'active',
      passwordHash: hashPassword(password),
    });
    users = await db.listUsers();
  }

  let vaults = await db.listVaults();
  if (vaults.length === 0) {
    await db.createVault({
      name: 'Default Vault',
      path: config.vaultPath,
      enabled: true,
      metadata: { source: 'env' },
    });
    vaults = await db.listVaults();
  }

  const adminUsers = users.filter(user => user.role === 'admin');
  for (const admin of adminUsers) {
    await db.setUserVaults(admin.id, vaults.map(vault => vault.id));
  }

  const models = await db.listModelConfigs();
  if (models.length === 0) {
    await db.createModelConfig({
      name: 'Default Model',
      baseUrl: config.aiBaseUrl,
      model: config.aiModel,
      apiKey: config.aiApiKey,
      enabled: Boolean(config.aiApiKey),
      isDefault: true,
    });
  }
}
