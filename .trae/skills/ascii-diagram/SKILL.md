---
name: ascii-diagram
description: 绘制可直接粘贴到 Markdown/Obsidian 的 ASCII/Unicode 纯文本图（流程/架构/状态机/表格/线框）。几何优先：中心轴对齐、左右对称、框宽一致、最小信息集；默认按 East Asian Width 处理中文宽度。
---

# ASCII Diagram Skill

## 目标
用最小篇幅画出**高可扫描**、**可直接粘贴**的纯文本图（plaintext）。

默认顺序：**先定几何布局 → 再填语义标签 → 最后压缩文本**。

输出优先级（从高到低）：
1. **几何正确**：中心轴/对称/间距/框宽一致
2. **语义清晰**：节点/连线/分组一眼能读
3. **信息最小**：只保留完成阅读所需的元素
4. **可复制**：控制在 ~80 列内，避免尾随空格依赖

> 中文对齐：默认按 *East Asian Width*（宽字符≈2列）处理，避免“看起来对齐、实际错位”。
> 若渲染环境字体导致偏移，以“减少中文+缩短标签+统一框宽”为第一修复手段。

## 何时使用
- 用户要 **ASCII/Unicode 图**：架构图、流程图、数据流、状态机、表格、简易线框图
- 用户强调 **对齐 / 对称 / 居中 / 等宽 / 版式优化 / 可扫描**
- 内容需要**直接贴进**：Markdown/Obsidian、终端、代码注释、设计文档

## 不适用（直接拒绝或降级）
- 需要精确像素级排版（应使用 Mermaid/Figma/绘图工具）
- 需要复杂跨线交叉、密集拓扑（应拆成多张小图）
- 依赖尾随空格才能对齐的输出（容易在编辑器中被裁剪）

## 核心原则
1. **一图一事**：一张图只表达一个主视角（流程 / 架构 / 状态机 / 对照表）。
2. **当前有效**：优先画 as-is（现状），不混入未来方案；必要时另给“to-be”版本。
3. **几何优先**：先对齐、对称、间距、框宽一致，再补语义细节。
4. **节点有语义**：每个框必须能回答“它是什么？”（角色/状态/数据/容器）。
5. **连线可读**：方向明确；需要时加极短标签（`HTTP`/`Event`/`Batch`/`Query`）。
6. **局部先汇聚**：多分支先在局部合流，再并入主干中心轴，避免多线撞主轴。
7. **最小集合**：删到不能删为止；优先删“实现细节”，保留“关系”。
8. **可复制性**：尽量不依赖尾随空格；同层元素宽度统一，减少渲染差异。

## 固定字符集
- 边框：`┌┐└┘├┤┬┴┼│─`
- 强调框：`╔╗╚╝╠╣╦╩╬║═`
- 圆角框：`╭╮╰╯`
- 箭头：`▼ ▲ ▶ ◀`
- 阴影：`░`

默认优先 Unicode box-drawing；只有环境不支持时才退回纯 ASCII。

## 几何规则

### 1) 主干中心轴
- 若图有主路径，主路径节点应共享同一条中心轴。
- 主干上的 `│` + `▼` 必须落在同一列。
- 上下节点的视觉中心应对齐，不要左右漂移。

### 2) 上层汇聚
- 左右对子图先分别局部合流，再汇入中心轴。
- 不要让左右多个分支直接同时撞到主轴。
- 对称图中，左右留白和连线长度尽量镜像。

### 3) 多分支展开
- 每条竖向分支都应写成 `│` + `▼`，且 `▼` 对齐子框中心列。
- 3 分支、4 分支优先等距排布。
- 分支层内部的框宽默认统一；除非语义差异极大，不做单独拉伸。

### 4) 边框统一
- 同一层级的框宽尽量一致。
- 使用双线框时，所有 `║...║` 行宽必须一致。
- 同一张图里不要混用太多边框风格；默认最多两种。

### 5) 线路简化
- 连线优先直线，转折最少。
- 竖向连接默认写成 `│` + `▼` 的连续形态，不要让 `▼` 单独悬空出现。
- 只有在刻意追求极简风格、且上下关系毫无歧义时，才允许单独使用 `▼`。
- 尽量避免交叉线；如果必须交叉，重排布局优先于硬交叉。
- 连接关系密集时，优先拆成两个小图，而不是把一个图画乱。

### 6) 宽度与字符宽
- 未指定时，优先控制在 80 列以内。
- 处理中文时，按 CJK 宽字符视作 2 列，避免“看起来对齐、实际错位”。

## 布局原型

### A) 主干中心轴流图
适合：输入 → 处理 → 输出、状态推进、单主路径。

