# <img src="logo.png" width="44" style="vertical-align:middle" alt="Scrapewright"> Scrapewright

**用自然语言描述网页爬取和信息抽取需求，Scrapewright 把它自动编码为可重复调用的 HTTP 采集服务。**

[English](./README.md) | **简体中文**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

Scrapewright 是一个 **基于大语言模型（LLM）的智能网页数据采集平台**：用自然语言描述“想采集什么”，LLM 会自动分析目标网页，自动生成采集脚本并部署为一个长期运行的服务。使用 Scrapewright 开发和部署网页采集与抽取服务，无需学习框架、无需编写 CSS 选择器、无需应对反爬，且网站改版后的维护将变得极其容易。

**Scrapewright 用 AI 开发网页爬虫采集服务**：在向导中用自然语言描述需求，AI 打开目标网页、分析结构、生成采集脚本并当场试跑；验证效果后，它即成为一个标准 HTTP 接口，供程序、脚本或 AI 智能体调用。运行时**不再调用 LLM**、不消耗 token，经济性和速度优于 Agent 驱动浏览器的方式。

Scrapewright 以 Chrome 扩展的形式运行在**日常使用的浏览器**中，因而具备三个天然优势：

- **登录态直接复用** — 已登录的网站直接采集，无需配置 Cookie、无需模拟登录
- **页面完整可见** — 浏览器中显示的内容均可采集：JS 动态渲染、iframe 嵌套、翻页、悬浮卡片、延迟加载（lazy render）、节流限制，以及逐条打开的详情页等
- **无自动化痕迹** — 没有 headless 浏览器的指纹特征，请求来自真实浏览器

脚本执行失败时，AI 会分析 DOM 快照并自动修复重试；网站改版后，同样可以再次修复。每个服务还可导出 Markdown 接口文档，供其他 AI 智能体使用。

> **60 秒上手**
>
> 1. `chrome://extensions/` 开启开发者模式 → "加载已解压的扩展程序" → 选择本项目 `extension/` 目录
> 2. `./bin/scrapewright install` 安装后台服务（Windows 用 `.\bin\scrapewright.cmd install`）
> 3. 扩展图标 → Options → Settings 配置 LLM → **+ New Service** → 用一句话描述需求 → 测试 → 部署
>
> 现在任何程序都能调用它：
>
> 提交任务（立即返回 jobId）：
> ```bash
> curl -X POST http://localhost:8765/api/v1/services/my-service/execute \
>   -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
>   -d '{"input": {"query": "你好"}}'
> ```
>
> 获取采集结果（阻塞直到完成）：
> ```bash
> curl "http://localhost:8765/api/v1/jobs/<jobId>/wait?timeout=120" \
>   -H "X-API-Key: dev-key"
> ```

项目 `examples/` 目录下提供了若干采集服务脚本样例，可在 Options 页通过 **Import** 导入后直接部署。

同一套步骤图（step-graph）引擎还可作为轻量级的 **Web 测试自动化** / 浏览器自动化工具：点击、输入、等待、断言、分支——声明式、可重放、可自愈。

**技术细节**请看[技术白皮书](docs/technical-whitepaper.md)（架构、模块、二次开发指南）。

## 目录

