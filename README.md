# Team Wiki

Karpathy 的 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) + Obsidian 双链笔记是优秀的个人知识管理实践，但公开给团队使用并不方便。

本项目解决这个问题：将已生成的 LLM Wiki 文档路径 + DeepSeek key 配置好，完成前后端部署即可获得：

- **Web Chat 页面** — 浏览器直接对话
- **MCP 协议** — 对接市面成熟 Agent 产品（Claude Desktop、Cursor 等）
- **REST API** — 自研 Agent 产品集成调用

## 架构

```
┌─────────────────────────────────────────────┐
│          Obsidian Markdown 知识库             │
│  (581 文件 / wikilinks / tags / frontmatter) │
└──────────────────┬──────────────────────────┘
                   │ chokidar 监听 + 增量更新
                   ▼
┌─────────────────────────────────────────────┐
│          KnowledgeGraph (内存索引)             │
│  ├─ resolvedLinks / unresolvedLinks / backlinks
│  ├─ tagIndex / MiniSearch 全文搜索            │
│  └─ 增量更新 (2s 防抖合并)                    │
└────────┬────────────┬────────────┬───────────┘
         │            │            │
    ┌────▼───┐   ┌───▼────┐   ┌──▼────┐
    │ Agent  │   │  MCP   │   │ REST  │
    │ Chat   │   │ 协议   │   │  API  │
    │(进程内 │   │(外部AI │   │       │
    │ 13工具)│   │ 工具)  │   │       │
    └────┬───┘   └────────┘   └───────┘
         │ SSE stream
    ┌────▼──────┐
    │  Web UI   │
    │ Vue 3     │
    │ Element+  │
    └───────────┘
```

**关键变更**：Agent 内部使用**直接函数工具**调用知识图谱，不走 MCP HTTP 层（避免延迟和会话管理问题）。MCP 服务器保留给外部工具使用（Claude Desktop、Cursor 等）。

## 目录结构

```
teamwiki/
├── team-wiki-server/               # 后端 (Node.js + TypeScript)
│   ├── src/
│   │   ├── app.ts                   Express 入口 + 启动流程
│   │   ├── config.ts                .env 配置加载
│   │   ├── cli.ts                   CLI 入口
│   │   ├── agent/
│   │   │   ├── index.ts             Agent 工厂 (13 个直接函数工具)
│   │   │   ├── tools.ts             直接函数工具定义
│   │   │   └── prompts.ts           系统提示词
│   │   ├── chat/
│   │   │   └── index.ts             POST /api/chat SSE 流式接口
│   │   ├── graph/
│   │   │   ├── index.ts             知识图谱 (MetadataCache 实现)
│   │   │   ├── search.ts            MiniSearch 全文搜索
│   │   │   └── resolver.ts          Wikilink 解析器
│   │   ├── mcp/
│   │   │   └── index.ts             MCP 服务器 (Streamable HTTP + SSE)
│   │   ├── parser/
│   │   │   └── index.ts             Markdown 解析 (frontmatter/wikilinks/tags)
│   │   ├── db/
│   │   │   ├── index.ts             SQLite 初始化
│   │   │   └── sessions.ts          会话 CRUD
│   │   ├── auth/
│   │   │   └── index.ts             认证中间件 (Bearer / JWT)
│   │   ├── watcher/
│   │   │   └── index.ts             文件监听 (chokidar + 增量更新)
│   │   └── utils/
│   │       └── logger.ts            结构化日志工具
│   ├── .env.example                 配置模板
│   ├── test-vault/                  测试知识库 (5 篇示例 Markdown)
│   └── package.json
│
├── team-wiki-vue-ui/               # 前端 (Vue 3 + Vite + Element Plus)
│   ├── src/
│   │   ├── views/
│   │   │   └── ChatView.vue         聊天页面 (会话管理 / SSE / Markdown 渲染)
│   │   ├── App.vue                  根组件
│   │   └── main.js                  Vue 入口 + Element Plus 注册
│   ├── vite.config.js               Vite 配置 (/api 代理到 :3100)
│   ├── index.html
│   └── package.json
│
└── scripts/                        # 便捷脚本
    ├── dev.sh                       开发模式 (端口检测 + 自动启动)
    ├── start.sh                     生产模式
    ├── build.sh                     构建前后端
    ├── start-server.sh              仅启动后端
    └── start-ui.sh                  仅启动前端
```

## 快速启动

### 前置要求

- Node.js 20+
- DeepSeek 或 OpenAI API Key
- Markdown 格式的 Obsidian 知识库

### 1. 克隆

```bash
git clone git@github.com:hub2333/teamwiki.git
cd teamwiki
```

### 2. 安装依赖

```bash
cd team-wiki-server && npm install && cd ..
cd team-wiki-vue-ui && npm install && cd ..
```

### 3. 配置

```bash
cd team-wiki-server
cp .env.example .env
```

编辑 `.env`，必须配置：

```ini
VAULT_PATH=/path/to/your/obsidian-vault
AI_API_KEY=sk-your-deepseek-key
```

启动时自动通过 dotenv 加载 `.env`，无需手动 export。

### 4. 启动

**开发模式（热重载，推荐）：**

