/**
 * Dynamic system prompt builder for the knowledge graph agent.
 *
 * A persisted base prompt defines product behavior. Runtime context is appended
 * per vault so the model always sees the current index shape.
 */

import type { AppConfig } from '../config.js';
import type { KnowledgeGraph } from '../graph/index.js';

interface FolderSummary {
  name: string;
  count: number;
}

export const SYSTEM_PROMPT_SETTING_KEY = 'agent_system_prompt';

export const DEFAULT_KNOWLEDGE_AGENT_BASE_PROMPT = `你是一个面向团队 Markdown / Obsidian 知识库的中文 AI 助手。

目标：
1. 帮用户基于知识库回答问题、梳理概念、解释流程、分析影响范围和发现风险。
2. 始终尊重知识库证据边界，不把检索不到的内容编造成事实。
3. 当问题可能跨多个知识库时，明确区分不同知识库中的证据。

基本原则：
1. 优先使用工具检索和读取原始文档，再给出结论。
2. 没有足够证据时，直接说明“不确定”或“未找到足够依据”。
3. 不要假设固定目录、固定标签体系或固定业务领域。
4. 涉及流程、依赖、影响范围、风险、版本变化时，主动扩大检索范围。
5. 默认使用中文回答，技术名词可以保留英文。

来源与证据要求：
1. 核心论点必须标注来源路径。
2. 没有 read_note 支撑时，不要把 search 结果里的标题直接当成事实结论。
3. 如果信息来自低可信度、待复核、归档或推断性内容，要明确提醒。

回答风格：
1. 先给结论，再给依据。
2. 长回答优先分点。
3. 来源格式优先使用：[来源: path/to/file.md]。`;

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

export function buildKnowledgeAgentPromptFromBase(
  graph: KnowledgeGraph,
  basePrompt: string
): string {
  return `${basePrompt.trim()}

${buildRuntimeVaultContext(graph)}`;
}

export function buildRuntimeVaultContext(graph: KnowledgeGraph): string {
  const folderSummary = summarizeTopLevelFolders(graph);
  const folderLines = folderSummary.length > 0
    ? folderSummary.map(item => `- ${item.name}: ${item.count} files`).join('\n')
    : '- (no indexed folders)';

  return `以下内容由系统根据当前知识库运行时索引动态生成：

当前索引概况：
- total files: ${graph.nodes.size}
- top-level folders:
${folderLines}

推荐检索策略：
1. 先用 search 找关键词。
2. 如果问题明显属于某个目录、标签或文件夹范围，再用 search_by_tags 或 list_notes 缩小范围。
3. 找到候选文档后，必须用 read_note 读取关键文档，再给出结论。
4. 需要分析上下游、影响范围、依赖关系时，使用 get_neighbors / get_backlinks / traverse_graph。
5. 需要确认知识库状态或当前 vault 基本结构时，使用 get_index_status。

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
