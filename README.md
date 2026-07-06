# Team Wiki

`Team Wiki` 把 Obsidian 风格的 Markdown 知识库，包装成一个可供团队直接使用的知识服务：

- `Web UI`：浏览器里直接聊天问答
- `REST API`：给自研应用或自动化流程调用
- `MCP Server`：给 Cursor、Claude Desktop 等 Agent 客户端接入

项目核心思路是：

1. 用 `KnowledgeGraph` 持续索引 Obsidian 仓库
2. Agent 直接调用进程内工具，不额外绕 MCP HTTP
3. 会话层支持两套数据库后端
   - `SQLite (node:sqlite)`：本地测试、快速试跑、小团队
   - `PostgreSQL`：50 人以上、长期稳定使用

## 这次调整后的重点

- 去掉了 `better-sqlite3`，改为 Node 内置的 `node:sqlite`
- 后端支持通过不同配置文件切换 `sqlite / postgres`
- 补充了建表 SQL：`team-wiki-server/sql/`
- 根目录启动脚本默认走本地 SQLite
- Web UI 支持填写 `Bearer Token / JWT`
- API / MCP 统一走同一套认证逻辑
- 聊天会话改为真实多轮，上下文会带入历史消息

## 运行要求

- Node.js `22.5+`
- 推荐直接使用 Node `24 LTS`
- `Node 20` 不支持当前这套 `node:sqlite` 方案
- 一个 Obsidian/Markdown 知识库目录
- 一个兼容 OpenAI 接口的模型 Key（默认示例用 DeepSeek）

先确认版本：

```bash
node -v
```

## 项目结构

```text
team-wiki/
├── README.md
├── doc/
│   ├── README.md
│   ├── rest-api.md
│   ├── mcp.md
│   └── system-prompt.md
├── scripts/
│   ├── build.sh
│   ├── dev.sh
│   ├── start.sh
│   ├── start-server.sh
│   ├── start-ui.sh
│   ├── build.ps1
│   ├── dev.ps1
│   ├── start.ps1
│   ├── start-server.ps1
│   └── start-ui.ps1
├── team-wiki-server/
│   ├── package.json
│   ├── .env.example
│   ├── .env.sqlite.example
│   ├── .env.postgres.example
│   ├── sql/
│   │   ├── schema.sqlite.sql
│   │   └── schema.postgres.sql
│   ├── src/
│   │   ├── app.ts
│   │   ├── cli.ts
│   │   ├── config.ts
│   │   ├── auth/
│   │   ├── agent/
│   │   ├── chat/
│   │   ├── db/
│   │   ├── graph/
│   │   ├── mcp/
│   │   ├── parser/
│   │   ├── utils/
│   │   └── watcher/
│   └── test-vault/
└── team-wiki-vue-ui/
    ├── package.json
    ├── vite.config.js
    └── src/
```

## 架构概览

```text
Obsidian Vault
   -> watcher(chokidar)
   -> KnowledgeGraph
   -> Agent tools / REST API / MCP Server
   -> Web UI (SSE chat)
```

关键点：

- 索引支持 `wikilinks / tags / frontmatter`
- 文件变更走增量更新
- Chat 返回 `SSE`
- Agent 工具直接调用知识图谱
- 会话存储可切换 `SQLite` 或 `PostgreSQL`

## 快速开始

### 1. 安装依赖

```bash
cd team-wiki/team-wiki-server
npm install

cd ../team-wiki-vue-ui
npm install
```

### 2. 选择数据库配置

#### 方案 A：SQLite

适合：

- 本地开发
- 快速验证
- 很小团队
- 单机部署

复制配置模板：

```powershell
cd team-wiki\team-wiki-server
Copy-Item .env.sqlite.example .env.sqlite
```

或：

```bash
cd team-wiki/team-wiki-server
cp .env.sqlite.example .env.sqlite
```

至少修改这几个值：

```ini
VAULT_PATH=D:\path\to\obsidian
AI_API_KEY=sk-your-key
DB_PROVIDER=sqlite
DB_PATH=./data/chat.sqlite
```

默认本地库文件会落在：

```text
team-wiki-server/data/chat.sqlite
```

#### 方案 B：PostgreSQL

适合：

- 50 人以上团队日常使用
- 需要更稳定的并发与备份能力
- 计划长期作为团队共享知识服务

