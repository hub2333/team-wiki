<template>
  <div class="heychat-container">
    <!-- 会话侧边栏 -->
    <div class="session-sidebar" :class="{ collapsed: sessionCollapsed }">
      <div class="sidebar-header">
        <div class="sidebar-header-row" v-if="!manageMode">
          <button class="new-chat-btn" @click="createNewSession">
            <el-icon><Plus /></el-icon>
            <span>新对话</span>
          </button>
          <button class="manage-btn" @click="enterManageMode" :disabled="sessions.length === 0">
            <el-icon><Operation /></el-icon>
          </button>
        </div>
        <div class="sidebar-header-row" v-else>
          <button class="new-chat-btn secondary" @click="exitManageMode">
            <span>取消</span>
          </button>
          <span class="manage-tip">已选 {{ selectedIds.size }} 项</span>
        </div>
        <div class="auth-panel">
          <input
            v-model="authTokenInput"
            class="auth-input"
            type="password"
            placeholder="Bearer Token / JWT（可选）"
          />
          <button class="auth-btn" @click="applyAuthToken">应用</button>
          <button class="auth-btn secondary" @click="clearAuthToken">清除</button>
        </div>
      </div>

      <div class="session-list" v-if="sessions.length > 0">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="session-item"
          :class="{
            active: currentSessionId === s.id,
            'manage-selected': selectedIds.has(s.id)
          }"
          @click="manageMode ? toggleSelect(s.id) : switchSession(s.id)"
        >
          <el-checkbox
            v-if="manageMode"
            :checked="selectedIds.has(s.id)"
            size="small"
            @click.stop="toggleSelect(s.id)"
            class="session-checkbox"
          />
          <el-icon v-else class="session-icon"><ChatDotSquare /></el-icon>
          <div class="session-info">
            <div class="session-title">{{ s.title || '新对话' }}</div>
            <div class="session-time">{{ formatSessionTime(s.updatedAt) }}</div>
          </div>
          <el-icon
            v-if="!manageMode"
            class="delete-btn"
            @click.stop="deleteSession(s.id)"
          ><Delete /></el-icon>
        </div>
      </div>
      <div class="session-empty" v-else>
        <span>{{ manageMode ? '没有可管理的会话' : '暂无历史会话' }}</span>
      </div>

      <!-- 管理模式底部操作栏 -->
      <div v-if="manageMode" class="manage-actions">
        <button class="action-btn select-all-btn" @click="toggleSelectAll">
          <el-icon><Select /></el-icon>
          <span>{{ allSelected ? '取消全选' : '全选' }}</span>
        </button>
        <button
          class="action-btn delete-batch-btn"
          :disabled="selectedIds.size === 0"
          @click="batchDeleteSessions"
        >
          <el-icon><Delete /></el-icon>
          <span>删除 {{ selectedIds.size ? `(${selectedIds.size})` : '' }}</span>
        </button>
      </div>

      <button class="toggle-sidebar" @click="sessionCollapsed = !sessionCollapsed">
        <el-icon><Fold /></el-icon>
      </button>
    </div>

    <!-- 主聊天区域 -->
    <div class="chat-main">
      <div class="messages-container" ref="messagesRef">
        <div class="messages-wrapper">

          <!-- 欢迎页 -->
          <div v-if="messages.length === 0 && !isStreaming" class="welcome-screen">
            <div class="welcome-logo">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#409eff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <h2 class="welcome-title">LLM WIKI 问答</h2>
            <p class="welcome-desc">基于知识库的智能问答，输入问题开始对话</p>
            <div class="suggestion-list">
              <div
                v-for="(s, i) in suggestions"
                :key="i"
                class="suggestion-item"
                @click="sendMessage(s)"
              >
                <el-icon><ChatLineSquare /></el-icon>
                <span>{{ s }}</span>
              </div>
            </div>
          </div>

          <!-- 历史消息列表 -->
          <div v-for="(msg, idx) in messages" :key="idx" class="message-group">
            <!-- 用户消息 -->
            <div v-if="msg.role === 'user'" class="message user-message">
              <div class="msg-content">{{ msg.content }}</div>
              <div class="msg-avatar user-avatar">
                <el-icon><UserFilled /></el-icon>
              </div>
            </div>

            <!-- 已完成 AI 消息 -->
            <div v-if="msg.role === 'assistant'" class="message ai-message">
              <div class="msg-avatar ai-avatar">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div class="msg-body">
                <!-- 思考过程（折叠） -->
                <div v-if="msg.thought" class="thought-block">
                  <div class="thought-header" @click="msg.thoughtOpen = !msg.thoughtOpen">
                    <el-icon>
                      <ArrowRight v-show="!msg.thoughtOpen" />
                      <ArrowDown v-show="msg.thoughtOpen" />
                    </el-icon>
                    <span>思考过程</span>
                  </div>
                  <div v-show="msg.thoughtOpen" class="thought-content">{{ msg.thought }}</div>
                </div>

                <!-- 工具调用（折叠） -->
                <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="tool-calls-collapsed">
                  <div class="tool-calls-header" @click="msg.toolCallsOpen = !msg.toolCallsOpen">
                    <el-icon>
                      <ArrowRight v-show="!msg.toolCallsOpen" />
                      <ArrowDown v-show="msg.toolCallsOpen" />
                    </el-icon>
                    <span>使用工具 {{ msg.toolCalls.length }} 次</span>
                  </div>
                  <div v-show="msg.toolCallsOpen" class="tool-calls-list">
                    <div v-for="(tc, tci) in msg.toolCalls" :key="tci" class="tool-call-item">
                      <div class="tool-call-title">
                        <el-icon><Tools /></el-icon>
                        <code>{{ tc.tool }}</code>
                        <span class="tool-duration" v-if="tc.durationMs">{{ formatDuration(tc.durationMs) }}</span>
                      </div>
                      <div v-if="tc.args" class="tool-call-detail">
                        <div class="detail-label">参数</div>
                        <pre>{{ JSON.stringify(tc.args, null, 2) }}</pre>
                      </div>
                      <div v-if="tc.result" class="tool-call-detail">
                        <div class="detail-label">结果</div>
                        <pre>{{ truncateText(tc.result, 500) }}</pre>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 文本内容 -->
                <div v-if="msg.content" class="ai-text" v-html="renderMarkdown(msg.content)"></div>

                <!-- 使用量脚注 -->
                <div v-if="msg.usage" class="usage-footer">
                  <span>耗时 {{ formatDuration(msg.usage.elapsedMs) }}</span>
                  <span class="usage-sep">·</span>
                  <span>估算 {{ msg.usage.estimatedTotalTokens }} token</span>
                  <span class="usage-sep">·</span>
                  <span>输入 {{ msg.usage.estimatedInputTokens }} → 输出 {{ msg.usage.estimatedOutputTokens }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 流式内容 -->
          <div v-if="isStreaming" class="message ai-message streaming-message">
            <div class="msg-avatar ai-avatar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div class="msg-body">
              <!-- 思考卡片 -->
              <div v-if="streamingThought.content !== null" class="thought-stream-card">
                <div class="thought-stream-header">
                  <el-icon><RefreshRight class="spin" /></el-icon>
                  <span>AI 思考中...</span>
                </div>
                <div class="thought-stream-body">{{ streamingThought.content }}</div>
              </div>

              <!-- 工具调用卡片 -->
              <div
                v-for="(card, ci) in streamingToolCards"
                :key="card.id"
                class="tool-stream-card"
              >
                <div class="tool-stream-header">
                  <el-icon v-if="card.status === 'running'" class="running-icon"><RefreshRight class="spin" /></el-icon>
                  <el-icon v-else class="done-icon"><CircleCheck /></el-icon>
                  <span>
                    <code>{{ card.tool }}</code>
                    <template v-if="card.status === 'running'">处理中...</template>
                    <template v-else>
                      已完成
                      <span class="tool-duration" v-if="card.durationMs">{{ formatDuration(card.durationMs) }}</span>
                    </template>
                  </span>
                </div>
                <div v-if="card.args && Object.keys(card.args).length" class="tool-stream-args">
                  <pre>{{ truncateText(JSON.stringify(card.args, null, 2), 200) }}</pre>
                </div>
                <div v-if="card.result" class="tool-stream-result">
                  <pre>{{ truncateText(card.result, 300) }}</pre>
                </div>
              </div>

              <!-- 流式文本 -->
              <template v-if="streamingContent">
                <div class="ai-text" v-html="renderMarkdown(streamingContent)"></div>
                <span class="streaming-cursor">▍</span>
              </template>

              <!-- 初始打字动画 -->
              <template v-if="!streamingContent && streamingThought.content === null && streamingToolCards.length === 0">
                <div class="typing-indicator">
                  <span></span><span></span><span></span>
                </div>
              </template>
            </div>
          </div>

          <!-- 错误 -->
          <div v-if="streamError" class="error-banner">
            <el-icon><WarningFilled /></el-icon>
            <span>{{ streamError }}</span>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="input-area">
        <div class="input-wrapper">
          <textarea
            ref="inputRef"
            v-model="userInput"
            class="chat-textarea"
            placeholder="输入您的问题，按 Enter 发送，Shift+Enter 换行"
            :disabled="isStreaming"
            @keydown="handleKeydown"
            rows="1"
          ></textarea>
          <div class="input-actions">
            <span class="input-hint">Enter 发送 · Shift+Enter 换行</span>
            <button
              class="send-btn"
              :disabled="!userInput.trim() || isStreaming"
              @click="sendMessage()"
            >
              <el-icon v-if="!isStreaming"><Promotion /></el-icon>
              <el-icon v-else class="stop-icon"><VideoPause /></el-icon>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import {
  Plus, ChatDotSquare, Delete, Fold,
  UserFilled, Tools, Promotion, VideoPause,
  ArrowRight, ArrowDown, ChatLineSquare,
  WarningFilled, RefreshRight, CircleCheck,
  Operation, Select
} from '@element-plus/icons-vue'

// API 基础路径（通过 vite proxy 转发到后端）
const API_BASE = ''
const AUTH_STORAGE_KEY = 'teamwiki.authToken'

// ── 状态 ──
const messages = reactive([])
const userInput = ref('')
const isStreaming = ref(false)
const sessionCollapsed = ref(false)
const sessions = ref([])
const currentSessionId = ref(null)
const streamError = ref('')
const messagesRef = ref(null)
const inputRef = ref(null)
const savedToken = typeof window !== 'undefined'
  ? (window.localStorage.getItem(AUTH_STORAGE_KEY) || '')
  : ''
const authToken = ref(savedToken)
const authTokenInput = ref(savedToken)

// ── 批量管理模式 ──
const manageMode = ref(false)
const selectedIds = reactive(new Set())
const allSelected = computed(() => sessions.value.length > 0 && selectedIds.size === sessions.value.length)

function enterManageMode() {
  manageMode.value = true
  selectedIds.clear()
}

function exitManageMode() {
  manageMode.value = false
  selectedIds.clear()
}

function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id)
  } else {
    selectedIds.add(id)
  }
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.clear()
  } else {
    selectedIds.clear()
    sessions.value.forEach(s => selectedIds.add(s.id))
  }
}

