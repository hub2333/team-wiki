# System Prompt 机制与使用

本文档说明 `team-wiki-server` 中 system prompt 的当前设计、生成时机、配置方式，以及实际使用建议。

## 目标

当前 system prompt 设计的目标是：

1. 给 Agent 一个稳定的通用知识库助手角色
2. 不把某个固定 vault 的目录结构写死在 prompt 里
3. 在服务启动后，基于当前 `VAULT_PATH` 的真实索引结果补充动态上下文
4. 支持后续通过配置覆盖默认 prompt

## 当前机制概览

system prompt 现在分成两层：

### 1. 通用兜底默认 prompt

代码位置：

- [team-wiki-server/src/agent/prompts.ts](/D:/WorkSpace/LLM-Wiki/team-wiki/team-wiki-server/src/agent/prompts.ts)

这里定义了一个通用的默认 base prompt：

- 面向通用 `LLM Wiki / Obsidian 双链知识库`
- 不依赖固定行业、固定目录、固定标签体系
- 要求核心论点标注来源
- 要求证据不足时明确说不确定
- 要求不要把 `search` 标题直接当结论

### 2. 启动时动态追加的 prompt

服务启动完成初始索引后，会根据当前图谱追加动态信息，例如：

- 当前索引文件数
- top-level folders 摘要
- 推荐检索策略

这些内容来自当前真实 `VAULT_PATH`，不是写死在代码里的某个 vault 模板。

## 什么时候生成

当前 system prompt 的生成时机是：

1. 服务启动
2. `VaultWatcher` 完成初始索引
3. 调用 `resolveKnowledgeAgentPrompt(...)`
4. 把最终 prompt 注入 chat router

关键代码位置：

- [team-wiki-server/src/app.ts](/D:/WorkSpace/LLM-Wiki/team-wiki/team-wiki-server/src/app.ts)
- [team-wiki-server/src/chat/index.ts](/D:/WorkSpace/LLM-Wiki/team-wiki/team-wiki-server/src/chat/index.ts)
- [team-wiki-server/src/agent/index.ts](/D:/WorkSpace/LLM-Wiki/team-wiki/team-wiki-server/src/agent/index.ts)

也就是说：

- **不是每次请求都重新拼 prompt**
- **而是在服务启动后生成一次，并在后续 chat 请求里复用**

## 当前优先级

当前 prompt 解析优先级是：

1. `AGENT_SYSTEM_PROMPT_FILE`
2. `AGENT_SYSTEM_PROMPT`
3. 内置默认 prompt `DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT`

然后无论用哪一个 base prompt，系统都会再拼上“当前 vault 的动态上下文”。

## 配置方式

### 方式 1：不配置，直接使用默认 prompt

什么都不加，服务会走：

- 默认通用 base prompt
- 启动后动态补充当前 vault 结构

适合：

- 大多数默认部署
- 还没确定知识库领域
- 多个不同 `VAULT_PATH` 轮换使用

### 方式 2：直接写环境变量

在后端 `.env` 文件中加入：

```ini
AGENT_SYSTEM_PROMPT=你是一个面向企业知识库的中文助手。回答必须给出来源。
```

适合：

- 只想做少量补充
- 需要快速试验 prompt

注意：

- 这里写的是 **base prompt**
- 运行时仍然会自动追加当前 vault 的动态信息

### 方式 3：使用 prompt 文件

在 `.env` 文件中加入：

```ini
AGENT_SYSTEM_PROMPT_FILE=./prompts/system-prompt.txt
```

示例：

```ini
VAULT_PATH=D:\WorkSpace\LLM-Wiki\obsidian
AI_API_KEY=sk-xxx
AGENT_SYSTEM_PROMPT_FILE=./prompts/system-prompt.txt
```

适合：

- prompt 较长
- 需要版本化管理
- 需要多人协作修改

## 推荐写法

推荐把自定义 prompt 只写“稳定行为约束”，不要把 vault 目录结构写进去。

例如：

```text
你是一个中文知识库助手。
回答时优先给结论，再给证据。
核心论点必须带来源路径。
如果信息来自归档、待复核或推断内容，要明确提醒。
不要编造不存在的接口、页面或流程。
```

不推荐这样写：

```text
知识库固定包含 10-业务模块实现、20-核心流程链路、30-接口数据权限...
```

因为项目本身支持切换 `VAULT_PATH`，这种写法会很快漂掉。

## 当前行为边界

### 1. 运行中不自动热刷新 prompt

当前实现里：

- 文件索引会增量更新
- 但 system prompt 本身不会随 watcher 自动重建

这意味着：

- 如果只是文档内容变了，Agent 通过工具读取到的新内容仍然有效
- 如果 vault 结构变化很大，动态 prompt 里的目录摘要不会自动刷新

这类场景下，需要重启服务。

### 2. prompt 是 chat 侧使用

当前 system prompt 主要作用于：

- `POST /api/chat`

MCP 工具本身并不依赖这份 prompt；MCP 暴露的是知识图谱工具，不是同一层的 chat assistant。

### 3. 自定义 prompt 文件不存在时

当前实现会回退：

- 如果 `AGENT_SYSTEM_PROMPT_FILE` 不存在，则尝试 `AGENT_SYSTEM_PROMPT`
- 如果两者都没有，则回退到默认 prompt

因此它现在更偏“容错回退”，不是“严格报错”模式。

## 实际使用建议

### 通用知识库

直接使用默认 prompt 即可。

### 企业内部知识库

建议用 `AGENT_SYSTEM_PROMPT_FILE`，只补：

- 回答风格
- 来源引用规范
- 风险表达方式
- 术语语言偏好

### 强约束知识库

如果你对回答格式要求很高，建议在 prompt 中明确要求：

- 核心结论必须带来源
- 方案比较至少列出两个依据
- 不确定时必须输出“不确定”

## 典型配置示例

### SQLite 本地测试

```ini
VAULT_PATH=D:\WorkSpace\LLM-Wiki\obsidian
DB_PROVIDER=sqlite
DB_PATH=./data/chat.sqlite
AI_API_KEY=sk-xxx
AGENT_SYSTEM_PROMPT_FILE=./prompts/system-prompt.txt
```

### PostgreSQL 团队环境

```ini
VAULT_PATH=/srv/team-wiki/vault
DB_PROVIDER=postgres
DATABASE_URL=postgresql://user:pass@db:5432/teamwiki
AI_API_KEY=sk-xxx
AGENT_SYSTEM_PROMPT_FILE=./prompts/system-prompt.txt
```

## 当前实现总结

你现在可以把这套机制理解为：

- **默认通用 prompt**
- **启动后按当前 vault 动态补全**
- **支持环境变量或文件覆盖**

这比“把某个固定知识库结构硬编码进 system prompt”更适合 `team-wiki` 这种可切换 `VAULT_PATH` 的项目。
