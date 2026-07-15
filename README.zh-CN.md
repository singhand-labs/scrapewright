# <img src="logo.png" width="44" style="vertical-align:middle" alt="Scrapewright"> Scrapewright

**开源、自部署的 AI 网页采集平台 —— 用自然语言生成可被外部程序调用的 HTTP API 采集服务。**

[English](./README.md) | **简体中文**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)

> 由 [湖南星汉数智科技有限公司](https://www.singhand.com) 开发与维护 · 采用 [**GPLv3**](./LICENSE) 开源协议发布

Scrapewright 是一个 **基于大语言模型（LLM）的智能网页数据采集平台**，也是一个 **AI 网络爬虫**：用自然语言描述"想采集什么"，LLM 会自动分析目标网页、生成采集脚本、在真实的 Chrome 浏览器中执行，并返回结构化 JSON 数据 —— 无需手写 CSS 选择器，无需维护 Playwright / Puppeteer 爬虫代码。同一套步骤图（step-graph）引擎还可作为轻量级的 **Web 测试自动化** / 浏览器自动化工具：点击、输入、等待、断言、分支，声明式、可重放、可自愈。

项目以 **Chrome 扩展（Manifest V3）** + 轻量级 **Node.js Native Messaging Host** 双层架构实现，**直接在真实浏览器中执行 —— 这是它处理"难啃"页面的核心优势**：重 JS 的 SPA 单页应用、异步加载（XHR / fetch / 流式）的内容、深层嵌套的同源 iframe、以及复杂的多步交互（翻页、详情页逐条下钻、弹窗关闭、登录流程）都能完整渲染 DOM、正常运行，且没有 `navigator.webdriver` 痕迹。已有的登录态、Cookie、浏览器指纹直接复用，因此需要登录的网站、有反爬检测的网站都能"开箱即用"。每个采集服务都通过统一的 **REST / HTTP API** 对外暴露，输入输出均有 JSON Schema 约束，可便捷集成到任意后端系统、数据管道、RPA 流程或 AI 智能体（Agent）工作流中。

**典型场景：** 需要登录态的网站采集（企业内网、付费内容平台、SaaS 后台）、AI 对话机器人回答采集、列表分页 + 详情页逐条采集、iframe 嵌套的政府/门户类网站、低频高价值查询、知识图谱构建、Web 测试自动化，以及面向非技术用户的无代码数据提取。

技术白皮书：**[中文](docs/technical-whitepaper.md)** · [English](docs/technical-whitepaper.en.md)

> ### 快速开始
>
> 在 `chrome://extensions/` 页面加载本项目的 `extension/` 目录（开启"开发者模式"→"加载已解压的扩展程序"）后：
>
> ```bash
> ./bin/scrapewright setup --auto     # 自动探测扩展 ID、安装 Native Host、自检
> ```
>
> 然后点击扩展图标 → **Options** → 配置 LLM（支持 OpenAI / Moonshot Kimi / Anthropic / GLM 智谱）→ **+ New Service** → 用自然语言描述采集需求 → 测试 → 部署 → 即可在任意程序中调用：
>
> ```bash
> curl -X POST http://localhost:8765/api/v1/services/my-service/execute \
>   -H "X-API-Key: $SCRAPEWRIGHT_API_KEY" -H "Content-Type: application/json" \
>   -d '{"input": {"query": "你好"}}'
> ```

## 目录

- [背景：为什么需要 Scrapewright](#背景为什么需要-scrapewright)
- [核心功能](#核心功能)
- [系统要求](#系统要求)
- [安装](#安装) · [启动方式](#启动方式) · [故障排查](#故障排查--常见问题)
- [HTTP API](#http-api) · [采集脚本 DSL](#采集脚本-dsl)
- [与其他方案的对比](#与其他方案的对比)
- [分布式部署](#分布式部署) · [技术架构要点](#技术架构要点)
- [版权与许可证](#版权与许可证)

## 背景：为什么需要 Scrapewright

传统的网页采集工具和浏览器自动化框架 —— Scrapy、Puppeteer、Playwright、Selenium、BeautifulSoup、Cheerio —— 都有几个共同痛点，让网页数据提取比想象中更难：

1. **开发成本高** — 每个目标网站都需要手写 CSS 选择器、处理翻页、应对反爬，维护成本随网站变化不断累积
2. **动态页面难以处理** — SPA 框架（React / Vue / Angular）、iframe 嵌套、JavaScript 动态渲染的内容，传统基于 HTTP 请求或简单 HTML 解析的方式难以覆盖
3. **难以复用** — 针对每个网站的采集脚本都是定制的，无法快速迁移到结构类似的页面，给网站 A 写的爬虫帮不到网站 B
4. **缺乏统一接口** — 不同采集任务之间没有标准化的输入输出格式，难以编排、调度和扩展

Scrapewright 的应对之道 —— 这也是它作为 **AI 网页采集器**的根本不同：

- **AI 驱动**：用户只需用自然语言描述"要什么"，LLM 自动分析页面结构、生成采集脚本、遇到错误自动修复。可以理解为"浏览器里的 AI 智能体"，但发生在配置时而非运行时
- **真实浏览器环境**：基于 Chrome 扩展，在完整的浏览器中执行，天然支持 JavaScript 渲染、iframe 穿透与动态加载，没有 headless 浏览器的指纹特征
- **标准化 API**：所有采集服务通过统一的 HTTP API 调用，输入输出均有 JSON Schema 约束。无论目标网站多复杂，对外接口形状始终一致
- **可视化无代码向导**：5 阶段向导流程，从描述需求到测试部署全程可视化，非技术人员也能搭出一个采集服务


## 核心功能

| 功能 | 说明 |
|------|------|
| **AI 脚本生成** | 输入目标 URL + 自然语言描述，LLM 自动分析页面并生成采集脚本 |
| **多步骤编排** | 支持条件分支、循环、翻页、详情页逐个采集等复杂采集流程 |
| **跨 iframe 采集** | 自动搜索并采集同源 iframe 中的内容（如政府网站的嵌套公告页面） |
| **详情页深度采集** | `$openTab` API 支持打开列表中每个条目的详情页，逐个提取结构化数据 |
| **AI 自动修复** | 脚本执行失败时，自动捕获 DOM 快照、分析错误、LLM 重写脚本并重试 |
| **元素标注意图** | 可视化标注页面元素 + 意图（点击/输入/提取/等待），指定等待条件（出现/消失/内容稳定）和输出字段映射，让 LLM 直接使用用户意图而非猜测 |
| **服务管理** | 导入/导出、启用/禁用、编辑已有服务、一键导出 Markdown API 文档（方便分享和喂给 AI 智能体） |
| **统一运维 CLI** | `./bin/scrapewright` 命令（setup/doctor/status/restart/logs/id），自动检测扩展 ID，免手抄 |
| **异步执行队列** | 并发请求自动排队，异步返回结果，适合批量采集场景 |

## 系统要求

- Chrome 浏览器（最新版）
- Node.js >= 18

## 安装

### 1. 加载 Chrome 扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角**"开发者模式"**
3. 点击**"加载已解压的扩展程序"**，选择本项目的 `extension/` 目录
4. 加载成功后，记下扩展卡片上显示的 **Extension ID**（如 `dmbnejooocdfjmnebpglhedhfcgncgdl`），下一步安装 Native Host 需要用到

### 2. 安装 Native Messaging Host

> **推荐：一键安装。** 项目根目录的统一 CLI 会自动从 Chrome 探测扩展 ID（无需手抄 `chrome://extensions/`）、安装 Native Host 并自检：
> ```bash
> ./bin/scrapewright setup --auto
> ```

`scrapewright` 命令一览（完整说明见 `./bin/scrapewright help`）：

| 命令 | 作用 |
|------|------|
| `scrapewright setup --auto` | 自动探测扩展 ID + 安装 + 自检（新设备首选）|
| `scrapewright status` | 查看 host 进程、连接状态、ID 是否与 manifest 一致 |
| `scrapewright doctor` | 完整诊断（node/manifest/wrapper/path-drift）+ /health 探测 |
| `scrapewright restart` | 杀掉 host；native 模式下需在扩展 Options 点 Reconnect 让 Chrome 重新拉起（改 host.js 后用）|
| `scrapewright logs -f` | 实时查看 host 日志 |
| `scrapewright id` | 探测当前扩展 ID 并检查与 manifest 是否漂移 |
| `scrapewright uninstall` | 卸载 Native Host |

> Windows 用 `.\bin\scrapewright.cmd ...`（命令相同）。下方 `install-host.sh` / `install-host.ps1` 是底层脚本，CLI 内部调用它们；CI 或需要手动控制时可直接使用。

Native Messaging Host 是一个 Node.js 进程，负责在 HTTP API 和 Chrome 扩展之间桥接通信。

**Linux / macOS:**

```bash
cd native-host
npm install
./install-host.sh <extension-id>
```

示例：
```bash
./install-host.sh dmbnejooocdfjmnebpglhedhfcgncgdl
```

**Windows (PowerShell):**

```powershell
cd native-host
npm install
.\install-host.ps1 -ExtensionId "<extension-id>"
```

> **注意：** `<extension-id>` 必须填写实际的 Extension ID，不支持通配符。可在 `chrome://extensions/` 页面查看。

安装脚本会在系统中注册 Native Messaging Host：
- Linux/macOS: 写入 `~/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json`
- Windows: 写入注册表 `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.scrapewright.host`

> **重要：** Native Messaging 的 manifest 会记录 `host-launcher` 的**绝对路径**。请务必在你日后实际运行/开发的项目目录中执行安装；如果之后**移动或重命名了项目目录**（例如从下载的 `scrapewright-master` 解压目录迁出到固定位置），必须重新运行一次 `./install-host.sh <extension-id>`（Windows：`.\install-host.ps1 -ExtensionId <id>`），否则 Chrome 仍会启动旧目录里过期的 Host，表现为"Native Messaging 一直连不上、扩展静默回退到长轮询"。可用 `./install-host.sh --doctor`（Windows：`.\install-host.ps1 -Doctor`）自检。

安装完成后**重启 Chrome**（或在扩展 Options 页的 Native Host Status 卡片点 **Reconnect**）。

### 3. 配置 LLM

1. 点击扩展图标 → 进入**服务管理（Options）**页面
2. 点击右上角 **Settings** → 在 **LLM Configuration** 区域填写：
   - **Provider**：选择 LLM 提供商（OpenAI / Moonshot / Kimi / Anthropic / GLM）
   - **Model**：模型名称（如 `gpt-4o`、`kimi-for-coding`、`glm-5.1`）
   - **API Key**：你的 API 密钥
   - **Base URL**（可选）：自定义 API 地址，适用于公司中转站或兼容 OpenAI 格式的代理。注意需要包含路径前缀（如 `https://api.openai.com/v1`），不要只填域名
3. 点击 **Save**

### 4. 创建采集服务

在 Options 页点击 **"+ New Service"**，进入 AI 向导（5 个阶段）：

| 阶段 | 说明 |
|------|------|
| **阶段 1：目标 URL 与需求** | 输入目标网站 URL，并填写三项需求——输入参数、页面操作与采集数据、（可选）输出结构。每个字段都有内联的示例提示。点击 **Research**（或 Ctrl+Enter），AI 分析页面并生成草稿服务。如需辅助，页面内会展开交互式探索/标注面板。 |
| **阶段 2：服务名称与步骤** | 设定服务名称，查看并**编辑** AI 生成的步骤图（每个步骤是一段脚本，带成功/失败转移）。 |
| **阶段 3：I/O Schema 与测试输入** | 确认输入输出参数格式（JSON Schema），编辑测试输入数据。 |
| **阶段 4：执行测试（逐步）** | 实时查看逐步执行日志（打开页面 → 加载 → 每个步骤 → 成功/失败）。 |
| **阶段 5：结果** | 查看测试结果。失败时可 **Auto-Fix**（AI 自动修复）或 **Deploy Anyway**（忽略错误部署）。 |

### 5. 管理服务

在 Options 页的 **Services** 区域：

- **Enable/Disable** — 一键切换服务启用状态
- **Edit** — 回到向导编辑服务（预填充已有配置）
- **Export** — 导出单个服务为 JSON 文件
- **Export All** — 导出所有服务
- **Import** — 从 JSON 文件导入服务（自动跳过重复项）
- **Delete** — 删除服务

Options 页底部显示 **Execution History**（最近 20 条执行记录），包含时间、服务名、成功/失败状态。

## 启动方式

Host 支持两种通信模式：**Native Messaging**（Chrome 自动启动）和 **HTTP 长轮询**（手动启动）。两种模式自动切换，无需额外配置。

### 模式 A：Native Messaging（推荐）

完成第 2 步安装后，Chrome 启动时会自动通过 Native Messaging 协议连接 Host，无需手动操作。

### 模式 B：手动启动（HTTP 长轮询）

如果 Native Messaging 不可用（未安装、安装失败、或需要手动控制），可以手动启动 Host，扩展会自动通过 HTTP 长轮询连接：

```bash
# 使用默认端口 8765
cd native-host && node host.js

# 指定端口（需与扩展 Options 页 Server Configuration 中设置的端口一致）
cd native-host && node host.js --port=19880

# 或通过环境变量指定端口
SCRAPEWRIGHT_PORT=19880 node host.js
```

启动后会看到：
```
[ScrapewrightHost] Startup diagnostics:
  Mode: HTTP Long-Polling (manual start)
  Extension should connect to: http://localhost:19880/api/v1/extension/poll

Scrapewright host listening on port 19880
  Waiting for extension to connect via long-polling...
  Ensure extension settings use port 19880
```

> **注意：** 手动启动时，确保扩展 Options 页 **Server Configuration** 中的端口号与 `--port` 参数一致。扩展会在 Native Messaging 断开后自动切换到长轮询模式。

## 故障排查 / 常见问题

**症状：** 扩展提示 "Native host has exited"，或 Native Messaging 一直不工作、Host 日志出现 `native stdin closed WITHOUT ever receiving an extension message` / `Falling back to poll mode`。

1. **最常见原因：移动了项目目录。** Native Messaging 的 manifest 存的是安装时的**绝对路径**。把项目从 `~/Downloads/scrapewright-master` 搬到 `~/projects/scrapewright` 后，Chrome 仍在启动旧目录里过期的 `host.js`，与新扩展不兼容，stdin 立刻关闭。解决：在新目录中重新运行 `./install-host.sh <extension-id>`（Windows：`.\install-host.ps1 -ExtensionId <id>`）。

2. **运行诊断：**
   ```bash
   cd native-host && ./install-host.sh --doctor        # macOS / Linux
   .\install-host.ps1 -Doctor                          # Windows
   ```
   重点关注 `path points into current host dir` 检查项 —— 它会比对 manifest 里的路径与当前脚本所在目录，发现漂移会直接给出修复命令；同时会实际启动一次 wrapper（smoke test）验证 node 路径与 host.js 能正常初始化。

3. **查看 Host 日志：**
   ```bash
   tail -f ~/Library/Logs/scrapewright/host.log      # macOS
   tail -f ~/.cache/scrapewright/host.log            # Linux
   Get-Content -Wait "$env:LOCALAPPDATA\scrapewright\host.log" -Tail 20   # Windows
   ```
   日志出现 `mode: native messaging (Chrome-launched)` 后**没有**紧跟 "closed WITHOUT ever receiving" 即为正常连接。启动崩溃（logger 初始化前）会写到同目录的 `startup-error.log`，对应 Chrome 的 "Native host has exited"。

4. **不想重启 Chrome 时：** 在扩展 Options 页的 **Native Host Status** 卡片点击 **Reconnect** 按钮即可触发重新连接（比重启 Chrome 轻）。修改 Host 代码后仍需重启 Chrome 或重新加载扩展。

## HTTP API

所有执行均为**异步**模式。调用后立即返回 `jobId`，通过状态查询或等待接口获取结果。并发请求自动排队，同一时刻只有一个任务在执行。

### 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port=N` | `8765` | HTTP 监听端口（CLI 参数） |
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP 监听端口（环境变量，CLI 参数优先） |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API 认证密钥 |

也可以在扩展 Options 页的 **Server Configuration** 区域动态修改端口（修改后立即生效，无需重启）。

### 认证

所有外部 API 请求需携带 `X-API-Key` 请求头。

### 接口列表

#### 提交执行任务

```
POST /api/v1/services/{service-name}/execute
```

请求体：
```json
{ "input": { "query": "你好" } }
```

响应（202 Accepted）：
```json
{
  "success": true,
  "jobId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "queued",
  "queuePosition": 1
}
```

> 并发请求会自动排队，`queuePosition` 表示在队列中的位置（0 = 正在执行）。

#### 等待结果（阻塞）

```
GET /api/v1/jobs/{jobId}/wait?timeout=120
```

长轮询直到任务完成。`timeout` 单位为秒，最大 300，默认 120。

响应（任务完成后）：
```json
{
  "success": true,
  "job": {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "completed",
    "result": { "thinking": "...", "answer": "..." },
    "error": null,
    "queuePosition": 0,
    "createdAt": 1717700000000,
    "startedAt": 1717700001000,
    "completedAt": 1717700015000
  }
}
```

#### 查询任务状态

```
GET /api/v1/jobs/{jobId}
```

响应格式与 `/wait` 相同，但不阻塞，立即返回当前状态。

#### 取消任务

```
POST /api/v1/jobs/{jobId}/cancel
```

仅可取消排队中的任务（`status: "queued"`）。

#### 列出所有任务

```
GET /api/v1/jobs
```

#### 列出所有服务

```
GET /api/v1/services
```

响应：
```json
{
  "success": true,
  "services": [
    {
      "name": "baidu-chat",
      "displayName": "百度AI对话",
      "targetUrl": "https://chat.baidu.com",
      "enabled": true,
      "inputSchema": { ... },
      "outputSchema": { ... }
    }
  ]
}
```

#### 健康检查

```
GET /health
```

无需 API Key 认证。用于负载均衡器、K8s 健康检查或调度平台探活。

响应：
```json
{
  "status": "ok",
  "extensionConnected": true,
  "queueLength": 0,
  "queueRunning": false,
  "uptime": 3600
}
```

| 字段 | 说明 |
|------|------|
| `status` | `"ok"` = 扩展已连接，`"degraded"` = 扩展未连接 |
| `extensionConnected` | 扩展是否通过 Native Messaging 或长轮询连接 |
| `queueLength` | 排队中的任务数 |
| `queueRunning` | 是否有任务正在执行 |
| `uptime` | Host 进程运行秒数 |

### curl 示例

```bash
# 提交任务
JOB_ID=$(curl -s -X POST http://localhost:8765/api/v1/services/my-service/execute \
  -H "X-API-Key: dev-key" \
  -H "Content-Type: application/json" \
  -d '{"input": {"query": "你好"}}' | jq -r '.jobId')

echo "Job ID: $JOB_ID"

# 等待结果（阻塞直到完成）
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID/wait?timeout=60" \
  -H "X-API-Key: dev-key" | jq .

# 或手动轮询状态
curl -s "http://localhost:8765/api/v1/jobs/$JOB_ID" \
  -H "X-API-Key: dev-key" | jq '.job.status'
```

### 任务状态

| 状态 | 说明 |
|------|------|
| `queued` | 排队中，等待执行 |
| `running` | 正在执行 |
| `completed` | 执行成功，结果在 `result` 字段 |
| `failed` | 执行失败，错误信息在 `error` 字段 |
| `cancelled` | 已取消 |

### 错误类型

| 错误 | 说明 |
|------|------|
| `ELEMENT_NOT_FOUND` | 目标元素未找到，AI 会自动尝试修复脚本 |
| `SCRIPT_ERROR` | 脚本执行出错，AI 会自动尝试修复脚本 |
| `SCRIPT_TIMEOUT` | 脚本执行超时（默认 60s） |
| `LOGIN_REQUIRED` | 目标网站需要登录，需用户手动登录后重试 |
| `Extension timeout` | Host 无法连接到扩展 — 检查扩展是否已加载、端口是否匹配 |

## 采集脚本 DSL

用户脚本在沙盒 iframe 中执行，通过异步 API 与目标页面交互：

| API | 说明 |
|-----|------|
| `$(selector)` | 等待元素出现（最长 30s），返回元素数据 |
| `$click(selector)` | 点击元素 |
| `$type(selector, text)` | 输入文本（支持 INPUT、TEXTAREA、contenteditable） |
| `$extract(selector, attr?)` | 提取文本内容或属性值 |
| `$wait(selector, delayMs?)` | 等待元素出现后可选延迟 |
| `$exists(selector, timeoutMs?)` | 检查元素是否存在（轮询场景推荐） |
| `$check(selector, property)` | 读取元素属性（如 `checked`） |
| `$list(selector)` | 获取所有匹配元素（含同源 iframe） |
| `$count(selector)` | 计数匹配元素 |
| `$openTab(url, fn)` | 打开新标签页并执行函数体，返回结果 |

脚本可访问：
- `__input__` — 外部调用传入的参数
- `__stepResults__` — 所有步骤的返回值字典
- `__lastResult__` — 上一步的返回值

## 与其他方案的对比

当前 AI 辅助的网页采集/浏览器自动化主要有四类技术路线。Scrapewright 的定位是**客户端扩展**路线，与其他三类互补而非替代。

> **客观前提**：所有方案都需要浏览器。区别在于**用谁的浏览器**——Scrapewright 复用用户日常使用的 Chrome（含登录态/Cookie/指纹），其他方案通常使用单独部署的 headless/服务器端 Chromium（干净 Profile）。

### 四类路线

| 路线 | 代表产品 | 运行位置 | 登录态处理 |
|------|---------|---------|-----------|
| **服务器端 headless 采集** | Firecrawl、Crawl4AI、Spider | 服务器上的 Chromium | 需注入 Cookie 或提供 auth token |
| **服务器端 AI agent** | Skyvern、Browser-use | 服务器上的浏览器 | 自动化登录（表单填充 + 验证码识别） |
| **开发者编程式** | Claude Code + Puppeteer/Playwright | 开发者本机或 CI 服务器 | 手动处理（Cookie 注入/登录脚本） |
| **客户端扩展（本项目）** | **Scrapewright** | 用户日常使用的 Chrome | **天然复用用户已登录的会话** |

### vs CDP + AI 编程（Claude Code / Cursor + Puppeteer/Playwright）

开发者可以用 Claude Code 等 AI 编程工具，为目标网站编写 Puppeteer/Playwright 爬虫程序。这是最灵活的方案，但两者的工作模式和适用场景不同：

| 维度 | Scrapewright | CDP + AI 编程 |
|------|---------------|--------------|
| **使用方式** | AI 向导配置一次 → HTTP API 服务，长期复用 | 每个网站编写/维护一份代码 |
| **谁能用** | 非技术用户（向导式标注 + 生成） | 需要开发者 |
| **浏览器** | 用户日常 Chrome（共享 Profile/登录态/指纹） | headless 或单独 Chromium（干净 Profile） |
| **登录态** | 直接复用用户已登录会话，零额外成本 | 需注入 Cookie / 写登录脚本 / 处理验证码 |
| **反爬检测** | 扩展内容脚本，无 `navigator.webdriver` 痕迹 | CDP 可被 `navigator.webdriver` 等指纹检测 |
| **灵活性** | 步骤图 DSL（结构化，覆盖大多数采集逻辑） | 任意代码（最灵活，可拦截/Mock 网络请求） |
| **可维护性** | auto-fix（脚本失败时 LLM 自动修复选择器和逻辑） | 代码维护（Claude Code 可辅助，但需人工 review） |
| **部署** | 用户本机 Chrome + 轻量 Node.js host | 服务器 Node + Chromium |
| **并发** | 单浏览器串行（水平扩展需多实例） | 多 headless 实例并行 |
| **适合场景** | 低频高价值、需登录态、非技术用户可用 | 大规模、灵活逻辑、开发者团队、CI/CD 集成 |

**Scrapewright 的优势**：配置一次即成服务（非每次写代码）+ 登录态天然复用 + 非技术用户可用 + auto-fix 自愈合。
**CDP + AI 编程的优势**：代码完全灵活 + Git 可版本控制 + 服务器端高并发 + 精细网络层控制。

### vs 同类 AI 采集产品

| 产品 | 类型 | 运行位置 | 登录态 | LLM 角色 | 与 Scrapewright 的核心差异 |
|------|------|---------|--------|---------|---------------------------|
| **[Firecrawl](https://www.firecrawl.dev/)** | 托管 API | 云服务器 | 需提供 Cookie/token | LLM 提取结构化数据 | 我们复用用户登录态 + 生成可执行步骤图脚本（非仅 HTML→Markdown 提取）；本机部署（数据不出本地） |
| **[Crawl4AI](https://github.com/unclecode/crawl4ai)** | 开源 Python 库 | 服务器（Playwright） | 支持传 Cookie | LLM 提取为 Markdown | 我们是客户端扩展 + AI 向导（非技术可用 vs 需 Python 开发者） |
| **[Skyvern](https://www.skyvern.com/)** | AI agent | 服务器 | 自动化登录（表单+验证码） | LLM 驱动每步操作 | 我们是配置式 HTTP 服务（vs 交互式 agent）；复用真实登录态（vs 模拟登录） |
| **[Browser-use](https://browser-use.com/)** | AI agent | 服务器 | 手动 | LLM 实时驱动浏览器 | 我们配置一次成服务可重复调用（vs 每次交互式驱动） |
| **[AgentQL](https://agentql.com/)** | 智能 selector API | 服务器 | 需处理 | LLM 选择元素 | 我们提供完整步骤图编排 + auto-fix（vs 单点 selector 智能） |

> 以上信息基于各产品 2025–2026 年公开文档。产品功能迭代快，建议交叉验证最新状态。

### Scrapewright 的客观定位

**擅长（推荐使用）：**
- **需要登录态的采集** —— 企业内部系统、付费内容平台、个人账户数据。用户已登录的浏览器直接用，零登录成本（这是最大的差异化，Skyvern 需模拟登录、Firecrawl 需注入 Cookie、CDP 需写登录脚本）
- **非技术用户自定义采集** —— AI 向导配置（可视化标注元素意图），HTTP API 服务化，不用写代码
- **低频高价值查询** —— AI 问答结果采集、机构/人物信息查询、知识图谱构建。不是大规模爬取，是特定查询的自动化
- **复杂页面结构** —— iframe 嵌套（如政府公告）、动态加载、流式内容（AI 回答的 `$waitForStable`）

**不擅长（推荐用其他方案）：**
- **大规模高并发采集**（万级 URL）—— 单浏览器瓶颈，用 Firecrawl / Crawl4AI / CDP 多实例
- **7×24 无人值守** —— 依赖用户 Chrome 运行，用服务器端方案
- **精细网络层控制** —— 拦截/Mock 请求、自定义 header，用 CDP（Puppeteer/Playwright）

**一句话定位**：Scrapewright 不是通用爬虫引擎，而是 **"个人/团队浏览器里的 AI 采集助手"** —— 把"打开浏览器 → 登录 → 操作 → 提取"这个重复劳动，配置成可被外部程序调用的 HTTP 服务。它最擅长需要登录态、低频高价值、非技术用户也想做的采集场景。

## 分布式部署

Scrapewright 支持多实例并行部署，通过独立的 Chrome Profile 实现实例间完全隔离。核心思路：**零扩展改造**，N 个独立 Chrome 实例各用独立 Profile、独立端口。

### 架构

```
调度平台
  ├── POST localhost:8760/api/v1/services/{name}/execute  → 实例 0
  ├── POST localhost:8761/api/v1/services/{name}/execute  → 实例 1
  └── POST localhost:8762/api/v1/services/{name}/execute  → 实例 2
```

每个实例拥有独立的 Chrome Profile（Cookie/登录态）、独立的 host.js 进程、独立的执行队列。

### 为什么不改扩展内部并发？

Chrome MV3 限制每个扩展只能有 **1 个 offscreen document**（脚本执行环境），这是平台级硬限制。扩展内部并发需要重写整个脚本执行路径，成本极高。而多 Profile 方案利用 Chrome 原生的多进程能力，每个实例完全独立，无需改动任何扩展代码。

### 本地多实例部署

```bash
# 1. 编辑配置
vim deploy/config.yaml

# 2. 启动 5 个实例
cd deploy && ./scrapewright-manager.sh start

# 3. 查看状态
./scrapewright-manager.sh status

# 4. 停止所有实例
./scrapewright-manager.sh stop
```

配置项（`deploy/config.yaml`）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `basePort` | `8760` | 起始 HTTP 端口（实例 N 使用 basePort+N） |
| `baseDebugPort` | `9220` | 起始 Chrome 远程调试端口 |
| `instances` | `5` | 实例数量 |
| `headless` | `false` | 无头模式（不需要登录态时设为 true） |

### Docker / K8s 部署

```bash
# 构建镜像
docker build -f deploy/Dockerfile -t scrapewright .

# K8s 部署
kubectl apply -f deploy/k8s.yaml

# 扩容到 10 个实例
kubectl scale deployment scrapewright --replicas=10
```

K8s 中每个 Pod 运行 1 个 Chrome + 1 个 host.js，通过 `/health` 端点做存活和就绪探针。调度平台通过 `scrapewright.default.svc.cluster.local:8765` 访问。

### 需登录态的网站

- **本地部署**：有头模式启动 Chrome → 人工登录目标网站 → Cookie 持久化到 Profile 目录
- **K8s 部署**：将已登录的 Profile 打包为 PersistentVolume，挂载到 Pod

### 吞吐量参考

| 实例数 | 吞吐量 | 内存需求 |
|--------|--------|---------|
| 1 | ~2 任务/分 | 2GB |
| 5 | ~10 任务/分 | 8GB |
| 10 | ~20 任务/分 | 16GB |
| K8s 20 Pod | ~40 任务/分 | 按节点分配 |

## 技术架构要点

Scrapewright 建立四大支柱之上：**三层桥接架构**（外部程序 → Node.js HTTP Host → Chrome 扩展 → 目标页面），绕过 MV3 对 Service Worker 运行 HTTP 服务器的禁令；**步骤图编排引擎**（`StepOrchestrator`）执行一个有向步骤图，支持条件跳转、轮询/重试预算与跨步骤数据传递；通过单一的 offscreen 托管 iframe 实现**沙盒脚本执行**（在 MV3 CSP 下允许 `eval`/`new Function`）；Host 与扩展之间采用**双通道传输**（Native Messaging + HTTP 长轮询自动回退）。AI 驱动的脚本生成、步骤级自动修复与可视化元素标注构建于这些支柱之上。

完整的架构、数据流、模块参考、文件目录布局、Chrome MV3 约束表与开发/贡献指南详见 [技术白皮书](docs/technical-whitepaper.md)。


## 版权与许可证

本项目采用 [**GNU General Public License v3.0**](./LICENSE)（GPLv3）开源协议发布。

### 使用须知

- ✅ **允许**：自由使用、复制、修改、分发本程序，包括商业用途
- ✅ **允许**：将本项目整合到更大的系统中
- ⚠️ **义务**：任何分发或公开部署**必须**同时提供完整的源代码
- ⚠️ **义务**：修改后的版本**必须**以相同协议（GPLv3）开源，并标注修改说明
- ⚠️ **义务**：保留原始版权声明与许可证声明

> 简而言之：**你可以免费用、可以拿去卖钱、可以二开，但只要分发（含 SaaS 形式的网络服务部署），就必须同样开源你的衍生代码。**

完整法律文本见根目录 [`LICENSE`](./LICENSE) 文件。GPLv3 官方说明：<https://www.gnu.org/licenses/gpl-3.0.html>

### 开发者

**湖南星汉数智科技有限公司**
官网：<https://www.singhand.com>

### 贡献

欢迎通过 Issue 报告 Bug 或提出功能建议。提交 Pull Request 即表示您同意将贡献内容按 GPLv3 协议开源。

```text
Scrapewright
Copyright (C) 2026 湖南星汉数智科技有限公司

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```