async function batchDeleteSessions() {
  if (selectedIds.size === 0) return
  const count = selectedIds.size
  try {
    await ElMessageBox.confirm(`确定要删除选中的 ${count} 条对话吗？`, '批量删除', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const ids = [...selectedIds]
    await Promise.all(ids.map(id =>
      apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
    ))
    sessions.value = sessions.value.filter(s => !selectedIds.has(s.id))
    if (currentSessionId.value && selectedIds.has(currentSessionId.value)) {
      createNewSession()
    }
    selectedIds.clear()
    ElMessage.success(`已删除 ${count} 条对话`)
  } catch (e) {
    if (e !== 'cancel') console.warn('批量删除失败:', e)
  }
}

// ── 流式中间卡片 ──
const streamingThought = reactive({ content: null })
const streamingToolCards = reactive([])
let toolCallSeq = 0
const streamingContent = ref('')
let pendingUsage = null

// 建议问题
const suggestions = [
  '介绍一下项目的架构设计',
  '项目使用了哪些技术栈？',
  '如何部署这个项目？',
  '项目的目录结构是怎样的？'
]

// 配置 marked + highlight.js
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value
      } catch (e) {
        // fallthrough
      }
    }
    return code
  }
})

function renderMarkdown(text) {
  if (!text) return ''
  try {
    return sanitizeHtml(marked.parse(text))
  } catch (e) {
    return sanitizeHtml(text)
  }
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${s}s`
}

function formatSessionTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function autoResize() {
  nextTick(() => {
    const el = inputRef.value
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }
  })
}

watch(userInput, autoResize)

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
}

function resetStreamingState() {
  streamingThought.content = null
  streamingToolCards.splice(0, streamingToolCards.length)
  streamingContent.value = ''
  streamError.value = ''
  toolCallSeq = 0
  pendingUsage = null
}

function buildAuthHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders }
  const token = authToken.value.trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function apiFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: buildAuthHeaders(options.headers || {})
  })
}

function persistAuthToken(token) {
  if (typeof window === 'undefined') return
  if (token) {
    window.localStorage.setItem(AUTH_STORAGE_KEY, token)
  } else {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
  }
}

async function applyAuthToken() {
  authToken.value = authTokenInput.value.trim()
  persistAuthToken(authToken.value)
  exitManageMode()
  createNewSession()
  await loadSessions()
}

async function clearAuthToken() {
  authTokenInput.value = ''
  authToken.value = ''
  persistAuthToken('')
  exitManageMode()
  createNewSession()
  await loadSessions()
}

function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return null
  const normalized = rawToolCalls.map(tc => ({
    tool: tc.tool || tc.name || 'unknown',
    args: tc.args && typeof tc.args === 'object' ? tc.args : {},
    result: typeof tc.result === 'string' ? tc.result : '',
    durationMs: tc.durationMs || 0
  }))
  return normalized.length > 0 ? normalized : null
}

// ── 会话管理 ──
async function loadSessions() {
  try {
    const res = await apiFetch('/api/sessions')
    if (res.status === 401) {
      sessions.value = []
      ElMessage.error('认证失败，请检查 Token / JWT')
      return
    }
    if (res.ok) {
      const data = await res.json()
      sessions.value = (data.sessions || []).sort((a, b) => b.updatedAt - a.updatedAt)
    }
  } catch (e) {
    console.warn('加载会话列表失败:', e)
  }
}

async function loadSessionMessages(sessionId) {
  try {
    const res = await apiFetch(`/api/sessions/${sessionId}`)
    if (res.status === 401) {
      ElMessage.error('认证失败，请检查 Token / JWT')
      return
    }
    if (res.ok) {
      const data = await res.json()
      messages.splice(0, messages.length)
      if (data.messages) {
        for (const msg of data.messages) {
          let toolCalls = null
          if (msg.toolCalls) {
            try {
              const parsed = typeof msg.toolCalls === 'string' ? JSON.parse(msg.toolCalls) : msg.toolCalls
              toolCalls = normalizeToolCalls(parsed)
            } catch (e) {
              toolCalls = null
            }
          }
          messages.push({
            role: msg.role,
            content: msg.content,
            toolCalls,
            thought: null,
            thoughtOpen: false,
            toolCallsOpen: false
          })
        }
      }
    }
  } catch (e) {
    console.warn('加载会话消息失败:', e)
  }
}

async function switchSession(sessionId) {
  if (isStreaming.value) return
  currentSessionId.value = sessionId
  resetStreamingState()
  await loadSessionMessages(sessionId)
  scrollToBottom()
}

function createNewSession() {
  if (isStreaming.value) return
  currentSessionId.value = null
  messages.splice(0, messages.length)
  resetStreamingState()
}

async function deleteSession(sessionId) {
  try {
    await ElMessageBox.confirm('确定要删除此对话吗？', '确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    if (res.status === 401) {
      ElMessage.error('认证失败，请检查 Token / JWT')
      return
    }
    if (res.ok) {
      sessions.value = sessions.value.filter(s => s.id !== sessionId)
      if (currentSessionId.value === sessionId) {
        createNewSession()
      }
      ElMessage.success('已删除')
    }
  } catch (e) {
    if (e !== 'cancel') console.warn('删除会话失败:', e)
  }
}

// ── 发送消息 ──
async function sendMessage(text) {
  const msgText = typeof text === 'string' ? text : userInput.value.trim()
  if (!msgText || isStreaming.value) return

  messages.push({ role: 'user', content: msgText, toolCalls: null, thought: null })
  if (!text) userInput.value = ''
  scrollToBottom()

  isStreaming.value = true
  resetStreamingState()

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msgText, sessionId: currentSessionId.value })
    })

    if (!res.ok) {
      throw new Error(await readErrorMessage(res))
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      let event = '', data = ''
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          data = line.slice(6)
        } else if (line === '' && event && data) {
          try {
            handleSSEEvent(event, JSON.parse(data))
          } catch (e) {
            console.warn('SSE parse error:', e)
          }
          event = ''
          data = ''
        }
      }
      scrollToBottom()
    }

    if (event && data) {
      try {
        handleSSEEvent(event, JSON.parse(data))
      } catch (e) {
        console.warn('SSE parse error (final):', e)
      }
    }

    finishStreaming()
  } catch (e) {
    streamError.value = e.message || '请求失败，请检查网络连接或后端服务'
    finishStreaming()
  } finally {
    isStreaming.value = false
  }

  loadSessions()
}

// ── SSE 事件处理 ──
function handleSSEEvent(event, data) {
  switch (event) {
    case 'text':
      streamingContent.value += data.content || ''
      break

    case 'thought':
      if (streamingThought.content === null) {
        streamingThought.content = ''
      }
      streamingThought.content += data.content || ''
      break

    case 'tool_start':
      streamingToolCards.push({
        id: `tool-${toolCallSeq++}`,
        tool: data.tool,
        args: data.args || {},
        result: null,
        status: 'running'
      })
      break

    case 'tool_end':
      if (streamingToolCards.length > 0) {
        const last = streamingToolCards[streamingToolCards.length - 1]
        last.result = data.result || ''
        last.durationMs = data.durationMs || 0
        last.status = 'done'
      }
      break

    case 'done':
      currentSessionId.value = data.sessionId || currentSessionId.value
      if (data.usage) {
        pendingUsage = data.usage
      }
      break

    case 'error':
      streamError.value = data.message || '未知错误'
      break
  }
}

function finishStreaming() {
  const thought = streamingThought.content
  const toolCalls = streamingToolCards.length > 0
    ? streamingToolCards.map(c => ({ tool: c.tool, args: c.args, result: c.result, durationMs: c.durationMs }))
    : null

  if (streamingContent.value || thought || toolCalls) {
    messages.push({
      role: 'assistant',
      content: streamingContent.value,
      thought,
      toolCalls,
      usage: pendingUsage || undefined,
      thoughtOpen: false,
      toolCallsOpen: false
    })
  }

  resetStreamingState()
  scrollToBottom()
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

onMounted(() => {
  loadSessions()
  autoResize()
})

function readErrorMessage(response) {
  return response.text().then(text => {
    if (!text) return `HTTP ${response.status}: ${response.statusText}`
    try {
      const parsed = JSON.parse(text)
      return parsed.error || parsed.message || `HTTP ${response.status}: ${response.statusText}`
    } catch (e) {
      return text
    }
  })
}

function sanitizeHtml(html) {
  if (typeof window === 'undefined' || !html) return html

  const template = document.createElement('template')
  template.innerHTML = html

  const blockedTags = new Set([
    'script', 'style', 'iframe', 'object', 'embed',
    'link', 'meta', 'base', 'form'
  ])

  const elements = template.content.querySelectorAll('*')
  elements.forEach(el => {
    const tag = el.tagName.toLowerCase()
    if (blockedTags.has(tag)) {
      el.remove()
      return
    }

    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()

      if (name.startsWith('on') || name === 'style') {
        el.removeAttribute(attr.name)
        continue
      }

      if ((name === 'href' || name === 'src' || name === 'xlink:href') && !isSafeUrl(value)) {
        el.removeAttribute(attr.name)
      }
    }

    if (tag === 'a') {
      el.setAttribute('rel', 'noopener noreferrer')
      if (!el.getAttribute('target')) {
        el.setAttribute('target', '_blank')
      }
    }
  })

  return template.innerHTML
}

function isSafeUrl(url) {
  if (!url) return true
  const lower = url.toLowerCase()
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('#') ||
    lower.startsWith('/') ||
    lower.startsWith('./') ||
    lower.startsWith('../') ||
    lower.startsWith('data:image/')
  )
}
</script>

<style scoped>
.heychat-container {
  display: flex;
  height: 100vh;
  width: 100%;
  background: #f0f2f5;
  overflow: hidden;
}

/* ── 会话侧边栏 ── */
.session-sidebar {
  width: 280px;
  min-width: 280px;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
  position: relative;
  transition: width 0.2s, min-width 0.2s;
  overflow: hidden;
}
.session-sidebar.collapsed { width: 0; min-width: 0; border-right: none; }
.sidebar-header { padding: 16px; flex-shrink: 0; }
.auth-panel { display: flex; gap: 6px; margin-top: 10px; }
.auth-input {
  flex: 1; min-width: 0; height: 34px; padding: 0 10px;
  border: 1px solid #dcdfe6; border-radius: 8px; outline: none;
  font-size: 12px; color: #606266; background: #fff;
}
.auth-input:focus { border-color: #409eff; }
.auth-btn {
  height: 34px; padding: 0 10px; border: none; border-radius: 8px;
  background: #409eff; color: #fff; font-size: 12px; cursor: pointer;
  white-space: nowrap;
}
.auth-btn.secondary { background: #f2f3f5; color: #606266; }
.auth-btn:hover { opacity: 0.92; }

.new-chat-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  background: #409eff;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}
.new-chat-btn:hover { background: #337ecc; }
.new-chat-btn.secondary { background: #fff; color: #606266; border: 1px solid #dcdfe6; }
.new-chat-btn.secondary:hover { background: #f5f5f5; }

.sidebar-header-row {
  display: flex; align-items: center; gap: 8px;
}
.sidebar-header-row .new-chat-btn { flex: 1; }

.manage-btn {
  width: 36px; height: 36px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: #fff; border: 1px solid #dcdfe6; border-radius: 8px;
  color: #606266; cursor: pointer; transition: all 0.2s; font-size: 16px;
}
.manage-btn:hover:not(:disabled) { color: #409eff; border-color: #409eff; }
.manage-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.manage-tip { font-size: 12px; color: #909399; white-space: nowrap; }

.session-checkbox { margin-right: 4px; }
.session-item.manage-selected { background: #eef5ff; }

.session-list { flex: 1; overflow-y: auto; padding: 0 8px; }
.session-item {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; margin-bottom: 2px; border-radius: 8px;
  cursor: pointer; transition: background 0.15s;
}
.session-item:hover { background: #f0f5ff; }
.session-item.active { background: #e6f0ff; }
.session-icon { color: #909399; flex-shrink: 0; font-size: 16px; }
.session-info { flex: 1; min-width: 0; }
.session-title { font-size: 13px; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.4; }
.session-time { font-size: 11px; color: #c0c4cc; margin-top: 2px; }
.delete-btn { display: none; color: #c0c4cc; font-size: 14px; cursor: pointer; flex-shrink: 0; }
.session-item:hover .delete-btn { display: inline-flex; }
.delete-btn:hover { color: #f56c6c; }
.session-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #c0c4cc; font-size: 13px; }

/* 管理模式底部操作栏 */
.manage-actions {
  flex-shrink: 0; display: flex; gap: 8px; padding: 12px 16px;
  border-top: 1px solid #e4e7ed; background: #fff;
}
.action-btn {
  flex: 1; height: 36px; display: flex; align-items: center; justify-content: center; gap: 4px;
  border-radius: 8px; font-size: 12px; cursor: pointer; transition: all 0.2s; border: none;
}
.select-all-btn { background: #f0f5ff; color: #409eff; }
.select-all-btn:hover { background: #e0edff; }
.delete-batch-btn { background: #fef0f0; color: #f56c6c; }
.delete-batch-btn:hover:not(:disabled) { background: #fde2e2; }
.delete-batch-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.toggle-sidebar {
  position: absolute; right: -32px; top: 50%; transform: translateY(-50%);
  width: 32px; height: 48px; display: flex; align-items: center; justify-content: center;
  background: #fff; border: 1px solid #e4e7ed; border-left: none;
  border-radius: 0 8px 8px 0; cursor: pointer; color: #909399; z-index: 10; padding: 0;
}
.toggle-sidebar:hover { color: #409eff; }

/* ── 主聊天区域 ── */
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* ── 消息区域 ── */
.messages-container { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
.messages-wrapper { max-width: 860px; margin: 0 auto; padding: 24px 32px 32px; }

/* 欢迎页 */
.welcome-screen {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 500px; text-align: center; padding: 40px 20px;
}
.welcome-logo { margin-bottom: 16px; opacity: 0.8; }
.welcome-title { font-size: 24px; font-weight: 600; color: #303133; margin: 0 0 8px; }
.welcome-desc { font-size: 14px; color: #909399; margin: 0 0 32px; }
.suggestion-list { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; max-width: 600px; }
.suggestion-item {
  display: flex; align-items: center; gap: 6px; padding: 10px 16px;
  background: #fff; border: 1px solid #e4e7ed; border-radius: 10px;
  font-size: 13px; color: #606266; cursor: pointer; transition: all 0.2s;
}
.suggestion-item:hover { border-color: #409eff; color: #409eff; background: #f0f5ff; }

/* ── 消息通用 ── */
.message-group { margin-bottom: 16px; }
.message { display: flex; gap: 12px; margin-bottom: 16px; animation: msgIn 0.3s ease; }
@keyframes msgIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

/* 用户消息 */
.user-message { justify-content: flex-end; }
.user-message .msg-content {
  max-width: 70%; padding: 12px 16px;
  background: #409eff; color: #fff;
  border-radius: 12px 12px 4px 12px;
  font-size: 14px; line-height: 1.6; word-break: break-word;
}

.msg-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; font-size: 16px;
}
.user-avatar { background: #409eff; color: #fff; }
.ai-avatar { background: #f0f5ff; color: #409eff; border: 1px solid #d9e8ff; }
.ai-message .msg-body { flex: 1; min-width: 0; max-width: calc(100% - 44px); }

/* AI 文本 */
.ai-text { padding: 0; font-size: 14px; line-height: 1.7; color: #303133; word-break: break-word; }
.ai-text :deep(p) { margin: 8px 0; }
.ai-text :deep(h1), .ai-text :deep(h2), .ai-text :deep(h3), .ai-text :deep(h4) { margin: 16px 0 8px; font-weight: 600; color: #1d2129; }
.ai-text :deep(h1) { font-size: 1.3em; }
.ai-text :deep(h2) { font-size: 1.15em; }
.ai-text :deep(h3) { font-size: 1.05em; }
.ai-text :deep(ul), .ai-text :deep(ol) { padding-left: 20px; margin: 8px 0; }
.ai-text :deep(li) { margin: 4px 0; }
.ai-text :deep(strong) { font-weight: 600; color: #1d2129; }
.ai-text :deep(code) { font-family: 'Menlo', 'Monaco', 'Courier New', monospace; background: #f2f4f7; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: #d63384; }
.ai-text :deep(pre) { background: #1e1e1e; border-radius: 8px; padding: 16px; overflow-x: auto; margin: 12px 0; }
.ai-text :deep(pre code) { background: transparent; color: #d4d4d4; padding: 0; font-size: 13px; line-height: 1.5; }
.ai-text :deep(blockquote) { border-left: 3px solid #409eff; padding: 8px 12px; margin: 12px 0; background: #f8faff; border-radius: 0 6px 6px 0; color: #606266; }
.ai-text :deep(table) { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.ai-text :deep(th), .ai-text :deep(td) { border: 1px solid #e4e7ed; padding: 8px 12px; text-align: left; }
.ai-text :deep(th) { background: #f5f7fa; font-weight: 600; }
.ai-text :deep(img) { max-width: 100%; border-radius: 8px; margin: 12px 0; }
.ai-text :deep(a) { color: #409eff; text-decoration: none; }
.ai-text :deep(a:hover) { text-decoration: underline; }

/* ── 已完成消息中的折叠块 ── */
.thought-block {
  background: #f8faff; border: 1px solid #e0edff; border-radius: 8px; margin-bottom: 12px; overflow: hidden;
}
.thought-header {
  display: flex; align-items: center; gap: 4px; padding: 8px 12px;
  font-size: 12px; color: #409eff; cursor: pointer; user-select: none;
}
.thought-header:hover { background: #eef5ff; }
.thought-content { padding: 0 12px 12px; font-size: 13px; color: #606266; line-height: 1.6; white-space: pre-wrap; }

.tool-calls-collapsed {
  background: #fafafa; border: 1px solid #e4e7ed; border-radius: 8px; margin-bottom: 12px; overflow: hidden;
}
.tool-calls-header {
  display: flex; align-items: center; gap: 4px; padding: 8px 12px;
  font-size: 12px; color: #606266; cursor: pointer; user-select: none;
}
.tool-calls-header:hover { background: #f0f0f0; }
.tool-calls-list { border-top: 1px solid #eee; }
.tool-call-item { padding: 8px 12px; border-top: 1px solid #f0f0f0; }
.tool-call-item:first-child { border-top: none; }
.tool-call-title { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #606266; margin-bottom: 4px; }
.tool-call-title code { background: #e8e8e8; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
.tool-duration { margin-left: 6px; font-size: 11px; color: #909399; background: #f0f0f0; padding: 0 5px; border-radius: 3px; line-height: 1.6; }
.tool-call-detail { margin-top: 6px; font-size: 12px; }
.detail-label { color: #909399; margin-bottom: 2px; font-size: 11px; }
.tool-call-detail pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: 'Menlo', 'Monaco', monospace; color: #606266; font-size: 11px; }

/* ── 流式内容 ── */
.streaming-message .msg-body { min-width: 0; }
.streaming-message .thought-stream-card,
.streaming-message .tool-stream-card {
  margin-bottom: 8px;
}

.thought-stream-card {
  background: #f8faff; border: 1px solid #e0edff; border-radius: 8px; overflow: hidden;
}
.thought-stream-header {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; font-size: 12px; color: #409eff;
  background: #eef5ff;
}
.thought-stream-body {
  padding: 8px 12px; font-size: 13px; color: #606266;
  line-height: 1.6; white-space: pre-wrap; max-height: 200px; overflow-y: auto;
}

.tool-stream-card {
  background: #fafafa; border: 1px solid #e4e7ed; border-radius: 8px; overflow: hidden;
}
.tool-stream-header {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; font-size: 12px; color: #606266;
  background: #f5f5f5;
}
.tool-stream-header code { background: #e8e8e8; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
.tool-stream-args, .tool-stream-result { padding: 6px 12px; border-top: 1px solid #eee; font-size: 12px; }
.tool-stream-args pre, .tool-stream-result pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: 'Menlo', 'Monaco', monospace; color: #606266; font-size: 11px; max-height: 120px; overflow-y: auto; }
.running-icon { color: #409eff; }
.done-icon { color: #67c23a; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.streaming-cursor { display: inline-block; color: #409eff; font-weight: bold; animation: blink 0.8s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.usage-footer { margin-top: 8px; padding-top: 6px; border-top: 1px solid #f0f0f0; font-size: 11px; color: #c0c4cc; display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.usage-sep { margin: 0 4px; color: #e0e0e0; }

.typing-indicator { display: flex; gap: 4px; padding: 4px 0; }
.typing-indicator span { width: 8px; height: 8px; border-radius: 50%; background: #409eff; animation: typing 1.4s infinite ease-in-out; }
.typing-indicator span:nth-child(1) { animation-delay: 0s; }
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing { 0%, 60%, 100% { transform: scale(1); opacity: 0.4; } 30% { transform: scale(1.2); opacity: 1; } }

.error-banner { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: #fef0f0; border: 1px solid #fde2e2; border-radius: 8px; color: #f56c6c; font-size: 13px; margin-top: 8px; }

/* ── 输入区域 ── */
.input-area { padding: 16px 24px 24px; background: #f0f2f5; flex-shrink: 0; }
.input-wrapper { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #dcdfe6; border-radius: 12px; padding: 8px 12px; transition: border-color 0.2s, box-shadow 0.2s; display: flex; flex-direction: column; }
.input-wrapper:focus-within { border-color: #409eff; box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.15); }
.chat-textarea { width: 100%; border: none; outline: none; resize: none; font-size: 14px; line-height: 1.6; color: #303133; background: transparent; padding: 4px 0; max-height: 200px; font-family: inherit; }
.chat-textarea::placeholder { color: #c0c4cc; }
.input-actions { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; border-top: 1px solid #f0f0f0; margin-top: 4px; }
.input-hint { font-size: 11px; color: #c0c4cc; }
.send-btn { width: 36px; height: 36px; border-radius: 8px; border: none; background: #409eff; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s; font-size: 16px; }
.send-btn:hover:not(:disabled) { background: #337ecc; }
.send-btn:disabled { background: #c0c4cc; cursor: not-allowed; }
.stop-icon { animation: pulse 0.6s ease-in-out infinite alternate; }
@keyframes pulse { from { opacity: 0.6; } to { opacity: 1; } }

/* ── 滚动条 ── */
.messages-container::-webkit-scrollbar { width: 6px; }
.messages-container::-webkit-scrollbar-track { background: transparent; }
.messages-container::-webkit-scrollbar-thumb { background: #d0d5dd; border-radius: 3px; }
.messages-container::-webkit-scrollbar-thumb:hover { background: #b0b5bd; }

/* ── 响应式 ── */
@media (max-width: 768px) {
  .session-sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 100; box-shadow: 2px 0 12px rgba(0, 0, 0, 0.1); }
  .session-sidebar.collapsed { transform: translateX(-100%); }
  .toggle-sidebar { display: none; }
  .messages-wrapper { padding: 16px; }
  .user-message .msg-content { max-width: 85%; }
  .input-area { padding: 12px 16px 16px; }
}
</style>