```text
            ╔══════════╗
            ║  Input   ║
            ╚══════════╝
                 │
                 ▼
            ╔══════════╗
            ║ Process  ║
            ╚══════════╝
                 │
                 ▼
            ╔══════════╗
            ║  Output  ║
            ╚══════════╝
```

### B) 左右对子图先合流，再汇入主轴
适合：中心轴几何对称版、双侧依赖汇聚。

```text
                              ╔══════════╗
                              ║ startup  ║
                              ╚══════════╝
                                   │
                                   ▼
             ┌─────────────────────┴─────────────────────┐
             │                                           │
             ▼                                           ▼
      ┌───────────────┐                           ┌───────────────┐
      │               │                           │               │
      ▼               ▼                           ▼               ▼
  ╔══════════╗   ╔══════════╗                ╔══════════╗     ╔══════════╗
  ║   UL1    ║   ║   UL2    ║                ║   UR1    ║     ║   UR2    ║
  ╚══════════╝   ╚══════════╝                ╚══════════╝     ╚══════════╝
      └───────┬───────┘                           └───────┬───────┘
              │                                           │
              ▼                                           ▼
        ╔══════════╗                               ╔══════════╗
        ║  L-agg   ║                               ║  R-agg   ║
        ╚══════════╝                               ╚══════════╝
              └───────────────────┬───────────────────┘
                                  │
                                  ▼
                             ╔══════════╗
                             ║   app    ║
                             ╚══════════╝
                                  │
                                  ▼
                 ┌───────────────┼───────────────┐
                 │               │               │
                 ▼               ▼               ▼
            ╔══════════╗    ╔══════════╗    ╔══════════╗
            ║    M1    ║    ║    M2    ║    ║    M3    ║
            ╚══════════╝    ╚══════════╝    ╚══════════╝
                 └───────────────┼───────────────┘
                                 │
                                 ▼
                            ╔══════════╗
                            ║  output  ║
                            ╚══════════╝
                                 │
                                 ▼
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
               ╔══════════╗             ╔══════════╗
               ║    D1    ║             ║    D2    ║
               ╚══════════╝             ╚══════════╝
```

### C) 容器 + 数据流
适合：系统边界、子系统、服务关系。

```text
┌──────────── System ────────────┐
│ Ingest ──▶ Processor ──▶ Store │
└────────────────────────────────┘
                │
                ▼
              Output
```

### D) 三栏线框图
适合：UI 结构、screen layout、工作台界面。

```text
┌──────────┬────────────────┬──────────────────┐
│ Sidebar  │  List Panel    │  Detail Panel    │
│          │                │                  │
│ ▼ Group1 │ ┌────────────┐ │ ┌──────────────┐ │
│   Item1  │ │ List Item  │ │ │   Content    │ │
│   Item2  │ └────────────┘ │ └──────────────┘ │
│ ▼ Group2 │                │ [Save] [Cancel]  │
└──────────┴────────────────┴──────────────────┘
```

### E) 表格
适合：枚举映射、策略对照、状态转换表。

```text
┌────────────┬────────────┬────────────┐
│ Name       │ Input      │ Output     │
├────────────┼────────────┼────────────┤
│ Case A     │ Enabled    │ Started    │
│ Case B     │ Disabled   │ Skipped    │
└────────────┴────────────┴────────────┘
```

## 固定工作流
1. 提取 4 类信息：`节点` / `边` / `分组` / `主路径`。
2. 先选布局原型：主轴流图、合流图、容器图、表格、线框图。
3. 先放主干，再放局部分支；不要反过来。
4. 先定框宽与列距，再写标签；必要时先用占位符。
5. 先画连接关系，再补边框修饰和标签。
6. 最后压缩文本：优先缩短标签，不要破坏对齐。

## 优化现有图时
- 保留原有语义和阅读顺序，优先只改几何布局。
- 优先修 4 类问题：主轴偏移、分支不对齐、局部未先合流、边框宽度不一致。
- 不随意发明新节点；只有在“合流语义需要显式表达”时才补聚合节点。
- 如果用户强调“中心轴几何对称版”，默认先满足几何约束，再谈信息压缩。

## 交付前检查
- 主干 `│` + `▼` 是否在同一列
- 分支 `│` + `▼` 是否落在子框中心列
- 左右对子图是否先局部合流再汇入主轴
- 同层框宽是否一致，`║...║` 行宽是否完全相同
- 是否能在 10 秒内扫出主路径
- 是否删掉了实现细节和无意义修饰

## 默认交付格式
- 先给图
- 再给 1~2 行说明：`主路径` + `关键约束`
- 若版式要求强，可直接给两个版本：`紧凑版` / `几何对称版`