复制配置模板：

```powershell
cd team-wiki\team-wiki-server
Copy-Item .env.postgres.example .env.postgres
```

或：

```bash
cd team-wiki/team-wiki-server
cp .env.postgres.example .env.postgres
```

至少修改这几个值：

```ini
VAULT_PATH=D:\path\to\obsidian
AI_API_KEY=sk-your-key
DB_PROVIDER=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/teamwiki
```

## 启动方式

### 方式 1：直接用后端 npm 脚本

#### SQLite

PowerShell:

```powershell
cd team-wiki\team-wiki-server
$env:ENV_FILE = ".env.sqlite"
npm run dev
```

```powershell
cd team-wiki\team-wiki-server
$env:ENV_FILE = ".env.sqlite"
npm run start
```

Bash:

```bash
cd team-wiki/team-wiki-server
ENV_FILE=.env.sqlite npm run dev
```

```bash
cd team-wiki/team-wiki-server
ENV_FILE=.env.sqlite npm run start
```

#### PostgreSQL

PowerShell:

```powershell
cd team-wiki\team-wiki-server
$env:ENV_FILE = ".env.postgres"
npm run dev
```

Bash:

```bash
cd team-wiki/team-wiki-server
ENV_FILE=.env.postgres npm run dev
```

也可以继续使用显式脚本：

```bash
npm run dev:sqlite
npm run dev:postgres
npm run start:sqlite
npm run start:postgres
```

### 方式 2：使用根目录快捷脚本

默认使用 `.env.sqlite`。

#### Windows PowerShell

```powershell
cd team-wiki
.\scripts\dev.ps1
.\scripts\start.ps1
.\scripts\start-server.ps1
.\scripts\start-ui.ps1
```

切换 PostgreSQL：

```powershell
$env:ENV_FILE_NAME = ".env.postgres"
.\scripts\dev.ps1
```

#### Bash

```bash
cd team-wiki
bash scripts/dev.sh
bash scripts/start.sh
bash scripts/start-server.sh
bash scripts/start-ui.sh
```

切换 PostgreSQL：

```bash
cd team-wiki
ENV_FILE_NAME=.env.postgres bash scripts/dev.sh
```

### 方式 3：前后端分开启动

后端：

```powershell
cd team-wiki\team-wiki-server
$env:ENV_FILE = ".env.sqlite"
npm run dev
```

前端：

```powershell
cd team-wiki\team-wiki-vue-ui
npm run dev
```

## 访问地址

默认端口：

| 服务 | 地址 |
|------|------|
| Web UI | `http://localhost:3101` |
| Chat API | `POST http://localhost:3100/api/chat` |
| Session API | `http://localhost:3100/api/sessions` |
| MCP | `http://localhost:3100/mcp` |
| Legacy SSE MCP | `http://localhost:3100/sse` |
| Health | `http://localhost:3100/health` |

## 数据库切换策略

### 推荐选择

| 场景 | 推荐 |
|------|------|
| 本地测试 / POC / 少量用户 | `SQLite` |
| 小团队临时共享 | `SQLite` |
| 50+ 人日常使用 | `PostgreSQL` |
| 需要标准备份、连接池、独立运维 | `PostgreSQL` |

### 当前实现说明

- `SQLite` 使用 `node:sqlite`
- `PostgreSQL` 使用 `pg`
- 两者共用同一套会话抽象：`team-wiki-server/src/db/`
- 配置切换主要靠 `ENV_FILE`

## 配置文件说明

后端支持三种方式选择配置文件：

1. 默认读取 `.env`
2. 设置环境变量 `ENV_FILE`
3. 启动参数传入 `--env-file`

例如：

```bash
ENV_FILE=.env.sqlite npm run dev
```

```bash
npm run dev -- --env-file .env.postgres
```

