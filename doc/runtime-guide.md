# 前后端启动与运维说明

本文档说明 `team-wiki-server` 后端和 `team-wiki-react-ui` 前端的本地启动方式、常用脚本、数据库初始化脚本和注意事项。

## 目录结构

```text
team-wiki/
├─ team-wiki-server/       # 后端：Express + OpenAI Agents + SQLite/PostgreSQL
├─ team-wiki-react-ui/     # 前端：React + Vite + TypeScript + Tailwind
├─ team-wiki-vue-ui/       # 旧 Vue 前端，当前要求保留不动
└─ doc/                    # 项目文档
```

## 运行要求

- 后端要求 Node.js `>= 22.5.0`。
- 如果系统 Node 版本较低，可以使用 Codex runtime 内置 Node：

```powershell
C:\Users\79809\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
```

- 前端使用 Vite，普通 Node 18+ 通常可以运行。
- 后端默认端口：`3100`
- React 前端默认端口：`3202`

## 后端配置

后端通过 `ENV_FILE` 指定环境变量文件：

- SQLite：`team-wiki-server/.env.sqlite`
- PostgreSQL：`team-wiki-server/.env.postgres`

常用环境变量：

```env
VAULT_PATH=D:\path\to\obsidian-vault
PORT=3100

AI_API_KEY=your_api_key
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-v4-flash

JWT_SECRET=your_jwt_secret

DB_PROVIDER=sqlite
DB_PATH=./data/chat.sqlite

# PostgreSQL 模式使用：
# DB_PROVIDER=postgres
# DATABASE_URL=postgresql://user:password@host:5432/db
# DB_SSL=false
# DB_POOL_MAX=20

MCP_ENABLED=true
WATCH_DEBOUNCE_MS=2000
IGNORE_DOTFILES=true
IGNORE_PATTERNS=.obsidian/**

INDEX_CONCURRENCY=10
MAX_TRAVERSAL_DEPTH=5
MAX_GRAPH_NODES=200

CORS_ORIGINS=http://localhost:3202
```

注意：不要把真实 `AI_API_KEY`、`DATABASE_URL`、`JWT_SECRET` 提交到公共仓库。

## 后端脚本

在 `team-wiki-server` 目录执行。

```powershell
cd D:\WorkSpace\LLM-Wiki\team-wiki\team-wiki-server
```

安装依赖：

```powershell
npm install
```

构建：

```powershell
npm run build
```

开发模式，SQLite：

```powershell
npm run dev:sqlite
```

开发模式，PostgreSQL：

```powershell
npm run dev:postgres
```

生产方式，先构建再启动 SQLite：

```powershell
npm run build
npm run start:sqlite
```

生产方式，先构建再启动 PostgreSQL：

```powershell
npm run build
npm run start:postgres
```

如果需要指定内置 Node 运行：

```powershell
$env:ENV_FILE='.env.sqlite'
& 'C:\Users\79809\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'dist\cli.js'
```

健康检查：

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3100/health
```

## PostgreSQL 全量初始化

全量重建脚本：

```text
team-wiki-server/sql/full.postgres.sql
```

该脚本会先删除应用相关表，再重新创建完整结构和索引。适合新库初始化或需要重置库结构时执行。

执行示例：

```powershell
psql "$env:DATABASE_URL" -f .\team-wiki-server\sql\full.postgres.sql
```

或在后端目录：

```powershell
cd D:\WorkSpace\LLM-Wiki\team-wiki\team-wiki-server
psql "$env:DATABASE_URL" -f .\sql\full.postgres.sql
```

注意：

- `full.postgres.sql` 会清空业务表，请确认目标库可以重置。
- PostgreSQL 模式下后端启动前，需要确认 `.env.postgres` 中 `DATABASE_URL`、`DB_SSL`、`DB_POOL_MAX` 配置正确。
- 后端仍会在启动时执行兼容性的 `CREATE TABLE IF NOT EXISTS` 和必要 `ALTER TABLE`，但全量脚本更适合从空库或重置后开始。

## 前端配置与启动

React 前端目录：

```powershell
cd D:\WorkSpace\LLM-Wiki\team-wiki\team-wiki-react-ui
```

安装依赖：

```powershell
npm install
```

开发启动：

```powershell
npm run dev
```

默认访问：

```text
http://localhost:3202/
```

构建：

```powershell
npm run build
```

预览构建产物：

```powershell
npm run preview
```

前端本地开发会通过 Vite 代理访问后端 API。启动前请确保后端 `http://localhost:3100` 已经可用。

## 默认账号

本地开发默认管理员账号由后端初始化逻辑创建：

```text
username: admin
password: admin123
```

上线或共享环境请及时修改默认密码。

## 常见启动顺序

SQLite 本地开发：

```powershell
cd D:\WorkSpace\LLM-Wiki\team-wiki\team-wiki-server
npm run dev:sqlite

cd D:\WorkSpace\LLM-Wiki\team-wiki\team-wiki-react-ui
npm run dev
```

PostgreSQL 本地/测试环境：

```powershell
cd D:\WorkSpace\LLM-Wiki\team-wiki
psql "$env:DATABASE_URL" -f .\team-wiki-server\sql\full.postgres.sql

cd .\team-wiki-server
npm run dev:postgres

cd ..\team-wiki-react-ui
npm run dev
```

## 注意事项

- `team-wiki-vue-ui` 是旧前端，当前开发方向是 `team-wiki-react-ui`，不要修改旧 Vue 前端。
- `team-kb-qa-ui` 已废弃并删除。
- 后端启动时会索引所有启用的知识库，知识库文件多时启动会稍慢。
- 新增或修改知识库路径后，需要在管理页面触发重建索引，或重启后端。
- 聊天会话按用户隔离，前端只展示当前登录用户的会话。
- 多知识库问答会使用并行 sub agent 收集线索，再由综合 agent 生成最终答案。
- 管理员可以在 Settings 页面查看并修改当前生效的系统提示词；基础提示词存储在数据库 `app_settings` 表中。
- 如果端口被占用：
  - 后端默认 `3100`
  - React 前端默认 `3202`
  - 旧临时前端曾使用 `3201`，如残留进程可手动停止。