- [背景](#背景)
- [系统要求](#系统要求)
- [快速开始](#快速开始) — [安装](#安装) · [创建采集服务](#创建采集服务) · [管理服务](#管理服务) · [调用服务](#调用服务)
- [scrapewright 命令一览](#scrapewright-命令一览)
- [采集服务接口（HTTP API）](#采集服务接口http-api)
- [故障排查](#故障排查)
- [核心特性](#核心特性) — [系统价值](#系统价值) · [与其他方案对比](#与其他方案对比) · [典型场景](#典型场景)
- [版权与许可证](#版权与许可证)

## 背景

从网页提取数据，传统工具（Scrapy、Selenium、Puppeteer/Playwright、BeautifulSoup）有几个共同的痛点：

| 痛点 | 表现 |
|------|------|
| **开发成本高** | 每个网站都要手写选择器、处理翻页和反爬；网站一改版，维护成本重新来一遍 |
| **动态页面难** | React/Vue 单页应用、iframe 嵌套、异步加载的内容，HTTP 请求 + HTML 解析够不着 |
| **难以复用** | 给网站 A 写的爬虫帮不到结构类似的网站 B |
| **没有统一接口** | 每个采集任务的输入输出格式都不同，编排和调度无从下手 |

Scrapewright 的回答是：**让 AI 在真实浏览器里替你配置采集，并把结果标准化成 HTTP 服务。**

- **AI 驱动** — 自然语言描述需求，LLM 分析页面、生成脚本、失败自动修复
- **真实浏览器** — Chrome 扩展运行在你日常的浏览器里，登录态、Cookie、指纹原样复用
- **标准接口** — 每个服务的输入输出都有 JSON Schema 约束，对外形状永远一致
- **可视化向导** — 5 阶段向导从描述到部署全程可见，非技术人员也能上手

## 系统要求

- Chrome 浏览器（最新稳定版）
- Node.js >= 18
- 任一 LLM 服务的 API Key：OpenAI / Moonshot Kimi / Anthropic / GLM 智谱（或任何 OpenAI 兼容接口）

## 快速开始

### 安装

#### 1. 加载 Chrome 扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角**"开发者模式"**
3. 点击**"加载已解压的扩展程序"**，选择本项目的 `extension/` 目录

#### 2. 安装主机

主机是一个轻量 Node.js 服务，负责对外提供 HTTP API。以下命令把它注册为操作系统后台服务——开机自启、崩溃自动重启：

```bash
./bin/scrapewright install                    # Linux / macOS，默认端口 8765
.\bin\scrapewright.cmd install                # Windows (PowerShell)
./bin/scrapewright install --port=9123        # 自定义端口（所有平台）
```

安装后打开扩展 → **Options** → **Server Configuration** 确认端口一致（默认 `8765`），点击 **Test Connection**，状态徽标显示 **Connected** 即成功。

#### 3. 配置 LLM

1. 扩展图标 → **Options** → 右上角 **Settings**
2. 在 **LLM Configuration** 区域填写：
   - **Provider / Model / API Key** — 任选一家：OpenAI、Moonshot / Kimi、Anthropic、GLM
   - **Base URL**（可选）— 自定义或兼容 OpenAI 格式的中转地址，需含路径前缀（如 `https://api.openai.com/v1`）
   - **Max output tokens**（默认 8192）— 推理模型会先消耗"思考" token，输出被截断时调高
   - **Timeout**（默认 120 秒）— 模型或提示词较慢时调高
3. 点击 **Save**

### 创建采集服务

在 Options 页点击 **+ New Service**，进入 5 阶段 AI 向导：

| 阶段 | 你做什么 |
|------|---------|
| **1. 目标与需求** | 填目标网址 + 一句话需求（要哪些字段、翻不翻页）。点 **Research**，AI 打开页面分析并生成草稿 |
| **2. 名称与步骤** | 给服务命名，查看/编辑 AI 生成的步骤（每步一段脚本，可手动微调） |
| **3. 接口定义** | 确认输入/输出的 JSON Schema 和测试数据 |
| **4. 执行测试** | 实时观看逐步执行过程：打开页面 → 每一步 → 成功/失败 |
| **5. 结果** | 检查提取的数据。不满意就点 **Auto-Fix** 让 AI 修，或直接部署 |

<p align="center">
  <img src="docs/phase1.png" width="72%" alt="向导阶段 1：描述目标与需求">
</p>
<p align="center">
  <em>阶段 1：用自然语言描述采集需求，AI 分析页面并生成草稿</em>
</p>

Research 期间 AI 会经历多个轮次：探索页面结构、发现候选选择器、用真实元素 HTML 逐一确认、最后生成步骤脚本——每轮都以上一轮的验证结果为输入。如果页面需要登录、验证码等人工操作，向导会弹出提示并给出对应按钮。

测试失败时 **Auto-Fix** 自动介入：AI 拿到错误信息、DOM 快照与诊断数据，重写脚本并重新测试；多次尝试中得分最高的版本会被保留。你还可以在阶段 5 的输入框里用自然语言告诉它问题所在（如"缺少发布时间"），AI 会据此修复。原理详见[白皮书 §5](docs/technical-whitepaper.md)。

<p align="center">
  <img src="docs/phase5.png" width="72%" alt="向导阶段 5：结果与自动修复">
</p>
<p align="center">
  <em>阶段 5：检查提取结果，必要时使用 Auto-Fix 修复</em>
</p>

### 管理服务

所有服务都在 Options 页统一管理：

- **Enable / Disable** — 启用、停用
- **Edit** — 回到向导修改（自动预填现有配置）
- **API Doc** — 查看/下载该服务的 Markdown 接口文档
- **Export / Import / Export All** — JSON 导入导出，跨设备迁移
- **Delete** — 删除

页面底部是 **Execution History**（最近 20 次执行记录：时间、服务、成败）。

### 调用服务

部署完成后，服务就是一个本地 HTTP 接口，两步调用：

```bash
# 1. 提交任务（立即返回 jobId）
JOB_ID=$(curl -s -X POST http://localhost:8765/api/v1/services/my-service/execute \
  -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"input": {"query": "无线鼠标"}}' | jq -r '.jobId')

# 2. 等待结果（阻塞直到完成）
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID/wait?timeout=120" \
  -H "X-API-Key: dev-key" | jq '.job.result'
```

**交给 AI 智能体调用。** 每个服务都可以在 Options 页通过 **API Doc** 按钮下载 Markdown 接口文档；将文档提供给 Hermes Agent、WorkBuddy、龙虾 等智能体后，它们即可直接调用该服务。

完整接口说明（参数、状态、错误码、页面记录字段）见 [采集服务接口（HTTP API）](#采集服务接口http-api)。

## scrapewright 命令一览

`./bin/scrapewright`（Windows 用 `.\bin\scrapewright.cmd`，命令相同）：

| 命令 | 作用 |
|------|------|
| `install [--port=N]` | 安装主机为 OS 后台服务并启动 |
| `status` | 服务状态 + `/health` + 端口一致性 |
| `doctor` | 完整诊断（服务、端口、路径漂移、遗留文件） |
| `start` / `stop` / `restart` | 服务控制 |
| `run [--port=N]` | 前台运行（调试用） |
| `logs [-f]` | 实时查看主机日志 |
| `throttle on / off / status` | 切换 Chrome 抗节流启动参数（[懒加载站点](#懒加载--无限滚动站点采不全)用） |
| `uninstall` | 停止并移除服务 |

## 采集服务接口（HTTP API）

所有接口都在 `http://localhost:{port}/api/v1` 下，除 `/health` 外均需 `X-API-Key` 请求头认证。

### 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port=N` / `SCRAPEWRIGHT_PORT` | `8765` | 监听端口（CLI 参数优先） |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API 密钥（生产环境务必修改） |

### 提交任务

```
POST /api/v1/services/{service-name}/execute
```

请求体：`{ "input": { ... } }`（按服务的 inputSchema 传参）

响应（202）：

```json
{ "success": true, "jobId": "xxxxxxxx-xxxx-…", "status": "queued", "queuePosition": 1 }
```

并发请求自动排队，`queuePosition` 是排队位置（0 = 正在执行）。

### 获取结果

```
GET /api/v1/jobs/{jobId}/wait?timeout=120   # 阻塞直到完成（timeout 秒，最大 300）
GET /api/v1/jobs/{jobId}                    # 立即返回当前状态
```

任务完成后的响应（节选）：

```json
{
  "success": true,
  "job": {
    "id": "…", "status": "completed",
    "result": {
      "posts": [
        { "author": "…", "likes": "4", "sourcePageId": "page_0007_a1b2c3d4" }
      ]
    },
    "pages": [ { "id": "page_0007_a1b2c3d4", "url": "…", "title": "…", "html": "…" } ],
    "error": null
  }
}
```

- `result` — 采集到的结构化数据，形状由服务的 outputSchema 决定
- `pages[]` — 采集过程中见过的每个页面（URL、标题、清洗后的 HTML），用于核对数据来源
- `sourcePageId` — 每条提取记录自带此字段，指向其数据来源的页面

### 其他接口

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/v1/jobs/{jobId}/cancel` | 取消排队中的任务 |
| GET | `/api/v1/jobs` | 列出所有任务 |
| GET | `/api/v1/services` | 列出所有服务（含 I/O Schema） |
| POST | `/api/v1/services/{name}/steps` | 为服务添加步骤 |
| PUT | `/api/v1/services/{name}/steps/{stepId}` | 更新步骤（脚本/流程字段） |
| DELETE | `/api/v1/services/{name}/steps/{stepId}` | 删除步骤（链路自动重连） |
| GET | `/health` | 健康检查（免认证，供负载均衡/K8s 探活） |

### 任务状态与错误

| 状态 | 说明 |
|------|------|
| `queued` / `running` | 排队中 / 执行中 |
| `completed` | 成功，结果在 `result` |
| `failed` | 失败，原因在 `error` |
| `cancelled` | 已取消 |

| 错误 | 说明 |
|------|------|
| `ELEMENT_NOT_FOUND` / `SCRIPT_ERROR` | 元素未找到 / 脚本出错 — AI 会自动尝试修复 |
| `SCRIPT_TIMEOUT` | 脚本超时（默认 60s） |
| `LOGIN_REQUIRED` | 目标网站需要登录，登录后重试 |
| `Extension timeout` | 主机连不上扩展 — 检查扩展是否加载、端口是否一致 |

## 故障排查

排查首先查看 Options 页顶部的 **Host Status 卡片**（红色 = 主机不可达），并运行 `./bin/scrapewright doctor`。

### 连不上主机（Disconnected）

1. `./bin/scrapewright status` — 服务是否已安装并运行？
2. Options 页 **Server Configuration** 的端口与安装时是否一致（默认 `8765`）？
3. `./bin/scrapewright doctor` — 完整诊断，多数问题直接给出修复命令。

### 服务无法启动

- **找不到 Node** — 升级/移动过 Node 后重跑 `./bin/scrapewright install` 重写路径
- **端口被占用** — `./bin/scrapewright install --port=N` 换端口（扩展侧同步修改）
- **项目目录移动过** — 在新位置重跑 `install`；doctor 会检测路径漂移

### 查看主机日志

```bash
./bin/scrapewright logs -f                        # 全平台
tail -f ~/Library/Logs/scrapewright/host.log      # macOS
tail -f ~/.cache/scrapewright/host.log            # Linux
```

启动崩溃的完整堆栈在同目录的 `startup-error.log`。

### 懒加载 / 无限滚动站点采不全

后台标签页会被 Chrome 节流，`IntersectionObserver` 懒加载（社交信息流、无限滚动列表）可能不触发。两条措施：

```bash
./bin/scrapewright throttle on    # 把抗节流参数写入 Chrome 启动器
# 完全退出 Chrome 后重启，再正常采集
./bin/scrapewright throttle status  # 确认已生效；throttle off 可撤销
```

同时在 Options → Settings 打开 **Enhanced Scraping Mode**（滚动卡住时发送真实滚轮事件）。五层抗节流机制的原理见[白皮书 §9](docs/technical-whitepaper.md)。

### 代码改了没生效

- 扩展代码 → `chrome://extensions/` 点击扩展卡片刷新图标
- 主机代码 → `./bin/scrapewright restart`

## 核心特性

### 系统价值

- **配置一次，长期复用** — 采集逻辑沉淀为服务，不是每次现写脚本；输入输出有 Schema 约束，调用方无需关心目标网站长什么样
- **登录态零成本** — 复用你已登录的浏览器会话，这是服务器端方案最难复制的能力
- **自愈** — auto-fix 在配置期和运行时都会分析失败原因并重写脚本；网站改版后修复成本远低于重写
- **数据不出本机** — 自部署，LLM 只在配置期接触页面结构（执行期不需要 LLM）
- **非技术用户友好** — 向导式操作 + 可视化元素标注；标注你的意图，AI 按意图生成
- **一专多能** — 同一步骤图引擎也可用作轻量 Web 测试自动化（点击、输入、等待、断言、分支）
- **可扩展** — 需要更高吞吐时支持多实例并行部署（Docker/K8s，见[白皮书 §12](docs/technical-whitepaper.md)）

底层能力一览：跨 iframe 采集、详情页逐条下钻（`$openTab`）、悬浮卡片字段增强（`$extractWithHover`）、流式内容完成检测（`$waitForStable`）、抗混淆稳定选择器、提示词体积防护。脚本 DSL 共 19 个原语，全部由 AI 生成、可手动编辑，详见[白皮书 §7](docs/technical-whitepaper.md)。

### 与其他方案对比

AI 辅助采集主要有四条技术路线。核心区别是**用谁的浏览器**：

| 路线 | 代表 | 浏览器 | 登录态 |
|------|------|--------|--------|
| 服务器端 headless 采集 | Firecrawl、Crawl4AI | 服务器 Chromium | 需注入 Cookie |
| 服务器端 AI agent | Skyvern、Browser-use | 服务器浏览器 | 模拟登录 |
| 开发者编程式 | Claude Code + Playwright | 本机/CI headless | 手动处理 |
| **客户端扩展（本项目）** | **Scrapewright** | **你的日常 Chrome** | **天然复用** |

与同类产品的差异：

| 产品 | 核心差异 |
|------|---------|
| [Firecrawl](https://www.firecrawl.dev/) | 我们复用用户登录态 + 生成可执行脚本（非仅 HTML→Markdown）；本地部署 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | 我们是可视化向导（无需写 Python） |
| [Skyvern](https://www.skyvern.com/) / [Browser-use](https://browser-use.com/) | 我们配置一次成服务可重复调用（vs 每次交互式驱动） |
| [AgentQL](https://agentql.com/) | 我们提供完整多步骤编排 + auto-fix（vs 单点选择器智能） |

**适用于：** 需要登录态的采集（内网 / 付费内容 / SaaS 后台）、非技术人员自定义采集、低频高价值查询（AI 问答、人物/机构信息、知识图谱）、复杂页面（iframe、动态加载、流式输出）。

**不适用于：** 万级 URL 大规模高并发（单浏览器瓶颈，建议使用服务器端方案）、7×24 无人值守（依赖本机 Chrome 运行）、拦截 / Mock 网络请求（建议使用 Playwright / CDP）。

**一句话定位：个人/团队浏览器里的 AI 采集助手——把"打开浏览器 → 登录 → 操作 → 提取"配置成可被程序调用的 HTTP 服务。**

### 典型场景

- **内部数据自动化** — 登录后的管理后台、报表系统，定时拉取关键指标
- **AI 问答采集** — 向各家 AI 提同样的问题，收集回答做评测或知识库
- **列表 + 详情页** — 搜索结果、商品列表逐条打开详情，提取完整字段
- **门户/政府网站** — 深层 iframe 嵌套的公告、公示信息
- **情报与知识图谱** — 人物、机构、话题的低频高价值查询
- **Web 测试自动化** — 用步骤图表达"点击→输入→断言"的回归测试

## 版权与许可证

本项目采用 [**GPLv3**](./LICENSE) 开源。

- 自由使用、修改、分发，包括商业用途
- 分发或以 SaaS 形式部署时，**必须**同时开源你的衍生代码（同等 GPLv3 协议）
- 保留原始版权与许可证声明

完整法律文本见 [`LICENSE`](./LICENSE)。欢迎通过 Issue 报告问题、Pull Request 贡献代码（提交即表示同意以 GPLv3 开源）。

```text
Scrapewright
Copyright (C) 2026 Scrapewright Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```