## Example 1: System Architecture with Nested Components

```
                        ╔═ turbopuffer ════════════════════════════╗
╔════════════╗          ║                                          ║░
║            ║░         ║  ┏━━━━━━━━━━━━━━━┓     ┏━━━━━━━━━━━━━━┓  ║░
║   client   ║░───API──▶║  ┃    Memory/    ┃────▶┃    Object    ┃  ║░
║            ║░         ║  ┃   SSD Cache   ┃     ┃ Storage (S3) ┃  ║░
╚════════════╝░         ║  ┗━━━━━━━━━━━━━━━┛     ┗━━━━━━━━━━━━━━┛  ║░
 ░░░░░░░░░░░░░░         ║                                          ║░
                        ╚══════════════════════════════════════════╝░
                         ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

**Key Features:**
- Double-line outer box (╔═╗) for main service
- Heavy-line inner boxes (┏━┓) for components
- Simple shadows (░) for depth
- Clear API connection with labeled arrow
- Title integrated into top border

## Example 2: Table with Borders

```
┌─ Limits ────────────────────────────────────────────────────────────────────┐
│ Metric                                    Observed in production            │
├─────────────────────────────────────────────────────────────────────────────┤
│ Max documents (global)                    11T+ @ 1PB                        │
│ Max documents (queried simultaneously)    100B+ @ 10TB                      │
│ Max documents (per namespace)             500M+ @ 2TB                       │
│ Max number of namespaces                  100M+                             │
│ Max write throughput (global)             10M+ writes/s @ 32GB/s            │
│ Max write throughput (per namespace)      32k+ writes/s @ 64MB/s            │
│ Max queries (global)                      10k+ queries/s                    │
│ Max queries (per namespace)               1k+ queries/s                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Title in top border
- Header separator with ├─┤
- Single-line style for clean readability
- Properly aligned columns
- Simple and readable design

## Example 3: Three-Tier Web Architecture

```
                ┌─────────────────┐
                │   Web Browser   │
                └────────┬────────┘
                         │ HTTPS
                         ▼
            ╔══════════════════════════╗
            ║   Load Balancer (ALB)    ║
            ╚════════════╦═════════════╝
                         ║
         ┌───────────────╬───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┏━━━━━━━━━┓     ┏━━━━━━━━━┓     ┏━━━━━━━━━┓
    ┃  Web 1  ┃     ┃  Web 2  ┃     ┃  Web 3  ┃
    ┃ (EC2)   ┃     ┃ (EC2)   ┃     ┃ (EC2)   ┃
    ┗━━━━┳━━━━┛     ┗━━━━┳━━━━┛     ┗━━━━┳━━━━┛
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                 ╔════════════════╗
                 ║   PostgreSQL   ║░
                 ║   Primary DB   ║░
                 ╚════════════════╝░
                  ░░░░░░░░░░░░░░░░░░
```

**Key Features:**
- Double-line boxes (╔═╗) for infrastructure components
- Heavy-line boxes (┏━┓) for application servers
- Shadows (░) on database for emphasis
- Clear flow from top to bottom
- Labeled connections showing protocol

## Example 4: Write-Ahead Log (WAL) Pattern

```
                                User Write
                                 ┌─────┐
                                 │█████│
             WAL                 │█████│
 s3://tpuf/{namespace_id}/wal    └──┬──┘
                                       │
                                       │
╔═══════════════════════════════════╬══════════════╗
║┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌ ─│─ ┐           ║░
║│█████│ │█████│ │█████│ │█████│    ▼              ║░
║│█████│ │█████│ │█████│ │█████│ │     │           ║░
║└─────┘ └─────┘ └─────┘ └─────┘  ─ ─ ─            ║░
║  001     002     003     004     005             ║░
╚══════════════════════════════════════════════════╝░
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

**Key Features:**
- Shows user writing data into a WAL segment
- Numbered segments (001-005) for sequential writes
- Filled blocks (█) to indicate data
- Dashed box for the current write target
- Cross junction (╬) for data flow into container

## Example 5: Distributed System with Load Balancer and Object Storage

```
                   ╔══turpuffer region═══════╗      ╔═══Object Storage═════════════════╗
                   ║      ┌────────────────┬─╬─┐    ║ ┏━━Indexing Queue━━━━━━━━━━━━━━┓ ║░
                   ║      │ ./tpuf indexer │ ║░│    ║ ┃■■■■■■■■■                     ┃ ║░
                   ║      └────────────────┘ ║░│    ║ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ║░
                   ║      ┌────────────────┐ ║░│    ║ ┏━/{org_id}/{namespace}━━━━━━━━┓ ║░
                   ║      │ ./tpuf indexer │ ║░│    ║ ┃ ┏━/wal━━━━━━━━━━━━━━━━━━━━━┓ ┃ ║░
                   ║      └────────────────┘ ║░└───▶║ ┃ ┃■■■■■■■■■■■■■■■◈◈◈◈       ┃ ┃ ║░
                   ║                         ║░     ║ ┃ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ┃ ║░
                   ║                         ║░┌───▶║ ┃ ┏━/index━━━━━━━━━━━━━━━━━━━┓ ┃ ║░
                   ║      ┌────────────────┐ ║░│    ║ ┃ ┃■■■■■■■■■■■■■■■           ┃ ┃ ║░
                   ║   ┌─▶│  ./tpuf query  │ ║░│    ║ ┃ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ┃ ║░
                ┌──╩─┐ │  └────────────────┘ ║░│    ║ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ║░
