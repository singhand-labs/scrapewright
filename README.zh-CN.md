# <img src="logo.png" width="44" style="vertical-align:middle" alt="Scrapewright"> Scrapewright

**用自然语言描述网页爬取和信息抽取需求，Scrapewright 把它自动编码为可重复调用的 HTTP 采集服务。**

[English](./README.md) | **简体中文**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Version](https://img.shields.io/badge/version-0.2.0-blue)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

Scrapewright 是一个 **基于大语言模型（LLM）的智能网页数据采集平台**：用自然语言描述"想采集什么"，一个 AI 研究会话会打开目标网页、真实探查其结构、与你确认 I/O 合同、生成采集步骤图并端到端验证，最终部署为长期运行的服务。使用 Scrapewright 开发和部署网页采集与抽取服务，无需学习框架、无需编写 CSS 选择器、无需应对反爬，且网站改版后的维护将变得极其容易。

**Scrapewright 用 AI 开发网页爬虫采集服务**：在向导中用自然语言描述需求，AI 在活动研究会话中打开目标网页、用真实读取探查结构、与你确认 I/O 合同、生成采集脚本并当场试跑——每次诚实的失败都会触发修订。验证通过后，它即成为一个标准 HTTP 接口，供程序、脚本或 AI 智能体调用。**运行时不再调用 LLM**、不消耗 token，经济性和速度远胜于 Agent 驱动浏览器的方式。脚本执行失败时，AI 会分析 DOM 快照并自动修复重试；网站改版后，同样可以再次修复。每个服务还可导出 Markdown 接口文档，供其他 AI 智能体使用。

Scrapewright 以 Chrome 扩展的形式运行在**日常使用的浏览器**中，因而具备三个天然优势：

- **登录态直接复用** — 已登录的网站直接采集，无需配置 Cookie、无需模拟登录
- **页面完整可见** — 浏览器中显示的内容均可采集：JS 动态渲染、iframe 嵌套、翻页、悬浮卡片、延迟加载（lazy render）、节流限制，以及逐条打开的详情页等
- **无自动化痕迹** — 没有 headless 浏览器的指纹特征，请求来自真实浏览器

> **60 秒上手**
>
> 1. `chrome://extensions/` 开启开发者模式 → "加载已解压的扩展程序" → 选择本项目 `extension/` 目录
> 2. `./bin/scrapewright install` 安装后台服务（Windows 用 `.\bin\scrapewright.cmd install`）
> 3. 扩展图标 → Options → Settings 配置 LLM → **+ New Service** → 用一句话描述需求 → 测试 → 部署
>
> 现在任何程序都能调用它：
>
>   提交任务（立即返回 jobId）
> ```bash
> curl -X POST http://localhost:8765/api/v1/services/my-service/execute \
>   -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
>   -d '{"input": {"query": "你好"}}'
> ```
>
>   获取采集结果（阻塞直到完成）
> ```bash
> curl "http://localhost:8765/api/v1/jobs/<jobId>/wait?timeout=120" \
>   -H "X-API-Key: dev-key"
> ```

项目 `examples/` 目录下提供了若干采集脚本样例，可在 Options 页通过 **Import** 导入后直接部署。

此外，本项目还可作为轻量级的 **Web 测试自动化** / 浏览器自动化工具：点击、输入、等待、断言、分支——声明式、可重放、可自愈。

**技术细节**请看[技术白皮书](docs/technical-whitepaper.md)（架构、模块、二次开发指南）与[助手记忆摘要](docs/assistant-memory.md)（设计原则、五十轮事故驱动演化史）。

## 目录

- [背景](#背景)
- [架构速览](#架构速览)
- [系统要求](#系统要求)
- [快速开始](#快速开始) — [安装](#安装) · [创建采集服务](#创建采集服务) · [管理服务](#管理服务) · [调用服务](#调用服务)
- [scrapewright 命令一览](#scrapewright-命令一览)
- [采集服务接口（HTTP API）](#采集服务接口http-api)
- [故障排查](#故障排查)
- [核心特性](#核心特性) — [系统价值](#系统价值) · [与其他方案对比](#与其他方案对比) · [典型场景](#典型场景)
- [版权与许可证](#版权与许可证)

## 背景

传统网页数据抽取工具（Scrapy、Selenium、Puppeteer/Playwright、BeautifulSoup）有共同的痛点：

| 痛点 | 具体表现 |
|------------|--------------------|
| **开发成本高** | 每个网站都要手写选择器、翻页与反爬处理；每次改版维护成本重来一遍 |
| **动态页面难处理** | React/Vue 单页应用、iframe 嵌套、异步加载内容，HTTP + HTML 解析无能为力 |
| **不可复用** | 为 A 站写的爬虫对结构雷同的 B 站毫无帮助 |
| **无统一接口** | 每次采集输入输出形状都不同，编排无从谈起 |

Scrapewright 的思路：**让 AI 在真实浏览器里研究采集逻辑，并把结果标准化为 HTTP 服务。**

- **AI 驱动** — 自然语言描述需求；研究会话编写脚本并在失败时自动修复
- **真实浏览器** — 运行在日常 Chrome 中的扩展，登录态、Cookie、指纹原样复用
- **统一接口** — 输入输出两侧都是 JSON Schema（部署前由你确认）；对外形状永不变化
- **可视化向导** — 三阶段研究优先流程（Requirements → AI Research → Review & Deploy）；非技术用户也能上手

## 架构速览

```
外部程序 ──HTTP──▶ Node.js 后台服务（OS 服务） ──HTTP 长轮询──▶ Chrome 扩展（MV3）
                                                              │
                                    ┌─────────────────────────┤
                                    │ Service Worker：任务队列、步骤编排器、
                                    │ LLM 客户端、自动修复、标签页激活
                                    │
                                    │ Offscreen 文档（沙盒）—— 执行步骤脚本
                                    │        │  $ API 中继
                                    ▼        ▼
                                    │ 采集标签页中的内容脚本（真实 DOM）
```

- **两进程设计**：轻量 Node.js HTTP 后台服务（安装为 systemd / launchd / 计划任务）经无状态 HTTP 长轮询桥接外部调用与扩展——没有脆弱的原生消息连接，可直接 curl 调试，本地与分布式部署协议完全一致。
- **步骤图而非单脚本**：一个服务是命名步骤的小状态机（`onSuccess`/`onFailure` 边、`maxIterations` 轮询），在沙盒 iframe 中对真实页面执行——见[白皮书 §4](docs/technical-whitepaper.md)。
- **20 原语采集 DSL**（`$extractList`、`$extractWithHover`、`$openTab`、`$scrollToBottom`……）——AI 生成、可手工编辑；见[白皮书 §7](docs/technical-whitepaper.md)。
- **研究会话引擎**：向导中的 AI 经工具协议驱动（页面/探针/验证/确认工具），并有接地门约束——没有观察回执的选择器进不了服务工件；见[白皮书 §5](docs/technical-whitepaper.md)。
- **五层反节流栈**保住后台标签的懒加载（可见性保活 → 可信输入模式 → Chrome 启动参数 → 可信滚轮事件 → 粘性激活 + 窗口聚焦强制）；见[白皮书 §9](docs/technical-whitepaper.md)。

## 系统要求

- Chrome 浏览器（最新稳定版）
- Node.js >= 18
- 任一受支持 LLM 提供商的 API Key：OpenAI / Moonshot / Kimi / Anthropic / GLM（按量）/ GLM Coding Plan——或任意 OpenAI 兼容端点。客户端同时支持 Anthropic 原生 Messages 协议与 OpenAI chat/completions 协议（按 Base URL 自动探测）；推荐长上下文模型（如 GLM 5.2）

## 快速开始

### 安装

先下载项目源码，再按以下步骤操作。

#### 1. 加载 Chrome 扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 打开右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目 `extension/` 目录

#### 2. 安装后台服务

后台服务是一个轻量 Node.js 服务，对外暴露 HTTP API。一条命令即可注册为操作系统后台服务——登录自启、崩溃自重启：

```bash
./bin/scrapewright install                    # Linux / macOS，默认端口 8765
.\bin\scrapewright.cmd install                # Windows（PowerShell）
./bin/scrapewright install --port=9123        # 自定义端口（全平台）
```

然后打开 Scrapewright 扩展 → **Options** → **Server Configuration**，确认端口一致（默认 `8765`），点击 **Test Connection**。看到 **Connected** 徽章即安装完成。

#### 3. 配置 LLM

1. 扩展图标 → **Options** → **Settings**（右上角）
2. 在 **LLM Configuration** 下填写：
   - **Provider / Model / API Key** — OpenAI、Moonshot / Kimi、Anthropic、GLM（按量）、或 GLM Coding Plan（同公司第二预设，默认编码套餐 Base URL——套餐配额只在该端点兑现；选择它时原生 Anthropic 车道会自动路由）
   - **Base URL**（可选）— 自定义或 OpenAI 兼容网关；须含路径前缀（如 `https://api.openai.com/v1`）
   - **Protocol**（`auto` / `anthropic` / `openai`，默认 `auto`）— auto 优先原生 Anthropic Messages 协议，端点不支持时回退 OpenAI chat/completions
   - **Max output tokens**（默认 16384）— 推理型模型把预算烧在"思考"上导致输出截断时调大
   - **Timeout**（默认 300 秒）— 慢模型或超长提示词时调大
3. 点击 **Save**

### 创建采集服务

在 Options 页点击 **+ New Service** 进入研究优先的 AI 向导。你看到的是三个阶段；背后是 AI 的活动研究会话：

| 阶段 | 你做什么 |
|-------|-------------|
| **1 · Requirements** | 输入目标 URL + 自然语言需求（输入参数、页面操作、要返回的字段）。确认 AI 对需求的白话复述、回答澄清问题，然后点击 **Research** |
| **2 · AI Research** | 观看实时会话：AI 打开页面、用真实读取探查结构、发现并验证选择器、与你确认 I/O 合同**和测试请求值**（每次测试运行发送的具体输入——同一面板里可编辑）、生成步骤脚本并试跑到绿——每次诚实的失败都会触发修订。你可以随时介入（标注、反馈、合同修订）；回合预算旋钮可让长研究会话跑更久 |
| **3 · Review & Deploy** | 检查验证过的结果（可重跑测试、微调步骤/schema、用自己的话描述问题）。点击部署，服务即开始对外服务 |

<p align="center">
  <img src="docs/phase1.png" width="72%" alt="向导：描述目标与需求">
</p>
<p align="center">
  <em>Requirements 阶段：自然语言描述需求，剩下的交给 AI</em>
</p>

**研究会话实际在做什么。** 这不是一次性生成：向导运行一个可审计的循环——**观察**（DOM 探针、元素标注、选择器诊断）→ **假设**（候选选择器与字段映射）→ **验证**（在新鲜标签上的真实试跑，按你的需求评分，并叠加约 25 个数据驱动的字段检测器：点名**哪几条记录**哪个字段为空的空值指纹、重复 id 与垃圾值普查、相对时间戳检测、超长字段、计数字段隐藏值提示）→ **确认**（I/O 合同与测试请求值在一切落定前展示给你批准——附"变了什么"的可读差异）。AI 的每个论断都必须锚定在它真正从页面上读到的东西上（接地门会拒绝从未被观察过的选择器进入工件）；验证失败时会带着逐字段证据诚实上报，持续修订而不是交出尽力而为的猜测。历史事故沉淀的页面经验存放在可检索的知识库里，检测器看到匹配的失败模式时自动附挂。页面需要登录或其他人机操作时，向导会弹出带对应按钮的横幅。

结果不合预期时，用自己的话描述问题（如"发帖时间缺失"），会话从停下的地方继续——你的反馈折入同一研究循环，而非从零重来。因回合预算停止的会话可以恢复（调大旋钮继续）。引擎内部机制见[白皮书 §5](docs/technical-whitepaper.md)。

<p align="center">
  <img src="docs/phase5.png" width="72%" alt="向导：检查验证结果并部署">
</p>
<p align="center">
  <em>Review & Deploy 阶段：检查验证过的数据，必要时给反馈，然后部署</em>
</p>

### 管理服务

一切都在 Options 页：

- **Enable / Disable** — 启停服务
- **Edit** — 回到向导（预填）
- **API Doc** — 查看 / 下载该服务的 Markdown 接口文档
- **Export / Import / Export All** — JSON 导入导出，跨机器迁移
- **Delete** — 删除服务

页面底部是**执行历史**（最近 20 次：时间、服务、成败）。

### 调用服务

部署后，服务就是一个本地 HTTP 端点。两步：

```bash
# 1. 提交任务（立即返回 jobId）
JOB_ID=$(curl -s -X POST http://localhost:8765/api/v1/services/my-service/execute \
  -H "X-API-Key: dev-key" -H "Content-Type: application/json" \
  -d '{"input": {"query": "无线鼠标"}}' | jq -r '.jobId')

# 2. 等待结果（阻塞直到完成）
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID/wait?timeout=120" \
  -H "X-API-Key: dev-key" | jq '.job.result'
```

**给 AI 智能体调用。** 每个服务都可在 Options 页通过 **API Doc** 按钮导出 Markdown 接口文档。把文档交给 Hermes Agent、WorkBuddy、Lobster 等智能体，让它们自行构建调用该服务的工具或技能。

完整接口细节（参数、状态、错误码、页面记录）：见[采集服务接口（HTTP API）](#采集服务接口http-api)。

## scrapewright 命令一览

`./bin/scrapewright`（Windows：`.\bin\scrapewright.cmd`，命令相同）：

| 命令 | 用途 |
|---------|---------|
| `install [--port=N] [--no-autostart]` | 安装后台服务为 OS 服务并启动 |
| `status` | 服务状态 + `/health` + 端口匹配 |
| `doctor` | 完整诊断（服务、端口、路径漂移、遗留产物） |
| `start` / `stop` / `restart` | 服务控制 |
| `run [--port=N]` | 前台运行（调试） |
| `logs [-f]` | 跟踪主机日志 |
| `throttle on / off / status` | 切换 Chrome 反节流启动参数（用于[懒加载站点](#懒加载无限滚动站点采集不全)） |
| `uninstall` | 停止并卸载服务 |

## 采集服务接口（HTTP API）

所有端点位于 `http://localhost:{port}/api/v1`，除 `/health` 外均需 `X-API-Key` 请求头。

### 配置

| 参数 | 默认值 | 说明 |
|-----------|---------|-------------|
| `--port=N` / `SCRAPEWRIGHT_PORT` | `8765` | 监听端口（命令行参数优先） |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API 密钥（生产环境务必修改） |

### 提交任务

```
POST /api/v1/services/{service-name}/execute
```

请求体：`{ "input": { ... } }`（匹配服务的 inputSchema）

响应（202）：

```json
{ "success": true, "jobId": "xxxxxxxx-xxxx-…", "status": "queued", "queuePosition": 1 }
```

并发请求自动排队；`queuePosition` 是你的队列位置（0 = 执行中）。

### 获取结果

```
GET /api/v1/jobs/{jobId}/wait?timeout=120   # 阻塞直到完成（秒，最大 300）
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

- `result` — 结构化数据，形状由服务的 outputSchema 约束
- `pages[]` — 采集过程见过的每个页面（URL、标题、清洗后 HTML；按 URL+内容去重、有字节预算），用于核对数据来源
- `sourcePageId` — 自动盖在每条抽取记录上，指向其来源页面

### 其他端点

| Method | Path | 用途 |
|--------|------|---------|
| POST | `/api/v1/jobs/{jobId}/cancel` | 取消排队任务 |
| GET | `/api/v1/jobs` | 任务列表 |
| GET | `/api/v1/services` | 服务列表（含 I/O schema） |
| POST | `/api/v1/services/{name}/steps` | 添加步骤 |
| PUT | `/api/v1/services/{name}/steps/{stepId}` | 更新步骤（脚本/流转字段） |
| DELETE | `/api/v1/services/{name}/steps/{stepId}` | 删除步骤（链自动重接） |
| GET | `/health` | 健康检查（免认证；供 LB/K8s 探针） |

### 任务状态与错误

| 状态 | 含义 |
|-------|---------|
| `queued` / `running` | 排队中 / 执行中 |
| `completed` | 成功；结果在 `result` |
| `failed` | 失败；原因在 `error` |
| `cancelled` | 已取消 |

| 错误 | 含义 |
|-------|---------|
| `ELEMENT_NOT_FOUND` / `SCRIPT_ERROR` | 元素缺失 / 脚本错误——AI 会尝试自动修复 |
| `SCRIPT_TIMEOUT` | 脚本超时（默认 60 秒） |
| `POLL_EXHAUSTED` | 轮询步骤重试耗尽；错误消息内嵌最后几次返回值及其节奏，让 AI 区分"页面没有更多了"与"轮询太快没等加载" |
| `LOGIN_REQUIRED` | 目标站点需要登录；登录后重试 |
| `Extension timeout` | 主机联系不上扩展——检查扩展已加载且端口一致 |

## 故障排查

先看 Options 页顶部的 **Host Status 卡**（红色 = 主机不可达），并运行 `./bin/scrapewright doctor`。

### 主机不可达（Disconnected）

1. `./bin/scrapewright status` — 服务是否已安装并运行？
2. Options 页 **Server Configuration** 的端口是否与安装时一致（默认 `8765`）？
3. `./bin/scrapewright doctor` — 完整诊断；多数问题附带修复命令。

### 服务起不来

- **找不到 Node** — 升级/移动 Node 后重新执行 `./bin/scrapewright install` 重写路径
- **端口被占用** — 用 `./bin/scrapewright install --port=N` 换端口（扩展侧同步修改）
- **项目目录被移动** — 到新位置重新 `install`；doctor 会检测路径漂移

### 查看主机日志

```bash
./bin/scrapewright logs -f                        # 全平台
tail -f ~/Library/Logs/scrapewright/host.log      # macOS
tail -f ~/.cache/scrapewright/host.log            # Linux
```

启动崩溃的完整堆栈落在 `host.log` 旁的 `startup-error.log`。

### 懒加载 / 无限滚动站点采集不全

Chrome 对后台/被遮挡标签有节流，`IntersectionObserver` 懒加载（社交信息流、无限滚动列表）即使扩展在滚动时自动激活采集标签也可能停摆。若信息流仍冻结在固定计数：

```bash
./bin/scrapewright throttle on    # 向 Chrome 启动器写入反节流参数
# 完全退出 Chrome 再重新启动，然后正常采集
./bin/scrapewright throttle status  # 验证；throttle off 撤销
```

同时在 Options → Settings 开启 **Enhanced Scraping Mode**（滚动卡住时派发真实滚轮事件）。五层反节流栈的工作原理（含逐操作标签激活与窗口聚焦重断言）：[白皮书 §9](docs/technical-whitepaper.md)。

### 改代码不生效

- 扩展代码 → `chrome://extensions/` 刷新扩展卡片
- 主机代码 → `./bin/scrapewright restart`

## 核心特性

### 系统价值

- **一次配置，永久复用** — 采集逻辑成为服务而非每次重写的脚本；两侧 schema 让调用方永远不关心目标站点长什么样
- **零成本登录态** — 复用已登录的浏览器会话；服务端工具最难复制的一点
- **研究优先、构造性诚实** — 向导 AI 先研究页面再动手，I/O 合同经你确认，测试失败按失败上报（附逐字段证据），绝不交"尽力而为"的猜测
- **自愈** — 配置期与运行期双层 auto-fix 分析失败并重写脚本；改版后"修复"胜过"重写"
- **数据留在本地** — 自托管；LLM 只在配置期看到页面结构（运行期完全不需要）
- **运行期零 token** — LLM 只在配置期研究页面、生成脚本；部署后脚本不再调用 LLM——无 token 成本，又快又省
- **对非技术用户友好** — 向导式 + 可视化元素标注；标注你的意图，AI 据此生成
- **不止采集** — 同一步骤图引擎可作轻量 Web 测试自动化（点击、输入、等待、断言、分支）
- **可扩展** — 需要吞吐时多实例并行部署（Docker/K8s，见[白皮书 §12](docs/technical-whitepaper.md)）

幕后能力：跨 iframe 采集、逐条详情页下钻（`$openTab`）、带隐藏标签解析的悬浮卡字段增强（`$extractWithHover` + ARIA `labelledby` 链）、流式内容完成检测（`$waitForStable`）、抗混淆稳定选择器、审计过度过滤的活体选择器差分、保住后台标签懒加载的五层栈（可信滚轮事件 + 粘性激活 + 窗口聚焦强制）、区分渲染器节流与信息流真耗尽的滚动证据（页面可见性 + 帧采样）、提示词体积护栏。脚本 DSL 共 20 个原语——全部 AI 生成且可手工编辑；见[白皮书 §7](docs/technical-whitepaper.md)。

### 与其他方案对比

AI 辅助采集有四条技术路线。核心问题是**用谁的浏览器**：

| 路线 | 代表 | 浏览器 | 登录态 |
|------|-----------------|---------|-------------|
| 服务端 headless | Firecrawl、Crawl4AI | 服务器上的 Chromium | 需注入 Cookie |
| 服务端 AI agent | Skyvern、Browser-use | 服务器上的浏览器 | 脚本化登录 |
| 开发者编码式 | Claude Code + Playwright | 本地/CI headless | 手动处理 |
| **客户端扩展（本项目）** | **Scrapewright** | **你日常的 Chrome** | **原生复用** |

与同类产品的差异：

| 产品 | 核心差异 |
|---------|-----------------|
| [Firecrawl](https://www.firecrawl.dev/) | 我们复用登录态 + 生成可执行脚本（不止 HTML→Markdown）；本地部署 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | 我们是可视化向导（无需 Python） |
| [Skyvern](https://www.skyvern.com/) / [Browser-use](https://browser-use.com/) | 我们配置一次成为可重复服务（vs 每次交互式驱动） |
| [AgentQL](https://agentql.com/) | 我们提供完整多步编排 + 自动修复（vs 单点选择器智能） |

**适合：** 需登录的采集（内网 / 付费内容 / SaaS 看板）、非技术用户自定义采集、低频高价值查询（AI 问答、人物/机构查询、知识图谱）、复杂页面（iframe、动态加载、流式输出、只在悬浮卡/ARIA 隐藏 span 里存在的字段、节流懒加载信息流）。

**不适合：** 万级 URL 高并发采集（单浏览器瓶颈——用服务端工具）、7×24 无人值守（依赖本机 Chrome 运行）、网络层拦截 / Mock（用 Playwright / CDP）。

**一句话定位：个人/团队浏览器里的 AI 采集助手——把"打开浏览器 → 登录 → 操作 → 提取"变成程序可调用的 HTTP 服务。**

### 典型场景

- **内部报表自动化** — 已登录的管理后台与看板；定时拉取关键指标
- **AI 答案采集** — 向多个 AI 聊天机器人发送相同提示词，收集答案做评测或知识库
- **列表 + 详情页** — 搜索结果/商品列表 + 逐条详情下钻补全字段
- **门户 / 政务站点** — 公告藏在嵌套 iframe 里
- **仅悬浮可得的字段** — 账号/小组预览卡、完整时间戳等只存在于悬浮弹层或 ARIA 隐藏 span 中的值
- **情报与知识图谱** — 人物、机构、话题的低频高价值查询
- **Web 测试自动化** — 步骤图即"点击 → 输入 → 断言"的回归测试

## 版权与许可证

本项目以 [**GPLv3**](./LICENSE) 开源。

- 可自由使用、修改、分发，包括商业用途
- 分发或 SaaS 式部署**必须**以同样 GPLv3 条款开源你的衍生代码
- 保留原版权与许可声明

完整法律文本见 [`LICENSE`](./LICENSE)。欢迎提 Bug 与 PR（提交即表示同意以 GPLv3 发布）。

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
