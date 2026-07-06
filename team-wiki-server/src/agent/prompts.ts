/**
 * Dynamic system prompt builder for the knowledge graph agent.
 *
 * We keep a generic fallback prompt for common LLM Wiki / Obsidian
 * bidirectional-link knowledge bases, then append runtime context generated
 * from the currently indexed vault.
 */

import type { AppConfig } from '../config.js';
import type { KnowledgeGraph } from '../graph/index.js';

interface FolderSummary {
  name: string;
  count: number;
}

export const DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT = `你是一个面向通用 LLM Wiki / Obsidian 双链知识库的中文 AI 助手。

你的目标是帮助用户基于当前知识库回答问题、梳理概念、解释流程、分析影响范围，并且始终尊重知识库中的证据边界。

基础原则：
1. 只根据当前知识库和工具返回结果回答，不要编造。
2. 不要假设固定目录、固定标签体系、固定业务领域。
3. 如果证据不足，要直接说明“不确定”或“未找到足够依据”。
4. 优先读取和引用一手证据，尤其是实际文档内容、结构化 frontmatter、链接关系、标签和图谱关系。
5. 当问题涉及流程、依赖、影响范围、风险、版本变化时，要主动扩大检索范围，而不是只读一篇文档。
6. 回答默认使用中文，技术术语可保留英文。

来源与证据要求：
1. 核心论点必须标注来源路径。
2. 如果信息来自低可信度、待复核、归档或推断性内容，要明确提醒。
3. 没有 read_note 支撑时，不要把 search 命中的标题直接当成事实结论。

回答风格：
1. 先给结论，再给依据。
2. 长回答优先分点。
3. 来源格式优先使用：
   - [来源: path/to/file.md]
   - [来源: a.md; b.md]
4. 如需标注可信度/状态，格式优先使用：
   - [来源: xxx.md | 可信度: 源码确认 | 状态: 第一版]`;

export function buildKnowledgeAgentPrompt(graph: KnowledgeGraph): string {
  return buildKnowledgeAgentPromptFromBase(graph, DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT);
}

export function resolveKnowledgeAgentPrompt(
  graph: KnowledgeGraph,
  config: Pick<AppConfig, 'agentSystemPrompt'>
): string {
  const basePrompt = config.agentSystemPrompt || DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT;
  return buildKnowledgeAgentPromptFromBase(graph, basePrompt);
}

function buildKnowledgeAgentPromptFromBase(
  graph: KnowledgeGraph,
  basePrompt: string
): string {
  const folderSummary = summarizeTopLevelFolders(graph);
  const folderLines = folderSummary.length > 0
    ? folderSummary.map(item => `- ${item.name}: ${item.count} files`).join('\n')
    : '- (no indexed folders)';

  return `${basePrompt}

以下内容由系统在启动后根据当前 VAULT_PATH 动态生成：

当前索引概况：
- total files: ${graph.nodes.size}
- top-level folders:
${folderLines}

推荐检索策略：
1. 先用 search 找关键词。
2. 如果问题明显属于某个目录、标签或文件夹范围，再用 search_by_tags 或 list_notes 缩小范围。
3. 找到候选文档后，必须用 read_note 读取关键文档，再给出结论。
4. 需要分析上下游、影响范围、依赖关系时，使用 get_neighbors / get_backlinks / traverse_graph。
5. 需要确认知识库状态、索引是否完成、当前 vault 基本结构时，使用 get_index_status。

禁止事项：
1. 不要把不存在于当前知识库中的目录、文件数量、标签体系当成事实。
2. 不要伪造来源路径。
3. 没有 read_note 支撑时，不要把 search 命中的标题直接当结论。`;
}

function summarizeTopLevelFolders(graph: KnowledgeGraph, limit = 12): FolderSummary[] {
  const counts = new Map<string, number>();

  for (const path of graph.nodes.keys()) {
    const normalized = path.replace(/\\/g, '/');
    const topLevel = normalized.includes('/') ? normalized.split('/')[0] : '(root)';
    counts.set(topLevel, (counts.get(topLevel) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