╔══════════╗    │    │ │  ┌────────────────┐ ║░│    ╚══════════════════════════════════╝░
║  Client  ║───▶│ LB │─┼─▶│  ./tpuf query  │─╬─┘     ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
╚══════════╝░   │    │ │  └────────────────┘ ║░
 ░░░░░░░░░░░░   └──╦─┘ │  ┌────────────────┐ ║░
                   ║   └─▶│  ./tpuf query  │ ║░
                   ║      └────────────────┘ ║░
                   ║                         ║░
                   ╚═════════════════════════╝░
                    ░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

**Key Features:**
- Multiple nested layers showing storage hierarchy
- Load balancer (LB) distributing to query servers
- Indexer processes writing to object storage
- Progress indicators (■ and ◈) showing queue status
- Complex routing with multiple connection types
- Deep nesting: region → services, storage → namespace → wal/index

## Best Practices

### 1. Plan Before Drawing
- Sketch component hierarchy
- Identify main vs. secondary components
- Determine flow direction (usually left-to-right or top-to-bottom)

### 2. Use Consistent Styles
- Main services: Double-line boxes (╔═╗)
- Sub-components: Heavy-line boxes (┏━┓)
- Containers/groups: Single-line boxes (┌─┐)
- External systems: Rounded boxes (╭─╮)

### 3. Maintain Spacing
- Align boxes vertically and horizontally
- Use consistent padding inside boxes
- Keep arrow lengths similar for parallel connections

### 4. Add Context
- Label connections (HTTP, API, Data, etc.)
- Number steps in sequence diagrams
- Use shadows for main components only

### 5. Keep It Simple
- Don't overcomplicate - clarity over detail
- Group related components
- Use whitespace effectively

### 6. Common Patterns

**Request-Response:**
```
Client ──request──▶ Server
       ◀─response──
```

**Pub-Sub:**
```
Publisher ──▶ Message Queue ──▶ Subscriber 1
                    │
                    ├──▶ Subscriber 2
                    │
                    └──▶ Subscriber 3
```

**Master-Replica:**
```
             ┌────────┐
             │ Master │
             └───┬────┘
                 │
     ┌───────────┼───────────┐
     │           │           │
     ▼           ▼           ▼
 ┌────────┐  ┌────────┐  ┌────────┐
 │Replica │  │Replica │  │Replica │
 │   1    │  │   2    │  │   3    │
 └────────┘  └────────┘  └────────┘
```

## Quick Reference: Building Blocks

```
Box:          ┌───────┐
              │ Text  │
              └───────┘

Emphasized:   ╔═══════╗
              ║ Text  ║
              ╚═══════╝

With Shadow:  ┌───────┐
              │ Text  │░
              └───────┘░
               ░░░░░░░░

Arrow:        ────▶

Connection:   ┌───┐
              │ A │────┐
              └───┘    │
                       ▼
              ┌───┐  ┌───┐
              │ B │  │ C │
              └───┘  └───┘
```

## Tips for Success

1. **Start simple** - Add complexity gradually
2. **Test alignment** - View in monospace font
3. **Use proper Unicode** - Don't mix ASCII and box-drawing
4. **Group logically** - Related components should be visually close
5. **Iterate** - Adjust spacing and alignment as needed

## Character Palette

For quick copy-paste:

```
Box Drawing:  ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
              ═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╦ ╩ ╬
              ━ ┃ ┏ ┓ ┗ ┛ ┣ ┫ ┳ ┻ ╋
              ─ │ ╭ ╮ ╰ ╯

Arrows:       → ← ↑ ↓ ▶ ◀ ▲ ▼ ⇒ ⇐ ⇑ ⇓

Shading:      ░ ▒ ▓ █

Misc:         • ○ ◆ ◇ ■ □ ▪ ▫
```
