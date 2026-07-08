# MCP 接入

本文档面向需要把 `team-wiki` 作为 `MCP Server` 接入到 Cursor、Claude Desktop 或自研 Agent 平台的场景。

## 基础信息

服务默认地址：

- `http://localhost:3100/mcp`

兼容旧协议的地址：

- `GET /sse`
- `POST /messages?sessionId=...`

推荐优先使用现代 Streamable HTTP 方式，也就是 `/mcp`。

## 认证

MCP 与 REST API 共用同一套认证逻辑。

如果服务端配置了 `AUTH_TOKEN` 或 `JWT_SECRET`，MCP 请求同样需要：

```http
Authorization: Bearer <token>
```

未配置认证时，可匿名访问。

## 支持的传输方式

### 1. Streamable HTTP

推荐。

- `POST /mcp`
- `DELETE /mcp`

用途：

- 初始化
- 工具调用
- 会话复用
- 会话关闭

### 2. Legacy SSE

兼容旧客户端。

- `GET /sse`
- `GET /mcp` 也兼容 SSE 连接
- `POST /messages?sessionId=...`

如果你的客户端已经支持新版 MCP，就不要再优先走这套老协议。

## 推荐配置示例

### Cursor / 通用 MCP 客户端

```json
{
  "mcpServers": {
    "teamwiki": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

如果需要认证，可以按你的客户端支持方式补充认证头。不同客户端写法不完全一样，核心要求只有一个：

```http
Authorization: Bearer YOUR_TOKEN
```

## MCP 暴露的工具

当前服务暴露 13 个工具：

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

## 工具说明

### `search`

全文搜索。

参数：

```json
{
  "query": "知识图谱",
  "limit": 10
}
```

### `search_by_tags`

按标签搜索。

参数：

```json
{
  "tags": ["team", "backend"],
  "mode": "or",
  "limit": 20
}
```

### `read_note`

读取完整笔记内容。

参数：

```json
{
  "path": "projects/architecture.md"
}
```

### `get_forwardlinks`

读取一个笔记的出链。

### `get_backlinks`

读取一个笔记的反链。

### `get_neighbors`

同时拿到前向和反向关联。

### `traverse_graph`

按图遍历知识节点。

参数：

```json
{
  "start": "index.md",
  "depth": 2,
  "direction": "both",
  "max_nodes": 100
}
```

### `shortest_path`

查两个节点之间的最短路径。

参数：

```json
{
  "from": "index.md",
  "to": "projects/architecture.md"
}
```

### `get_graph_stats`

查看图谱统计信息。

### `list_notes`

列出笔记，可按文件夹过滤。

参数：

```json
{
  "folder": "projects/",
  "limit": 100
}
```

### `get_tags`

列出标签及计数。

### `get_tag_hierarchy`

列出标签层级。

### `get_index_status`

查看索引状态。

## 接入行为说明

### 1. 索引来源

MCP 工具读取的是后端已经加载完成的 `KnowledgeGraph`，不是临时扫描磁盘。

这意味着：

- 首次启动时会先构建索引
- 运行中会监听文件变化并做增量更新
- 工具调用可以直接复用内存态图谱

### 2. 工具返回

MCP 工具大多返回 `text` 类型内容，内容本身通常是 JSON 字符串。

也就是说，客户端在展示或消费时，最好再做一次 JSON 解析。

### 3. 鉴权与多用户

如果启用了：

- `AUTH_TOKEN`
- `JWT_SECRET`

那么 MCP 和 REST 一样，都受保护。

不过 MCP 工具当前访问的是知识图谱，不涉及按用户拆分的会话列表；用户隔离主要体现在 REST Chat/Session 侧。

## 调试建议

### 1. 先检查健康状态

```bash
curl http://localhost:3100/health
```

正常返回类似：

```json
{
  "status": "ok",
  "files": 592
}
```

### 2. 再检查 MCP 地址

确认：

- 服务是否已启动
- `MCP_ENABLED` 是否为 `true`
- 认证头是否正确

### 3. 如果工具结果为空

重点检查：

- `VAULT_PATH` 是否正确
- 首次索引是否完成
- 查询参数里的 `path`、`tag`、`folder` 是否和实际仓库一致

## 配置建议

### 本地快速测试

推荐：

- `DB_PROVIDER=sqlite`
- `ENV_FILE=.env.sqlite`

### 团队长期运行

推荐：

- `DB_PROVIDER=postgres`
- `ENV_FILE=.env.postgres`

虽然 MCP 本身不依赖数据库图谱查询，但聊天会话、Web UI、多轮上下文都依赖会话存储，所以生产环境仍建议切 PostgreSQL。
