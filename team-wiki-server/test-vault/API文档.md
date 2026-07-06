---
title: API 文档
tags: [api, reference]
---

# API 接口文档

## MCP 工具列表

| 工具名 | 说明 | 参数 |
|--------|------|------|
| search | 全文搜索 | query, limit |
| traverse_graph | 图谱遍历 | start, depth |
| get_backlinks | 获取反链 | path |
| read_note | 读取文档 | path |

## Chat API

`POST /api/chat`

SSE 流式聊天接口，支持推理过程展示。

## 更多

- [[项目架构]] — 架构说明
- [[部署指南]] — 部署文档
