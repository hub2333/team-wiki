# REST API 接入

本文档面向需要直接对接 `team-wiki` 后端接口的应用、脚本和服务。

## 基础信息

- Base URL：`http://localhost:3100`
- 接口前缀：`/api`
- 聊天接口：`SSE`
- 内容类型：
  - 普通 JSON：`application/json`
  - SSE：`text/event-stream`

## 认证

如果后端没有配置 `AUTH_TOKEN` 和 `JWT_SECRET`，则接口默认匿名可访问。

如果配置了认证，所有 `/api/*` 接口都需要：

```http
Authorization: Bearer <token>
```

支持两种令牌：

1. 静态 Bearer Token
2. JWT

JWT 场景下，后端会优先读取：

- `sub`
- `userId`

作为当前用户标识。会话列表、消息读取、删除都按当前用户隔离。

## 1. 获取会话列表

`GET /api/sessions`

### 请求示例

```bash
curl http://localhost:3100/api/sessions
```

带认证：

```bash
curl http://localhost:3100/api/sessions \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 响应示例

```json
{
  "sessions": [
    {
      "id": "d4f0b3a5-xxxx",
      "userId": "anonymous",
      "title": "介绍一下项目架构",
      "createdAt": 1751730000000,
      "updatedAt": 1751730023456,
      "metadata": {}
    }
  ]
}
```

## 2. 获取单个会话消息

`GET /api/sessions/:id`

### 请求示例

```bash
curl http://localhost:3100/api/sessions/SESSION_ID
```

### 响应示例

```json
{
  "session": {
    "id": "SESSION_ID",
    "userId": "anonymous",
    "title": "介绍一下项目架构",
    "createdAt": 1751730000000,
    "updatedAt": 1751730023456,
    "metadata": {}
  },
  "messages": [
    {
      "id": 1,
      "sessionId": "SESSION_ID",
      "role": "user",
      "content": "介绍一下项目架构",
      "createdAt": 1751730001000
    },
    {
      "id": 2,
      "sessionId": "SESSION_ID",
      "role": "assistant",
      "content": "这是一个基于 Obsidian 的团队知识服务。",
      "toolCalls": "[{\"tool\":\"search\",\"args\":{\"query\":\"架构\"}}]",
      "createdAt": 1751730023000
    }
  ]
}
```

如果会话不存在，或不属于当前用户：

```json
{
  "error": "Session not found"
}
```

## 3. 删除会话

`DELETE /api/sessions/:id`

### 请求示例

```bash
curl -X DELETE http://localhost:3100/api/sessions/SESSION_ID
```

### 响应示例

```json
{
  "ok": true
}
```

## 4. 发起聊天

`POST /api/chat`

这是一个 `SSE` 接口，不是普通一次性 JSON 返回。

### 请求体

```json
{
  "message": "介绍一下项目架构",
  "sessionId": "可选，继续已有会话时传入"
}
```

### 请求示例

```bash
curl -N http://localhost:3100/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"介绍一下项目架构\"}"
```

继续已有会话：

```bash
curl -N http://localhost:3100/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"继续展开数据库方案\",\"sessionId\":\"SESSION_ID\"}"
```

带认证：

```bash
curl -N http://localhost:3100/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d "{\"message\":\"介绍一下项目架构\"}"
```

## SSE 事件格式

服务端会持续推送如下事件：

### `text`

模型正文增量。

```text
event: text
data: {"content":"这是"}
```

### `thought`

推理片段。

```text
event: thought
data: {"content":"先查看相关节点"}
```

### `tool_start`

工具开始执行。

```text
event: tool_start
data: {"tool":"search","args":{"query":"项目架构"},"index":0}
```

### `tool_end`

工具执行完成。

```text
event: tool_end
data: {"tool":"search","result":"...","durationMs":18}
```

### `done`

本轮结束。

```text
event: done
data: {"sessionId":"SESSION_ID","usage":{"elapsedMs":1200}}
```

### `error`

服务端异常。

```text
event: error
data: {"message":"Invalid or expired token"}
```

## `done` 事件里的 usage

当前包含的主要字段：

- `elapsedMs`
- `inputChars`
- `outputChars`
- `estimatedInputTokens`
- `estimatedOutputTokens`
- `estimatedTotalTokens`

这些 token 是估算值，不是模型官方结算值。

## Node.js 接入示例

```js
const response = await fetch("http://localhost:3100/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer YOUR_TOKEN"
  },
  body: JSON.stringify({
    message: "介绍一下项目架构"
  })
});

if (!response.ok) {
  throw new Error(await response.text());
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() || "";

  for (const part of parts) {
    const lines = part.split("\n");
    const eventLine = lines.find(line => line.startsWith("event: "));
    const dataLine = lines.find(line => line.startsWith("data: "));
    if (!eventLine || !dataLine) continue;

    const event = eventLine.slice(7);
    const data = JSON.parse(dataLine.slice(6));
    console.log(event, data);
  }
}
```

## 错误码

常见情况：

- `400`：请求参数不合法，例如 `message` 为空
- `401`：缺少认证头，或 Token/JWT 无效
- `404`：会话不存在，或无权限访问该会话
- `500`：服务端内部异常

## 接入建议

1. 首次提问不传 `sessionId`
2. 从 `done.sessionId` 里取回会话 ID
3. 继续追问时带上同一个 `sessionId`
4. 前端或调用方自己把 SSE 增量流拼接成最终答案
5. 如果要多用户隔离，务必启用 `AUTH_TOKEN` 或 `JWT_SECRET`