```bash
bash scripts/dev.sh
```

自动检测端口 → 清理旧进程 → 并行启动 server (tsx watch) + UI (Vite HMR)。

**手动分步启动：**

```bash
# 终端 1 — 后端
cd team-wiki-server && npm start

# 终端 2 — 前端
cd team-wiki-vue-ui && npm run dev
```

### 5. 访问

| 服务 | 地址 |
|------|------|
| Web UI | http://localhost:3101 |
| Chat API | POST http://localhost:3100/api/chat |
| MCP | http://localhost:3100/mcp |
| Health | http://localhost:3100/health |

## Web UI 功能

访问 http://localhost:3101 使用浏览器对话：

- **会话管理** — 新建/切换/删除/批量管理会话
- **流式对话** — SSE 实时展示 AI 思考过程、工具调用（含耗时）、文本输出
- **Markdown 渲染** — 代码高亮 (highlight.js)、表格、图片等
- **用量统计** — 每次回复显示总耗时和 Token 估算

## SSE 协议

`POST /api/chat` 返回 SSE 流，每次事件以 `\n\n` 分隔：

| 事件 | 数据 | 说明 |
|------|------|------|
| `text` | `{ content }` | AI 文本片段 delta |
| `thought` | `{ content }` | 推理过程 |
| `tool_start` | `{ tool, args, index }` | 工具调用开始 |
| `tool_end` | `{ tool, result, durationMs }` | 工具调用完成（含耗时） |
| `done` | `{ sessionId, usage }` | 结束，含耗时和 Token 估算 |
| `error` | `{ message }` | 错误 |

## Agent 工具

Agent 内置 13 个直接函数工具，进程内调用知识图谱：

| 工具 | 说明 |
|------|------|
| `search` | 全文搜索 |
| `search_by_tags` | 标签搜索 |
| `read_note` | 读取笔记 |
| `get_forwardlinks` | 出站链接 |
| `get_backlinks` | 入站反链 |
| `get_neighbors` | 全连接 |
| `traverse_graph` | BFS 图谱遍历 |
| `shortest_path` | 最短路径 |
| `get_graph_stats` | 图谱统计 |
| `list_notes` | 列出笔记 |
| `get_tags` | 标签列表 |
| `get_tag_hierarchy` | 标签层级树 |
| `get_index_status` | 索引状态 |

## MCP 协议（外部集成）

此服务可作为 MCP Server 接入 Claude Desktop、Cursor 等 AI 工具：

```json
{
  "mcpServers": {
    "teamwiki": {
      "url": "http://your-server:3100/sse"
    }
  }
}
```

支持两种传输协议：

- **Streamable HTTP** (`POST/DELETE /mcp`) — 现代协议
- **SSE** (`GET /sse` + `POST /messages`) — 传统协议

通过 `MCP_ENABLED=false` 可禁用 MCP 服务。

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:id` | 会话消息 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| POST | `/api/chat` | 流式聊天 |
| GET | `/health` | 健康检查 |

## 配置

所有配置通过 `.env` 文件设置：

### 必填

| 变量 | 说明 |
|------|------|
| `VAULT_PATH` | Obsidian 知识库目录路径 |
| `AI_API_KEY` | DeepSeek（默认）/ OpenAI API Key |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3100` | 服务端口 |
| `AI_BASE_URL` | `https://api.deepseek.com/v1` | API 地址 |
| `AI_MODEL` | `deepseek-v4-flash` | 模型名称 |
| `AUTH_TOKEN` | 空（无认证） | Bearer Token |
| `JWT_SECRET` | 空（无认证） | JWT 密钥 |
| `MCP_ENABLED` | `true` | 启用 MCP 协议 |
| `DB_PATH` | `./data/chat.db` | SQLite 路径 |
| `WATCH_DEBOUNCE_MS` | `2000` | 文件监听防抖 (ms) |
| `INDEX_CONCURRENCY` | `10` | 索引并发数 |
| `LOG_LEVEL` | `info` | 日志级别 (debug/info/warn/error) |

## 核心技术

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript (ES2022) |
| 前端 | Vue 3 + Vite + Element Plus |
| AI Agent | `@openai/agents` + DeepSeek |
| MCP 协议 | `@modelcontextprotocol/sdk` |
| 全文搜索 | MiniSearch |
| 会话存储 | SQLite (better-sqlite3) |
| 文件监听 | chokidar (增量更新) |
| Markdown 解析 | remark + gray-matter |
| 配置加载 | dotenv |
| 数据校验 | zod |

## 日志

使用结构化日志，格式：

```
HH:mm:ss.SSS [LEVEL] [模块] 消息
```

运行时日志示例：

```
06:59:20.338 [INFO] [App] start {"vault":"/mnt/e/wsl/my_project/obsidian","port":3100}
06:59:25.016 [INFO] [App] index_done {"files":581,"elapsedMs":4655}
06:55:10.044 [INFO] [Chat] Start userId=anonymous msg="介绍项目架构"
06:55:22.481 [INFO] [Chat] Done session=xxx elapsed=12437ms tokens=3551
```

通过 `LOG_LEVEL` 控制输出级别。