### 常用配置项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VAULT_PATH` | Obsidian 知识库路径 | `./vault` |
| `PORT` | 后端端口 | `3100` |
| `AI_API_KEY` | 模型服务 Key | - |
| `AI_BASE_URL` | 模型服务地址 | `https://api.deepseek.com/v1` |
| `AI_MODEL` | 模型名 | `deepseek-v4-flash` |
| `AUTH_TOKEN` | Bearer Token | 空 |
| `JWT_SECRET` | JWT 密钥 | 空 |
| `DB_PROVIDER` | `sqlite` 或 `postgres` | `sqlite` |
| `DB_PATH` | SQLite 文件路径 | `./data/chat.sqlite` |
| `DATABASE_URL` | PostgreSQL 连接串 | 空 |
| `DB_SSL` | PostgreSQL 是否启用 SSL | `false` |
| `DB_POOL_MAX` | PostgreSQL 连接池大小 | `20` |
| `MCP_ENABLED` | 是否启用 MCP | `true` |
| `WATCH_DEBOUNCE_MS` | 文件监听防抖 | `2000` |
| `INDEX_CONCURRENCY` | 索引并发度 | `10` |
| `CORS_ORIGINS` | 允许跨域来源 | `http://localhost:3101` |

## 建表 SQL

项目里已经补了两份 SQL：

- [schema.sqlite.sql](./team-wiki-server/sql/schema.sqlite.sql)
- [schema.postgres.sql](./team-wiki-server/sql/schema.postgres.sql)

接入文档见：

- [REST API 接入](./doc/rest-api.md)
- [MCP 接入](./doc/mcp.md)
- [System Prompt 机制与使用](./doc/system-prompt.md)

说明：

- 服务启动时会自动初始化缺失表
- SQL 文件主要用于手工初始化、DBA 审阅、或外部迁移接入

手工执行 PostgreSQL 初始化示例：

```bash
psql "$DATABASE_URL" -f team-wiki-server/sql/schema.postgres.sql
```

## Web UI

`team-wiki-vue-ui` 当前主要提供：

- 会话列表
- 新建 / 切换 / 删除会话
- SSE 流式对话
- 工具调用过程展示
- Markdown 渲染
- 侧边栏填写 `Bearer Token / JWT`

如果配置了认证：

- API 和 MCP 走同一套认证校验
- 会话列表和消息读取会按当前用户隔离

## Chat API

`POST /api/chat` 返回 `SSE` 流。

主要事件：

| 事件 | 说明 |
|------|------|
| `text` | 文本增量输出 |
| `thought` | 推理过程片段 |
| `tool_start` | 工具开始调用 |
| `tool_end` | 工具调用完成 |
| `done` | 本轮结束，带 usage |
| `error` | 异常信息 |

## MCP 接入

当前同时支持两套 MCP 方式：

- 现代模式：`/mcp`
- 兼容旧客户端：`/sse` + `/messages`

更推荐优先接 `/mcp`。

示例：

```json
{
  "mcpServers": {
    "teamwiki": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

## Agent 工具

当前内置 13 个知识工具：

- `search`
- `search_by_tags`
- `read_note`
- `get_forwardlinks`
- `get_backlinks`
- `get_neighbors`
- `traverse_graph`
- `shortest_path`
- `get_graph_stats`
- `list_notes`
- `get_tags`
- `get_tag_hierarchy`
- `get_index_status`

## 技术栈

| 模块 | 技术 |
|------|------|
| 后端 | Node.js + TypeScript + Express |
| 前端 | Vue 3 + Vite + Element Plus |
| Agent | `@openai/agents` |
| MCP | `@modelcontextprotocol/sdk` |
| 全文搜索 | `MiniSearch` |
| Markdown 解析 | `remark` + `gray-matter` |
| 文件监听 | `chokidar` |
| 配置加载 | `dotenv` |
| 数据校验 | `zod` |

## 常见建议

### 1. 本地试跑优先用 SQLite

这是当前默认路径，依赖最少，也最符合现在这套 README 和脚本设计。

### 2. 团队人数上来后切 PostgreSQL

当你开始关心并发、备份、独立数据库运维，直接切到 `.env.postgres` 更稳。

### 3. Windows 下如果刚升级 Node

如果 `node -v` 还显示旧版本，通常是终端还没刷新环境变量。重开终端后再执行一次。

## 构建

后端构建：

```bash
cd team-wiki/team-wiki-server
npm run build
```

前端构建：

```bash
cd team-wiki/team-wiki-vue-ui
npm run build
```

根目录快捷构建：

```bash
cd team-wiki
bash scripts/build.sh
```

或：

```powershell
cd team-wiki
.\scripts\build.ps1
```
