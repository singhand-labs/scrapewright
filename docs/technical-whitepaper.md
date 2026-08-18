# Scrapewright 系统技术白皮书

> 版本：0.1.0 | 最后更新：2026-08-18

## 1. 系统概述

Scrapewright 是一个 LLM 驱动的网页数据采集平台，由 Chrome 扩展（Manifest V3）和 Node.js 后台服务（HTTP 服务器）组成。用户通过自然语言描述采集需求，LLM 自动分析目标网页结构并生成采集脚本，在真实浏览器环境中执行，返回结构化数据。

### 设计目标

| 目标 | 实现方式 |
|------|----------|
| **零代码采集** | 自然语言描述 → LLM 生成脚本 → 自动执行 |
| **真实浏览器环境** | Chrome 扩展注入，支持 JS 渲染、iframe、动态加载 |
| **AI 自愈** | 脚本失败时自动捕获 DOM 快照 → LLM 修复 → 重试 |
| **标准 API** | HTTP API 对外服务，异步执行队列，JSON Schema 约束 I/O |
| **可视化操作** | 5 阶段向导流程，元素标注，实时执行日志 |

### 技术栈

- Chrome Extension Manifest V3（Service Worker + Offscreen API + 沙盒 iframe）
- Vanilla JavaScript（无前端框架依赖）
- Node.js >= 18（HTTP 后台服务）
- OpenAI 兼容 API（支持 OpenAI、Moonshot、Kimi、Anthropic、GLM）

## 2. 系统架构

### 2.1 进程架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        外部调用程序                               │
│                    HTTP POST /execute                            │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                   HTTP Host（Node.js 后台服务）                   │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────┐                      │
│  │ HTTP Server  │  │ Extension Poll       │                      │
│  │ (API 路由)   │  │ (长轮询通道)          │                      │
│  └──────┬───────┘  └──────────┬───────────┘                      │
│         └─────────────────┬────┘                                  │
│                           │                                       │
│              sendToExtension() 统一发送接口                       │
│              handleIncomingMessage() 统一接收接口                 │
└───────────────────────────┼──────────────────────────────────────┘
                            │ HTTP 长轮询（双向）
┌───────────────────────────▼──────────────────────────────────────┐
│                   Chrome 扩展 (Manifest V3)                      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │              background.js (Service Worker)                  ││
│  │  ExecutionQueue ── ServiceRegistry ── LLMClient             ││
│  │  StepOrchestrator ── OffscreenExecutor ── AutoFix            ││
│  │  LongPollingClient                                            ││
│  └────────┬──────────────────────┬──────────────────────────────┘│
│           │                      │                               │
│  chrome.tabs.sendMessage   chrome.runtime.sendMessage            │
│           │                      │                               │
│  ┌────────▼──────────┐  ┌───────▼──────────┐                     │
│  │ content-script.js │  │  offscreen.js     │                     │
│  │ (注入目标页面)     │  │  (Offscreen Doc)  │                     │
│  │                    │  │                    │                     │
│  │ ┌──────────────┐ │  │ ┌──────────────┐  │                     │
│  │ │ sandbox.html │ │  │ │ sandbox.html │  │                     │
│  │ │ (eval 沙盒)  │ │  │ │ (eval 沙盒)  │  │                     │
│  │ └──────────────┘ │  │ └──────────────┘  │                     │
│  └──────────────────┘  └───────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 单一通信通道（HTTP 长轮询）

扩展与主机之间仅通过 HTTP 长轮询通信：

- 扩展向 `GET /api/v1/extension/poll` 发起长轮询，主机在收到外部调用请求时通过该响应将任务下发。
- 扩展通过 `POST /api/v1/extension/response` 回传执行结果。

主机以操作系统后台服务形式运行（systemd 用户单元 / launchd LaunchAgent / Windows 计划任务），扩展只需知道主机监听的端口（默认 8765，可通过 `chrome.storage.local` 和 `scrapewright install --port=N` 配置）。

```
外部程序
    |
    | HTTP POST /api/v1/services/{name}/execute
    v
+------------------+                          +------------------+
|  host.js         |   HTTP 长轮询（双向）     |  background.js   |
|  (Node.js        | <-----------------------> |  (Service Worker)|
|   后台服务)       |  /extension/poll          +--------+---------+
|                  |  /extension/response      |                 |
+------------------+                           |                 |
                                               v chrome.tabs.sendMessage
                                               +------------------+
                                               | content-script.js|
                                               +--------+---------+
                                                        |
                                                        | postMessage
                                                        v
                                               +------------------+
                                               | sandbox.html     |
                                               |  (eval allowed)  |
                                               +------------------+
```

**为什么放弃 Native Messaging：** MV3 service worker 在闲置约 5 分钟后被终止，重启后 `chrome.runtime.connectNative` 不能可靠重建连接；Chrome 自身的版本更新会使正在进行的原生连接失效；macOS 上 Homebrew 升级可能挪动 `/usr/local/bin/node`，导致 manifest 中的绝对路径悄无声息地失效；长时间运行后长度前缀 JSON 帧可能漂移，留下看似存活但实际无法传输数据的"僵尸"端口。HTTP 是无状态的，每次 `fetch()` 都是全新请求，对瞬态故障天然容错，可用 `curl` 直接调试，且本地开发与分布式服务部署使用完全相同的协议。

**连接逻辑**（`background.js:initCommunication`）：探测 `GET /api/v1/extension/poll` 端口 → 可达则进入长轮询模式；不可达则标记为已断开，由 `chrome.alarms`（约每 24s）触发的 keepalive 心跳自动重试。

### 2.3 双沙盒设计

MV3 的内容安全策略（CSP）禁止在 Service Worker 和内容脚本中使用 `eval`/`new Function`。为此，系统设计了两个沙盒：

1. **content-script.js 内的沙盒 iframe** — 处理直接注入到目标页面的脚本执行（旧路径，保留兼容）
2. **offscreen.js 内的沙盒 iframe** — 主要执行路径，通过 Offscreen API 创建独立文档

两个沙盒都加载 `sandbox.html`（在 `manifest.json` 中声明为 sandbox page），具有 `eval` 权限。

### 2.4 项目布局

代码仓库的组织结构如下：

```
extension/                # Chrome 扩展 (Manifest V3)
  background.js           # Service Worker — 执行队列、脚本编排、重试、AI 自动修复、长轮询客户端
  content-script.js       # 内容脚本 — DOM 操作代理、元素标注、页面快照
  sandbox.html/js         # 沙盒页面 — eval/new Function 在此执行（MV3 CSP 要求）
  wizard.html/js/css      # 5 阶段 AI 向导 — 服务创建/编辑流程
  options.html/js/css     # 配置页 — LLM 设置、服务管理、执行历史
  popup.html/js           # 弹出窗口
  lib/
    llm-client.js         # LLM 客户端 — 支持 OpenAI/Moonshot/Kimi/Anthropic/GLM
    offscreen-executor.js # 脚本执行器 — Offscreen API 包装，含超时保护
    step-orchestrator.js  # 步骤编排器 — 条件步骤图执行、循环检测、自动重试
    service-registry.js   # 服务注册表 — chrome.storage.local 持久化
    wizard-utils.js       # 向导工具函数 — DSL 指南、JSON 清洗、Schema 渲染
    import-utils.js       # 导入工具函数 — 数据验证、去重过滤
    dom-cleaner.js        # HTML 分层清洗 — cleanPageHtml/cleanHtmlForLLM/extractAnnotationContext
    tab-activation.js     # 粘性激活（sticky tab activation）— 保证抓取标签页产出合成器帧
    scroll-ops.js         # 滚动操作 — $scrollBy/$scrollToBottom + 可信滚轮回退
    renderer-activation.js # 增强抓取模式 — chrome.debugger 可信输入回退
    visibility-keepalive.js # 页面可见性保活 — MAIN world visibilityState 覆盖
    selector-generator.js # 选择器生成 — 短执行选择器与完整 domPath 分离
    annotation-cluster.js # 标注聚类 — 按容器聚类多采样标注
    record-shape-distribution.js # 记录形态分布 — 实证信号优先的字段候选
    debug-logger.js       # 调试日志 — 结构化日志 + 自动清理
    script-executor.js    # 旧版执行器（保留兼容 $openTab）
  test/                   # 扩展单元测试

native-host/              # Node.js HTTP 后台服务
  host.js                 # HTTP 服务器 — 接收外部 API 调用并通过长轮询转发给扩展
  lib/
    service-install/      # 操作系统服务安装（systemd / launchd / 计划任务）
      locate-node.js      # 解析 node 绝对路径（不依赖 PATH）
      linux.js            # 写入 ~/.config/systemd/user/scrapewright.service
      macos.js            # 写入 ~/Library/LaunchAgents/com.scrapewright.host.plist
      windows.js          # 注册计划任务 ScrapewrightHost（PowerShell）
      index.js            # 按 process.platform 派发
    migration.js          # 检测并清理旧版 Native Messaging 产物（manifest / 注册表）
  host.cmd                # Windows 启动包装器
  test/                   # 测试文件
```

### 2.5 Chrome MV3 关键约束

Chrome Manifest V3 对扩展架构施加了多项硬限制，直接影响了系统设计：

| 约束 | 影响 | 应对 |
|------|------|------|
| Service Worker 无法运行 HTTP 服务器 | 扩展无法直接对外暴露 API | 引入 Node.js HTTP 后台服务作为桥接（操作系统服务形式运行） |
| 禁止在 Service Worker 和 Content Script 中使用 `eval`/`new Function` | 无法直接执行用户脚本 | 创建 sandbox iframe（manifest 中声明），在其中执行动态代码 |
| 每个扩展只能有 1 个 offscreen document | 脚本执行环境为单例 | 通过 ExecutionQueue 串行化执行，多实例部署绕过此限制 |
| Service Worker 空闲 ~30s 后可被杀死 | 长轮询循环可能中断 | `chrome.alarms` 每 24s 心跳保活，断连后自动重连 |
| `chrome.storage.local` 上限 10MB | 大量 Job 数据可能超限 | 100 条 Job 上限 + 24h TTL 清理，后续可迁移到 IndexedDB |

## 3. 核心数据流

### 3.1 服务执行流程

```
外部 POST /execute
  → host.js: sendToExtension({type:'EXECUTE', serviceName, input})
  → background.js: handleHostMessage()
    → createJob() → 入队 ExecutionQueue
    → 返回 {jobId, status:'queued'}
  
后台处理:
  → processJob(jobId, serviceName, input)
    → handleExecute()
      → registry.getByName(serviceName)
      → StepOrchestrator.execute(service, input, deps)
        → 创建标签页 → 等待加载
        → 循环执行步骤:
          → OffscreenExecutor.execute(stepScript, input)
            → 确保 Offscreen 文档存在
            → 发送 EXECUTE_SCRIPT_OFFSCREEN 消息
            → offscreen.js 转发到 sandbox iframe
            → sandbox.js: new Function(scriptCode)()
            → $ API 调用发 DOM_REQUEST → content-script.js 执行
            → 结果通过 DOM_RESPONSE 原路返回
            → sandbox.js 发送 EXECUTE_RESULT
            → offscreen.js 转发 SCRIPT_RESULT 回 background
        → 评估条件 → 决定下一步 → 循环
        → 返回 {finalResult, steps}
      → 失败时: tryAutoFixStep() → LLM 修复脚本 → 重试
    → updateJob({status, result/error})
```

### 3.2 $ API 调用链（以 $click 为例）

```
sandbox.js: $click('button.submit')
  → sendDomRequest('click', 'button.submit')
  → parent.postMessage({type:'DOM_REQUEST', action:'click', ...})
  
offscreen.js 接收 DOM_REQUEST:
  → chrome.runtime.sendMessage({type:'DOM_REQUEST', tabId, _fromOffscreen})
  
background.js 接收并转发:
  → chrome.tabs.sendMessage(tabId, {type:'DOM_REQUEST', ...})
  
content-script.js 接收 DOM_REQUEST:
  → handleDomRequest({action:'click', selector:'button.submit'})
  → domClick('button.submit')
    → domQuerySelector('button.submit') — 等待元素出现
    → querySelectorDeep(sel) — 主文档 + 同源 iframe 搜索
    → element.click()
  → 返回 {result: true}
  
content-script.js 发送 DOM_RESPONSE:
  → chrome.runtime.sendMessage({type:'DOM_RESPONSE', id, result, _fromOffscreen})
  
offscreen.js 接收 DOM_RESPONSE (去重后):
  → sandboxIframe.contentWindow.postMessage({type:'DOM_RESPONSE', id, result})
  
sandbox.js 接收 DOM_RESPONSE:
  → pendingDomRequests.get(id).resolve(result)
  → $click() Promise 解决
```

### 3.3 $openTab 详情页采集流程

```
sandbox.js: await $openTab(url, `const title = await $extract('h1'); return {title}`)
  → sendDomRequest('openTab', null, [url, fnString])
  
content-script.js: domOpenTab(url, fnStr)
  → chrome.runtime.sendMessage({type:'OPEN_TAB_EXECUTE', url, script:fnStr, parentTabId})
  
background.js: handleOpenTabExecute(url, scriptStr, parentTabId)
  → chrome.tabs.create({url}) — 新标签页
  → waitForTabLoad() + waitForContentScript()
  → OffscreenExecutor(tabId).execute(wrappedScript, {})
    → [在新标签页中执行脚本]
  → chrome.tabs.sendMessage(parentTabId, {type:'TAB_RESULT', result})
  → chrome.tabs.remove(tabId) — 关闭新标签页
  
content-script.js 接收 TAB_RESULT:
  → __CrawlerBridge__.resolve(result)
  → $openTab() Promise 解决
```

## 4. 核心模块详解

### 4.1 StepOrchestrator（步骤编排器）

**文件：** `extension/lib/step-orchestrator.js`

步骤编排器执行一个有向步骤图。每个步骤包含：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识符（字符串） |
| `name` | 步骤名称 |
| `script` | 要执行的 JavaScript 代码 |
| `condition` | 可选条件表达式（在目标页面上下文中 eval） |
| `onSuccess` | 成功时跳转到的步骤 ID（`'TERMINATE'` 结束） |
| `onFailure` | 失败/放弃时跳转到的步骤 ID（条件为假、重试耗尽、或返回 `{failed:true}`） |
| `maxIterations` | 步骤最大执行次数（默认 1；`>1` 启用轮询/重试：返回 `{done:false}` 时重跑自身） |

> **不再使用 `SELF` 哨兵。** 早期版本用 `onSuccess: 'SELF'` 表达自循环，但其约定反直觉（`{done:true}` 反而走 `onFailure`）。该约定已移除。轮询/重试现在由 `maxIterations>1` + 返回 `{done:false}` 表达；`onSuccess`/`onFailure` 始终指向另一个步骤 ID 或 `TERMINATE`。

**循环检测：** 执行前自动检测步骤图中的环。当某个步骤的 `onSuccess` 指向一个更早的步骤时，环路径上所有步骤的 `maxIterations` 会被自动提升到全局上限（默认 50）。

**安全保障：**
- 全局迭代上限 `maxStepIterations`（默认 50）防止无限循环
- 每个步骤的 `maxIterations` 防止单步无限执行
- `condition` 为 false 时跳过步骤（不计数为失败）
- 脚本执行失败时捕获快照供 AI 修复

**步骤间数据传递：**
- `__lastResult__` — 上一步的返回值
- `__stepResults__` — 所有步骤返回值的字典（按步骤 ID 索引）
- `__input__` — 原始输入参数

### 4.2 ExecutionQueue（执行队列）

**文件：** `extension/background.js`

```
class ExecutionQueue {
  enqueue(jobId, fn) → Promise
  processNext()      → 串行处理下一个
  getQueuePosition() → 查询排队位置
}
```

所有服务执行通过队列串行化。原因：Offscreen 文档使用全局 `tabIdStack`，并发执行会导致 DOM 请求路由错误。

### 4.3 OffscreenExecutor（脚本执行器）

**文件：** `extension/lib/offscreen-executor.js`

封装 Chrome Offscreen API，在独立文档中执行脚本。

```
class OffscreenExecutor {
  constructor(tabId)
  ensureOffscreenDocument()   → 创建 Offscreen 文档
  execute(scriptCode, input)  → 执行脚本，等待结果
  wrapScript(code)            → 包裹为 async IIFE
}
```

**超时机制：** 默认 30s，可配置。超时后发送 `EXECUTE_SCRIPT_TIMEOUT` 清理 offscreen.js 中的 `tabIdStack`。

### 4.4 ServiceRegistry（服务注册表）

**文件：** `extension/lib/service-registry.js`

基于 `chrome.storage.local` 的键值存储，CRUD 操作。

**服务数据模型：**

```typescript
interface Service {
  id: string;           // crypto.randomUUID()
  name: string;         // URL-safe 唯一名称
  displayName: string;  // 可读名称
  targetUrl: string;    // 目标页面 URL
  steps: Step[];        // 步骤数组
  inputSchema: object;  // JSON Schema
  outputSchema: object; // JSON Schema
  annotations: object[];// 用户标注的元素
  config: {
    enabled: boolean;
    timeoutMs: number;  // 默认 30000
    maxRetries: number; // 默认 1
    autoCloseTab: boolean;
  };
}
```

### 4.5 LLMClient（LLM 客户端）

**文件：** `extension/lib/llm-client.js`

OpenAI 兼容接口客户端，支持多个提供商：

| 提供商 | 默认 Base URL |
|--------|---------------|
| OpenAI | `https://api.openai.com/v1` |
| Moonshot | `https://api.moonshot.cn/v1` |
| Kimi | `https://api.moonshot.cn/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| GLM | `https://open.bigmodel.cn/api/paas/v4` |

**配置项**（设置页，存 `chrome.storage.local` 的 `llmConfig`）：

| 配置 | 说明 |
|------|------|
| `provider` / `baseUrl` / `model` / `apiKey` | 提供商选择；自定义 baseUrl 支持任意 OpenAI 兼容网关 |
| `maxOutputTokens` | 每次请求的 `max_tokens` 上限（1024-131072，留空 8192）。生效链：`options.maxTokens ?? maxOutputTokens ?? 8192`（调用点显式传值优先，配置是权威默认） |
| `timeoutMs` | 单次请求超时；默认 `DEFAULT_TIMEOUT_MS=120000` |

**重试策略**（`chatWithRetry`）：可重试的状态码集合 `RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}`；网络失败与超时（AbortError）亦可重试；默认重试 `DEFAULT_MAX_RETRIES=3` 次，指数退避 1s→2s→4s（封顶 8s）+ 0-500ms 随机抖动。

**不可重试类别**（立即上抛，不烧重试预算）：

- `LLMContextOverflow` — `finish_reason` 为 `context_length_exceeded` 类：提示词本身超模型上下文窗口，重试必然同样失败；错误消息指引压缩提示词（去历史、截断 HTML）。
- **空内容 + `finish_reason=length`**（RC55）— 推理型模型把整个 completion 预算烧在产出内容之前的不可见推理上（`completion_tokens` 恰好等于上限、0 字符内容），且随用户调高上限同步增长——确定性失败。错误消息带生效预算，提示调大 Settings 的 `maxOutputTokens` 或换推理开销更低的模型。
- 瞬态空内容（无溢出/length 信号）**仍可重试**。

**其他错误处理：**
- 404 → 提示检查 Base URL 和模型名称
- 401/403 → 提示检查 API Key
- 非 JSON 响应 → 检测并抛出明确错误（可重试）
- 网络错误 → 包含 URL 的错误消息

### 4.6 DOM Snapshot（DOM 快照）

**文件：** `extension/content-script.js:getDomSnapshot()` / `getCompressedSnapshot()`

两种快照模式：

| 模式 | 用途 | 大小 |
|------|------|------|
| **完整模式** | 向导研究阶段，提供完整页面结构给 LLM | 最大 80KB |
| **压缩模式** | AI 自动修复时，提供精简结构 | 通常 < 20KB |

**关键特性：**
- 自动展开同源 iframe 内容（标记 `data-iframe-src`）
- 跨域 iframe 标记为 `[cross-origin iframe]`
- 移除脚本、样式、隐藏元素、导航/侧边栏等噪声
- 属性值截断到 200 字符

### 4.7 service-install（操作系统服务安装）

**文件：** `native-host/lib/service-install/`

提供 Linux（systemd 用户单元）、macOS（launchd LaunchAgent）和 Windows（计划任务）三种服务安装实现，由 `scrapewright install` 子命令调用。

- `locate-node.js` — 解析 `node` 的绝对路径（直接使用 `process.execPath`），不依赖 PATH，避免 Chrome / systemd / osascript 各自不同的 PATH 设置导致的启动失败。
- `linux.js` — 写入 `~/.config/systemd/user/scrapewright.service`，调用 `systemctl --user daemon-reload` + `systemctl --user enable --now scrapewright`，并通过 `loginctl enable-linger <user>` 使用户管理器在系统启动时即运行（而非等到首次登录）。服务文件中设置 `Restart=on-failure`，崩溃后 3 秒内自动重启。
- `macos.js` — 写入 `~/Library/LaunchAgents/com.scrapewright.host.plist`，调用 `launchctl bootstrap gui/<uid> <plist>`。`RunAtLoad=true` + `KeepAlive=true` 确保登录时启动、崩溃后自动重启。
- `windows.js` — 通过 PowerShell `Register-ScheduledTask -Trigger New-ScheduledTaskTrigger -AtLogOn` 注册计划任务 `ScrapewrightHost`，使用 `-LogonType Interactive` 的当前用户身份，无需管理员权限/UAC。设置 `RestartCount 3` + `RestartInterval 1 分钟`。
- `index.js` — 根据 `process.platform` 派发到 `linux` / `macos` / `windows`；不支持的平台抛错并提示使用 `scrapewright run` 前台运行。

每个服务文件在安装时固定三件事：node 的绝对路径、`host.js` 的绝对路径、端口（作为 `--port=N` 参数写入 `ExecStart`/`ProgramArguments`/`-Argument`）。因此 `scrapewright install --port=9123` 产生的服务即被钉死在该端口。安装后服务随用户登录自动启动；崩溃后由 OS 监管器在数秒内重启；用户登出/重启后于下次登录/开机时自动恢复。

### 4.8 migration（迁移安全网）

**文件：** `native-host/lib/migration.js`

检测并移除旧版本安装遗留的 Native Messaging 产物。在 `scrapewright doctor` 或 `scrapewright install` 执行时自动调用，并在终端打印一行通知，从不静默操作。

- `findLegacyArtifacts()` — 探测以下位置：
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/com.scrapewright.host.json`
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.scrapewright.host.json`
  - Windows: 注册表项 `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.scrapewright.host`（通过 `reg query` 探测）
- `removeLegacyArtifacts()` — 逐个删除文件 / 调用 `reg delete /f` 清除注册表项，返回实际移除的文件和键列表，调用方负责打印用户可见的通知。失败项以 best-effort 方式跳过（如文件已被其他进程占用），不阻断主流程。

### 4.9 DebugLogger（调试日志）

**文件：** `extension/lib/debug-logger.js`

结构化日志系统，按日期存储到 `chrome.storage.local`：

- 内存缓冲区：最多 500 条
- 持久化：按日期键存储，每天最多 2000 条
- 自动清理：3 天以上的日志自动删除
- 组件标签：`background`、`content-script`、`sandbox`、`offscreen`、`step-orchestrator`、`wizard`

## 5. 向导系统

**文件：** `extension/wizard.js` + `wizard.html`

5 阶段 AI 向导流程：

| 阶段 | 功能 | 关键函数 |
|------|------|----------|
| 1 | 输入目标 URL + 三项需求，然后 AI 研究 | `startResearch()` → `continueResearch()` |
| 2 | 命名服务 + 查看/编辑步骤图 | — |
| 3 | I/O Schema + 测试输入 | — |
| 4 | 执行测试（逐步） | `runTestFromStep5()` |
| 5 | 查看结果 + AutoFix + 部署 | `confirmDeploy()` |

### AI 研究流程

```
用户描述需求
  → startResearch()
    → 打开目标页面 → 捕获 DOM 快照
    → LLM 分析页面结构 → 返回 {steps, inputSchema, outputSchema, sampleInput}
  → 如果需要标注:
    → continueResearch()
      → 用户标注元素
      → LLM 根据标注优化脚本
```

研究实际由多轮 LLM 调用组成：

1. **页面探索** — 发送分层清洗 + 压缩的 DOM 结构摘要给 LLM，得到候选选择器与页面模型（`buildResearchPrompt`）。
2. **候选选择器发现** — 结合用户标注（annotations）与 DOM 本身的结构信号（`lib/field-candidate-discovery.js` 的字段候选发现）列出候选容器。
3. **基于真实元素 HTML 的选择器确认** — 只取候选元素的完整 HTML 嵌入提示词（`formatElementsForPrompt`，受 §10 的 30K/200K 预算约束），LLM 确认或修正。
4. **步骤脚本生成** — 依据 SCRIPT_DSL_GUIDE + 确认后的选择器生成步骤图。

#### 诊断中继（`_diagnostics`）

DOM 操作原语（`$extractList`/`$extractWithHover`/hover 等）在源头注入 `_diagnostics`（候选池、拒绝原因、picked/considered 等），经 `DOM_RESPONSE` → 编排器 → `summarizeAllStepDiagnostics` 流入 autoFix 提示词——LLM 修复时能看到"选择器为什么没命中"而非只看到空结果。注意中继链上每一跳（offscreen / background）都必须透传该字段，历史上曾有中继跳静默丢弃 `_diagnostics` 的回归。

#### 标注聚类与记录形态分布

- **标注聚类**（`lib/annotation-cluster.js:clusterAnnotationsByContainer`）：多条标注落在同一容器选择器下时聚为多采样结构，`buildAnnotationsText` 把"每条记录的形态"而非逐条孤立的元素交给 LLM。聚类依赖 `annotation.domPath`（完整链，见 §11），不能用会短路的 `selector`。
- **记录形态分布自动优先**（`lib/record-shape-distribution.js`）：从**真实抽取结果**计算每条记录的字段填充签名（递归点路径；空串/null/空数组视为未填充），观察到 2+ 种不同签名时把经验分布反馈给 LLM，让它写真正的形态切换逻辑——而不是依赖用户恰好标注了每种变体，或从 URL 模式瞎猜。

**两轮 HTML 协议：** 为避免截断大页面同时保持 token 效率，研究阶段分两轮进行。第一轮发送压缩的 DOM 结构摘要（~8000 tokens）给 LLM，得到候选选择器；第二轮只获取这些候选元素的完整 HTML，供 LLM 确认或修正。

**元素标注辅助：** 当 LLM 对选择器置信度低于阈值时，自动触发可视化元素标注模式，将用户意图转化为结构化注解，LLM 可直接消费。

### AutoFix 自动修复

脚本执行失败时自动触发，或在阶段 5 由用户带可选提示手动触发。两层函数：`autoFix(userFeedback)` 是编排器；`runFixIteration(userFeedback, config, options)` 执行实际的 LLM 调用与脚本替换。

```
testScript 失败
  → autoFix(userFeedback = null)  // 或从阶段 5 按钮调用 autoFix(feedback)
    → MAX_ATTEMPTS = userFeedback ? 1 : 3   // 静默重试 vs 带提示的一次性修复
    → 重置 wizardState.bestAttempt + dismissedInterventions
    → for attempt in 1..MAX_ATTEMPTS:
        → runFixIteration(...)                       // 构建提示词、调用 LLM、替换步骤脚本
          遇到 LLMContextOverflow → 用精简快照重试一次
        → 用 outputSchema 对当前 testResult.finalResult 评分
        → 若得分 > bestAttempt.score：更新 bestAttempt（含脚本与流程字段）
        → 若 !success：classifyIntervention(...) → 命中则展示横幅并 break
    → 循环退出后：若 bestAttempt.score > currentScore，调用 restoreBestAttempt(bestAttempt)
```

**评分（`scoreAttemptResult`）** 是纯函数，返回 `{ score, breakdown, isData }`：

```
score = requiredCoverage * 100 + listItemCount * 10 + avgFieldsPerItem * 5
```

必填覆盖率为 `outputSchema.required` 中非空字段的比例；列表项数为第一个"对象数组"字段的长度；字段平均填充率为每条记录对内部 schema 的填充程度。保留原始浮点（不取整）以减少平局。`isData: false` 用于短路：对格式错误或非对象结果不更新最佳尝试。

**干预分类器（`classifyIntervention`）** 是纯函数，返回 `{ type, severity, message, uiAction }` 或 null。共 5 种类型，每条规则都由多个信号共同触发以避免误报：

| 类型 | 触发条件 | uiAction |
|------|---------|----------|
| `needs_annotation`（需标注） | 得分=0 + 无标注 + 抽取类错误 | `annotate_step` |
| `needs_annotation_relax`（需放宽标注） | 得分=0 + 已有标注 +（选择器含 `:nth-of-type`/`:nth-child` 或 第 2 次起列表仍为空） | `annotate_step` |
| `needs_login`（需登录） | error 或 lastError 中含 `LOGIN_REQUIRED` | `open_tab` |
| `rate_limited`（被限流） | error 或 lastError 中含 `429` | `open_settings` |
| `page_state_stale`（页面过期） | 第 2 次起 + 同一错误重复 + 快照超过 60 秒 | `refresh_tab` |

候选先按用户已忽略集合过滤，再按内部优先级排序（登录 > 限流 > 过期 > 放宽 > 标注），最可操作的干预获胜。

**回退恢复（`planRestoreBestAttempt`）** 是纯规划函数。输入最佳尝试记录 + 当前 steps + llmHistory，返回步骤补丁（script/onSuccess/onFailure/maxIterations）以及按最佳尝试的 `[Attempt — step "<id>" ("<name>")]` 标记截断后的 llmHistory。运行时包装 `restoreBestAttempt(best)` 负责把补丁应用到 `wizardState.steps`、同步步骤编辑器里的 textarea（以免 confirmDeploy 的 syncStepsFromEditor 覆盖恢复结果），并更新 `#currentScript` 预览。

#### ACK/NACK 协议

当带用户反馈调用时，`runFixIteration` 会通过 `buildFeedbackSection(feedback, attemptNum, totalAttempts, llmHistory)` 在提示词的第 1 节（SCRIPT_DSL_GUIDE 之前）插入一个反馈块。该块要求 LLM 在写任何脚本之前先精确输出以下二者之一：

```
// ACK: <用自己的话复述这条提示>
// NACK: <为什么无法应用，给出具体理由>
```

`cleanLLMResponse` 会剥离开头的协议行（通过 debugLogger 记录以便观测），让下游的代码围栏 / JSON 抽取逻辑能在干净脚本上运行。若同一条提示在 `llmHistory` 中已被 NACK 过两次，反馈块会追加升级提醒："你的页面模型可能错了"。

**限制：** 向导测试循环内最多自动修复 3 轮（静默路径 `MAX_ATTEMPTS=3`，即 3 轮完整的 LLM 修复+测试迭代；带用户反馈 1 轮）。运行时执行的自动修复另受 `config.maxRetries` 约束（默认 1，见 §14）。仅对 `ELEMENT_NOT_FOUND` 和 `SCRIPT_ERROR` 类型错误触发；`LOGIN_REQUIRED` 立即失败。

## 6. HTTP API 详解

**Base URL：** `http://localhost:{port}/api/v1`
**认证：** `X-API-Key` 请求头

### 6.1 请求/响应格式

所有响应均为 JSON。成功时 `success: true`，失败时包含 `error` 字段。

### 6.2 异步执行模型

```
POST /services/{name}/execute  → 202 Accepted, 返回 jobId
GET  /jobs/{id}/wait?timeout=N  → 阻塞直到完成
GET  /jobs/{id}                  → 立即返回当前状态
```

### 6.3 步骤 CRUD（agent-native 对等）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/services/{name}/steps` | 添加步骤 |
| PUT | `/services/{name}/steps/{stepId}` | 更新步骤 |
| DELETE | `/services/{name}/steps/{stepId}` | 删除步骤并**重链接**步骤链 |

外部程序（或 LLM agent）可以在服务上直接增删改步骤。删除并非简单的数组 splice——`removeStepWithRelink` 会把链上指向被删步骤的 `onSuccess`/`onFailure` 边重新接到被删步骤的后续目标，且所有变更都会经 `ServiceRegistry.save` → `validateChain` 再校验（目标存在、无孤儿、无重复 id、无 `SELF`），坏链在保存时即被拒绝而不是静默误执行。

### 6.4 消息传递协议

主机与扩展之间通过 HTTP 长轮询双向通信（无状态）：

- **下发请求：** `GET /api/v1/extension/poll` — 扩展发起长轮询。主机在该连接上阻塞，直到有待处理请求时返回一个完整的请求对象（队列空时按超时返回 `204 No Content`，扩展立即重新发起下一次轮询）。
- **回传结果：** `POST /api/v1/extension/response` — 扩展把执行结果（带 `reqId`）POST 给主机，主机据 `reqId` 唤醒对应的等待者。

请求/响应消息格式（HTTP JSON 体）：

```typescript
// 主机 → 扩展（poll 响应体）
interface HostMessage {
  type: 'EXECUTE' | 'GET_JOB_STATUS' | 'GET_JOBS' | 'GET_SERVICES' | 'CANCEL_JOB';
  reqId: number;        // 请求 ID，用于匹配 response
  serviceName?: string;
  input?: object;
  jobId?: string;
}

// 扩展 → 主机（response 请求体）
interface ExtensionResponse {
  reqId: number;
  success: boolean;
  jobId?: string;
  job?: Job;
  services?: Service[];
  error?: string;
}
```

由于每个 HTTP 请求相互独立，连接不存在"建立/维持/断开"状态机；瞬时故障（service worker 重启、网络抖动、Chrome 版本升级）只会导致单次 `fetch()` 失败，下一次重试即可恢复。

## 7. 采集脚本 DSL

### 7.1 执行环境

脚本在沙盒 iframe 中执行，通过 `postMessage` 与目标页面通信。无法直接访问 DOM。

### 7.2 可用 API（19 个原语）

语义来源：`extension/lib/wizard-utils.js` 的 `SCRIPT_DSL_GUIDE`（LLM 提示词中的权威定义）。

| API | 返回类型 | 说明 |
|-----|----------|------|
| `$(selector)` | ElementData | 等待元素（30s 超时），返回数据对象；找不到则抛错 |
| `$exists(selector, timeoutMs?)` | boolean | 检查**可见**元素是否存在（跳过 display:none/零尺寸），默认 5s；轮询循环用它而非 `$()` |
| `$click(selector)` | boolean | 点击元素 |
| `$type(selector, text)` | boolean | 设置值并派发 input/change；支持 INPUT/TEXTAREA/contenteditable；容器选择器会向下寻找可输入子元素 |
| `$extract(selector, attr?, timeoutMs?)` | string | 提取文本或属性（attr 可为 `outerHTML`/`innerHTML` 等 DOM 属性）；默认 5s 快速失败，不烧 30s |
| `$wait(selector, delayMs?)` | boolean | 等待元素（30s，MutationObserver）+ 可选延迟 |
| `$check(selector, property)` | any | 读取元素属性（如 `checked`） |
| `$openTab(url, fnBody)` | any | 打开新标签页执行函数（详情页采集，旧路径） |
| `$count(selector)` | number | 计数匹配元素（主文档 + 同源 iframe）；禁止配 `:nth-child()` 迭代 |
| `$list(selector)` | ElementData[] | 获取所有匹配元素（含 iframe），用于迭代 |
| `$extractList(containerSel, fieldMap, opts?)` | object[] | **一次调用**抽取记录列表：fieldMap 的每个子选择器在每个容器内求值、取首个匹配；避免逐字段 `$list` 的错位；`opts.allowEmpty` 免抛 `empty list` |
| `$extractListMulti(containerSel, fieldMap, opts?)` | object[][] | 每字段返回**该容器内全部匹配的数组**（`Array<string\|null>`，非元素对象）。仅在 CSS 无法消歧时使用；字段值是数组，必须先 `[0]` 索引再 `.trim()` |
| `$clickInList(containerSel, subSel, opts?)` | `{clicked, errors}` | 在每个容器内点击子元素；默认 `delayMs=500` 等动画沉淀（"先全部展开再抽取"模式） |
| `$waitForStable(selector, opts?)` | boolean | 每 `interval`（默认 1500ms）采样 textContent，连续 `stableChecks`（默认 2）次非空且不变即真；默认 20000ms 超时。流式内容完成检测 |
| `$scrollBy(deltaY, selector?)` | `{scrolled, prevY, newY}` | 滚动窗口或元素 |
| `$scrollToBottom(selector?)` | `{scrolled, prevY, newY}` | 滚到底；`scrolled:false` 表示信息流耗尽。卡住时触发可信滚轮兜底（见 §9） |
| `$scrollIntoView(selector)` | `{found:true}` | 元素滚到视口顶部（reveal "加载更多" 按钮） |
| `$hover(anchorSelector, popoverSelector?, opts?)` | `{hovered, htmlSnippet, popoverSelector, reason?}` | 在锚点中心派发可信 mouseMoved，等待弹层（默认 3000ms）；`opts.index` 用第 N 个匹配（替代 `:nth-of-type` 陷阱）。见 §8 |
| `$extractWithHover(containerSel, fieldMap, opts)` | Record[] | 容器作用域的抽取 + hover 原子原语，见下 |

**`$extractWithHover` 的原子性设计。** 该原语在**同一个容器元素**内完成字段抽取与锚点 hover：对每个容器，抽取 fieldMap 字段（标量，同 `$extractList` 语义），再依次 hover 容器内每个匹配 `opts.hover.anchorSel` 的锚点，把弹层 `htmlSnippet` 附到该记录的 `hovercards[]` 数组上——每项含 `anchorHref`（原始 href，缺省为空串）与 `anchorText`（截断 120 字符），供步骤脚本按"先看 anchorHref"分类弹层实体。之所以做成原语而非让 LLM 手写 `$hover({index:i})` 循环：手写循环用**全局**锚点索引配**逐容器**记录，当各容器锚点数不一致时必然错位（记录 A 配上记录 B 的悬浮卡）——容器作用域让这类错位在结构上不可能发生。`opts.containerIndex` / `containerRange` / `maxContainers` 可把大批量容器切到多个编排器迭代中分摊步骤超时。

### 7.3 ElementData 结构

```typescript
interface ElementData {
  tagName: string;
  id: string;
  className: string;
  textContent: string;  // 截断到 500 字符
  value: string;
  href: string;
  src: string;
  checked: boolean;
  disabled: boolean;
}
```

### 7.4 跨 iframe 支持

所有 `$` API 自动搜索主文档和同源 iframe。`querySelectorDeep` 函数依次搜索：
1. 主文档 `document`
2. 所有 `iframe.contentDocument`（同源）

`$list` 在所有文档中收集元素并合并返回。

**带 iframe 前缀的选择器。** 当页面有多个结构相似的 iframe（如政府/招投标/门户类网站每个 Tab 一个 iframe）时，普通选择器存在歧义。用 `iframe<css>::<inner>` 语法把选择器固定到某个具体 iframe：

```
iframe#iframe1::p > u                       // iframe#iframe1 内的元素
iframe[src="content.html"]::p.MsoNormal      // 通过属性定位 iframe
iframe#iframe1::iframe#iframe2::#deep        // 嵌套 iframe（前缀链式）
```

`<css>` 部分是在父文档中匹配 `<iframe>` 元素的 CSS 选择器；`<inner>` 是在该 iframe 文档中执行的普通 CSS 选择器。所有 `$` API 都支持。标注录制器（`generateSelector` / `getDomPath`）在用户选中 iframe 内的元素时会自动加上此前缀，从而保证标注得到的选择器在抽取时确定地命中正确 iframe。共享逻辑位于 `extension/lib/iframe-selector.js`（作为 content script 在 `content-script.js` 之前加载）。

## 8. 悬浮卡增强（Hover 富采集）

**文件：** `extension/content-script.js` 的 `domHover()` / `hoverDismiss()` 实现+ `extension/lib/renderer-activation.js`（CDP 派发）

许多站点的列表 DOM 只有摘要字段，完整信息（账号简介、实体预览卡）在 hover 悬浮卡里。本章是该子系统的原理性描述，全部常数来自事故驱动调优。

### 8.1 可信事件派发

`domHover` 先把锚点 `scrollIntoView({block:'center'})`（否则折叠下方元素的 bounding rect 是越界坐标，CDP 会打到错误像素），取其包围盒中心，然后经 `withTabActivation('hover', ...)` → `chrome.runtime.sendMessage({type:'TRUSTED_HOVER_REQUEST', x, y})` → background → `RendererActivation` 瞬态挂载 `chrome.debugger`，发 CDP `Input.dispatchMouseEvent({type:'mouseMoved'})`。CDP 输入走 Chrome 的真实输入管线，产生的事件 `event.isTrusted=true`——大量站点的 hover 处理器直接过滤合成事件（`dispatchEvent` 产生的 `isTrusted=false`），这是程序化触发 hover 的唯一可靠途径。每个 CDP 步骤有 `CDP_STEP_TIMEOUT_MS=2000` 的超时包装（防止 detach 状态卡死编排器）。

### 8.2 双通道弹层发现

- **路径 (a) 显式 popoverSelector**：调用方（LLM）命名了弹层容器时直接轮询它（`querySelectorDeep` + `isElementVisible`）。
- **路径 (b) 自动发现**：`MutationObserver({childList:true, subtree:true})` 监听 `document.body`——React Portal / Vue Teleport / Popper / Floating UI 都把弹层渲染为新的 body 级元素。**observer 必须在 hover 派发之前建立**：页面处理器可能在 CDP 往返期间同步挂载弹层，晚启动的 observer 看不到已发生的变更（RC36 教训）。
- **不可见包装层下钻**（RC49）：portal 框架常见"先挂不可见包装 DIV、内容后渲染"。当 pushCandidate 收到不可见的 added 节点时，向下遍历后代（上限 50 个）把可见后代以 `source='added'` 入池——过滤曾错误地在包装层判定可见性，导致 82/116 次迭代空手而归。
- **elementsFromPoint 采样**：仅靠 MutationObserver 会漏掉**预分配**弹层（框架在页面加载时就放好空容器，hover 只切换 CSS 可见性——不产生任何变更记录）。在光标及十字偏移处采样 `document.elementsFromPoint`，以 `source='efp'` 入池。

### 8.3 多信号评分级联

候选先过过滤器（可见性 + 尺寸 + 视口内 + 距光标 ≤600px + 面积 ≤50% 视口 + 基线 diff），再按级联排序取首名。**精确顺序**（RC46 定稿）：

```
source ('added' 优于 'efp') > posAbsolute > z-index > dist > area
```

- **source 排第一**：MutationObserver 缓冲里刚出现的节点是弹层挂载的最强信号，必须无条件压过 efp 采样的既有页面 chrome。曾有真实弹层（`source:'added'`, `posAbsolute:false`）输给既有定位 chrome（`source:'efp'`, `posAbsolute:true`）——RC46 把 source 提到 posAbsolute 之前终结了这类误选。
- **距离上限 600px**（RC41 定 400、RC42 放宽到 600）：通用 UX 性质——悬浮卡总在锚点附近；但 portal 框架常把弹层挂载在光标下方 400-500px（弹层自锚点向下生长，光标在顶部边缘）。496px 处的真实弹层曾被 400 上限拒绝。
- **面积拒绝 >50% 视口**：整屏 backdrop/modal 不是悬浮卡。
- 二次开发调参位置：这些常数全部是 `domHover` 内的局部 `var`（`NO_SIGNAL_EARLY_EXIT_MS`、`600`、`viewportAreaThreshold` 等），改动后同步 `extension/test/` 下的回归测试。

### 8.4 质量门

- **min-dwell 500ms**（`MIN_AUTO_DISCOVER_DWELL_MS`）：评分池在 hover 后的头几百毫秒充满"预存在"噪声（页面 chrome 尚未因 hover 改变），早于 500ms 的 tick 不做路径 (b) 判定。
- **内容三重门**（RC43，路径 a）：`popoverSelector MATCH != 弹层已渲染`。接受要求同时满足：有内容（trimmed 文本 ≥20 字符，`MIN_HOVERCONTENT_TEXT_LEN`）+ 与 T0 基线 outerHTML **不同**（拒绝预分配空壳）+ 稳定（同一元素连续两个 100ms tick 的 `STABILITY_SAMPLE_INTERVAL_MS` 采样 outerHTML 相等——捕捉流式渲染中间态）。
- **efp 基线拒绝**（路径 b）：hover 前 T0 时刻对光标 + 十字偏移处 `elementsFromPoint` 的全部 outerHTML 建立 `Set`；候选 `source!=='added'` 且 outerHTML 命中该集合即拒绝——既有页面 chrome 不能仅凭 position:absolute 赢得级联。
- **无信号早退** `NO_SIGNAL_EARLY_EXIT_MS=1500`（RC47）：真实悬浮卡在 600-1600ms 内挂载；过了 1500ms 既无 MutationObserver 新增又无 popoverSel 可见匹配，则该锚点几乎肯定没有悬浮卡，提前退出而非烧满 3000ms 默认超时——LLM 偶尔写出过宽的 anchorSel（把永久链接、时间戳都匹配上）时，此项把步骤耗时砍掉约一半。结果经 `reason` 字段回传，让 autoFix 能区分"该锚点无悬浮卡"与"等满了超时"。

### 8.5 对称性原则（hover 与 dismiss）

dismiss（把可信光标移到 (1,1) 触发 mouseout 关闭弹层）与 hover 走**同一条 CDP 命令链**，因此必须共享全部基础设施。两次事故各自造成接近 100% 的 dismiss 失败：

- **RC48（超时对称）**：dismiss 路径曾把 CDP mouseMoved + detach 超时压到 500ms，而 hover 用 2000ms——同一命令、同一标签页，结果 98% dismiss 超时。修复：删除覆盖，两侧统一默认 2000ms（`CDP_STEP_TIMEOUT_MS`，勿压回 1500 以下）。
- **RC50（激活对称）**：RC48 之后 dismiss 仍 100% 失败——根因是后台标签不产合成器帧，CDP 输入挂起；hover 路径在 RC20 就包了 `withTabActivation`（见 §9.1），dismiss 路径漏了。修复：dismiss 同样包 `withTabActivation('hoverDismiss', ...)`。

失败的 dismiss 会级联恶化：上一张悬浮卡残留挂载 → 站点抑制后续 hover。原则：**同一 CDP 命令 → 同一基础设施**，任何只改一侧的"优化"都是待发生的事故。

### 8.6 诊断与分类

评分过程经 `notifyBackgroundDiagnostic('hover_auto_discover', {...})` 上报：pool/passing/rejected（含逐节点拒绝原因）/picked/considered（前 3 名）/baselineEfpCount——悬浮卡家族的 bug 可仅凭 SW 日志定位。`$extractWithHover` 的每个 hovercard 条目携带 `anchorHref`（无则空串）与 `anchorText`，DSL 规则教 LLM **优先按 anchorHref 分类**实体类型，再用 `DOMParser` 解析 `htmlSnippet` 分桶。

## 9. 渲染节流对抗栈（五层）

采集标签默认以后台标签方式打开（`chrome.tabs.create({active:false})`），保证不偷用户键盘焦点。对 `IntersectionObserver` 驱动的懒加载站点（社交信息流、无限滚动、虚拟化列表），后台标签会撞上 Chrome 的多层节流/过滤机制。五层叠加方案各自针对不同机制——叠加而非替代：

| 层 | 模块 / CLI | 机制 | 对抗的节流类型 |
|----|-----------|------|---------------|
| 1. visibility-keepalive | `lib/visibility-keepalive.js`（默认开启）| 往页面 MAIN world 注入 `document.visibilityState='visible'` 覆盖 + rAF 保活循环 | 仅页面 JS **自己**检查可见性决定是否继续加载的行为。**不**产生合成器帧 |
| 2. Enhanced Scraping Mode | `lib/renderer-activation.js`（选项页开关，`enhancedModeEnabled` 标志）| 现在只门控第 4 层可信滚轮兜底的可用性。RC20 删除了 `Page.setWebLifecycleState`（RC18 Plan A）——短暂激活（第 5 层）已让生命周期在输入窗口内自然 ACTIVE，该调用变纯开销；标志开启时只发 `Input.*` CDP 命令，绝不发 `Runtime.*`/`Network.*`/`DOM.*`（检测风险最小化） | 输入事件可信度门槛——站点把渲染生命周期降级到 frozen/discard、仅对可信输入恢复交互的行为（历史方案曾直接对抗此层，现由第 5 层激活天然覆盖） |
| 3. Chrome 启动参数 | `scrapewright throttle on\|off\|status`（`native-host/lib/throttle-config/`）| 按平台重写 Chrome 启动器（Linux `.desktop`、macOS 包装 AppleScript 应用、Windows `.lnk`），加 `--disable-background-timer-throttling` `--disable-backgrounding-occluded-windows` `--disable-renderer-backgrounding` `--disable-features=CalculateNativeWinOcclusion` | 渲染端后台节流与原生窗口遮挡计算。需重启 Chrome，全局生效；必要但**不充分**（不解决 `isTrusted` 过滤与帧产出） |
| 4. 可信滚轮兜底（RC19）| `renderer-activation.js:dispatchTrustedWheelScroll` + `scroll-ops.js` | 程序化 `scrollBy` 卡住（scrollHeight 停止增长）时，瞬态挂载 `chrome.debugger`，发 `Input.dispatchMouseEvent` mouseMoved + `mouseWheel`。CDP 输入产生 `isTrusted=true` 的滚轮事件——程序化产生可信滚轮的**唯一**途径。`DEFAULT_MAX_TRUSTED_WHEEL_ATTEMPTS=3`/次调用；中继链 content-script → `TRUSTED_WHEEL_SCROLL_REQUEST` → background → `RendererActivation` | 懒加载 loader 过滤非可信滚轮事件的站点。LLM 照常写 `$scrollToBottom`，基础设施透明兜底——无站点特定逻辑 |
| 5. 粘性激活（RC56）| `lib/tab-activation.js`（默认开启）| 见下 | **唯一**针对帧产出的层：Chrome 硬性架构规则——合成器帧只为焦点窗口的活动标签产出，IO 回调与 CDP `Input.dispatchMouseEvent` 都要求激活 |

### 9.1 粘性激活（RC56）

RC20 的"激活→操作→恢复"在背靠背操作间产生激活/恢复抖动。RC56 改为**激活并保持**（无自动切回）：

- `requestActivation(tabId)` 用 `chrome.tabs.update({active:true})` 切到采集标签并**保持**活动；下一个操作到来时若用户没切走则无需再激活，切走了就重新激活。
- **抑制集合**区分自有激活与用户点击：`chrome.tabs.onActivated` 不带"由谁触发"标志，`TabActivation` 在每次自有 `tabs.update` 前把 tabId 记入 `suppressTabs`（配套 1000ms 安全定时器防事件丢失），命中抑制集合的 onActivated 不更新 `lastUserTabId`。
- **标签关闭落点**：采集标签自动关闭时（`onRemoved`），仅当关闭的标签**是该窗口当时的活动标签**（`activeByWindow` Map 记录每个窗口的最新活动标签）才把焦点落回用户最后点击的标签；目标在别的窗口则再 `chrome.windows.update({focused:true})` 聚焦该窗口。无有效目标时走 Chrome 默认行为。
- **持久化**：状态（`lastUserTabId` + `activeByWindow`）写 `chrome.storage.session`——MV3 SW 可在页面上下文的 LLM 调用期间挂起数分钟，内存态会丢。
- 被包装的操作：`domScrollToBottom`、`domHover`、`hoverDismiss`（`content-script.js` 的 `withTabActivation(label, fn)` 只发 `TAB_ACTIVATION_REQUEST`，粘性模型下无 release 消息）。

关键实现细节：Chrome 会**静默**地把 `"debugger"` 从 `optional_permissions` 剔除（属 `kNonOptionalPermissions` 集合）——`debugger` 权限必须放必需 `permissions`，运行时再用存储标志门控。弹窗窗口路径（RC12/RC17）已在 RC20 删除；`closeScrapeTab` 现为 `chrome.tabs.remove` 的幂等薄包装。

## 10. 长HTML预算与清洗

向导与 autoFix 的提示词都嵌页面 HTML，三层防御控制规模（均源自真实事故）：

1. **分层 HTML 清洗**（`lib/dom-cleaner.js`）：`cleanHtmlForLLM(rawHtml, annotations, budget)` 先剥 script/style/无关节点、截断长文本与属性，再按预算逐级降级；注解上下文抽取（`extractAnnotationContext`）只保留目标元素邻域。LLM 看到的是清洗后的结构，不是原始 outerHTML。
2. **快照预算**（`wizard-utils.js:truncateSnapshotForLLM`，默认 30000 字符；`stripSnapshotsFromTestResult`）：进入 autoFix 上下文的 testResult 先剥掉每步快照再逐次去重（RC9 事故：750K 字符快照绕过 30K 预算直达提示词）。
3. **提示词元素预算**（`wizard-utils.js:formatElementsForPrompt`，RC54）：候选容器元素 HTML 逐个嵌入时，单元素超 `RC54_MAX_ELEMENT_HTML_CHARS=30000` 字符截断并标 `[TRUNCATED]`（开头标签 + 前导子节点已含全部结构信号）；总量达 `RC54_TOTAL_ELEMENTS_BUDGET_CHARS=200000` 后其余元素标 `[SKIPPED: element HTML budget exhausted]`——**选择器仍然列出**（sticky），LLM 至少知道它存在（RC54 事故：容器候选携带整条信息流的原始 outerHTML，单次提示词膨胀到 756,464 token）。

**完成预算链**：`max_tokens = options.maxTokens ?? maxOutputTokens 配置 ?? 8192`（`llm-client.js`）。设置页的 `maxOutputTokens`（1024-131072，留空 8192）是全局权威值。

**不可重试错误分类**（详见 §4.5）：空内容 + finish_reason=length 属确定性失败，直接归类为不可重试，不再烧重试预算。

## 11. DOM 混淆适配（选择器生成）

**文件：** `extension/lib/selector-generator.js`

现代组件框架的 DOM 带大量每次加载都变的自动生成标识，直接当锚会产生"今天能用明天失效"的选择器：

- **自动 id 剔除**（`AUTO_ID_RE`）：`mount_0_0_*`（React 根挂载点，每次加载随机后缀）、`react-aria-:r3:`（React Aria useId）、`headlessui-*`、`r_<数字>_` / `R_x:` 等模式一律不做锚。
- **哈希 class 检测**（`AUTO_CLASS_RE`）：`x` + base36 串（如 `x9f619`）这类 CSS-in-JS 哈希 class 每次构建都变，识别后跳过——注意它们是 base36 而非 hex，正则按字母+数字匹配。
- **叶子 `:nth-of-type` 保留**：走到 body 仍未唯一时，只在**叶子段**（被点击元素本身，而非顶层共享段）追加 `:nth-of-type(N)` 消歧——这是设计取舍，不是遗漏。
- **匿名父级折叠**：向上回溯构造路径时**跳过裸标签段**（无 id/role/aria/data-/语义 class 的纯 `div` 包装层），只用真实锚段并以**后代组合器**（空格，非 `>`）桥接——容忍中间包装层变化。深嵌 portal 标记曾产生 19 段 `> div >` 链（脆弱性评分 115+），折叠后同一元素得到 2 段后代选择器。找到文档内唯一的部分选择器即停止回溯。

**selector 与 domPath 解耦**：`generateSelector(el)` 短、为执行优化（唯一即停——全局唯一的 aria-label 元素路径只有 1 段）；`generateFullDomPath(el)` 无早停、返回到 body 的完整结构链、不附 `:nth-of-type`，供 `clusterAnnotationsByContainer` 做上下文分析（曾因短路丢失父级列表项上下文，多采样聚类静默退化为单采样）。契约：`annotation.selector` 执行用，`annotation.domPath` 分析用。

**LLM 选择器泛化纪律**（DSL 规则）：优先属性**存在性**（`a[data-kind]`）而非字面值匹配；`FIELD COLLISION ON GENERALIZATION`——把选择器泛化到能匹配多种实体时，必须在脚本里加消歧逻辑，否则多类记录字段互相串。

## 12. 配置与部署

### 12.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP 监听端口 |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API 认证密钥 |

### 12.2 Chrome 存储

数据存储在 `chrome.storage.local`：

| 键 | 说明 |
|----|------|
| `services` | 服务列表 |
| `jobQueue` | 任务队列（最多 100 条） |
| `executionLogs` | 执行历史（最多 100 条） |
| `llmConfig` | LLM 配置 |
| `serverPort` | Host 端口号 |
| `debugLogs_YYYY-MM-DD` | 按日期的调试日志 |

### 12.3 Service Worker 保活

MV3 的 Service Worker 会在 30s 无活动后休眠。通过 `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` 每 24s 唤醒一次，检查连接状态并在断开时重连。

## 13. 扩展与二次开发指南

### 13.1 添加新的 $ API

1. **sandbox.js** — 添加 `window.$newApi = (...) => sendDomRequest('newAction', ...)`
2. **content-script.js** — 添加 `case 'newAction':` 处理器和 `domNewAction()` 实现
3. **wizard-utils.js** — 更新 `SCRIPT_DSL_GUIDE` 中的 API 列表
4. **wizard.js** — 如需在向导中使用，更新相关提示词

### 13.2 添加新的 LLM 提供商

1. **llm-client.js** — 在 `getDefaultBaseUrl()` 中添加 case
2. **options.js** — 在 provider 下拉框中添加选项
3. 如果提供商不兼容 OpenAI 格式，需要适配 `chat()` 方法

### 13.3 自定义步骤模板

在 `wizard-utils.js` 的 `STEP_TEMPLATES` 数组中添加新模板：

```javascript
{
  id: 'my-template',
  name: 'My Template',
  description: 'Template description',
  steps: [{ id, name, script, onSuccess, onFailure, maxIterations }]
}
```

### 13.4 修改 DOM 快照策略

`content-script.js:getDomSnapshot()` 控制完整快照，`getCompressedSnapshot()` 控制压缩快照。修改时注意：
- 同步更新 `lib/dom-cleaner.js` 的清洗入口与 `lib/wizard-utils.js` 的快照预算函数（`truncateSnapshotForLLM` / `stripSnapshotsFromTestResult`）
- 保持 `data-iframe-src` 标记约定（LLM 依赖此标记识别 iframe 内容）

### 13.5 调试技巧

1. **开启扩展调试**：在 Chrome DevTools Console 中查看 `[component]` 前缀的结构化日志
2. **查看持久化日志**：在 Console 中执行 `chrome.storage.local.get(null, console.log)` 查看所有存储数据
3. **手动测试脚本**：在向导阶段 2 中直接编辑脚本代码
4. **导出调试数据**：Options 页面可导出服务配置和执行历史

## 14. 已知限制

| 限制 | 原因 | 影响 |
|------|------|------|
| 同时只能执行一个任务 | Offscreen 文档使用全局 tabIdStack | 并发请求排队等待 |
| 无法采集跨域 iframe 内容 | 浏览器同源策略 | 跨域内容不可见 |
| Service Worker 可能休眠 | MV3 限制，30s 无活动 | 通过 alarm 保活，极端情况可能延迟 |
| 自动修复轮数有上限：向导测试循环静默路径最多 3 轮、带用户反馈 1 轮；运行时执行受 `config.maxRetries` 约束（默认 1） | 防止无限重试循环 | 复杂错误可能需要手动修复 |
| 不支持登录态采集 | 无 Cookie 管理功能 | 需要登录的页面需手动登录后执行 |
| 默认 API Key 为 dev-key | 开发便利性 | 生产环境必须设置 `SCRAPEWRIGHT_API_KEY` |
| IO 驱动的懒加载在后台标签上会停住 | Chrome 对非可见标签的渲染端帧产出节流 | 懒加载站点需要 `scrapewright throttle on` + 重启 Chrome（见 §9 渲染节流对抗栈）|

### 14.1 健壮性审计发现

- **悬浮卡时序常数按 portal-hovercard 特性调优**：600px 距离上限与 1500ms 无信号早退（§8.3/§8.4）来自 portal 框架悬浮卡的经验分布（600-1600ms 挂载、光标下方 400-500px）。弹层更远或更慢的站点需要调用方显式传 `popoverSel`（钉住路径 (a)），否则可能被过滤/早退。
- **基线 outerHTML 相等判定**对仅属性变化的重新渲染敏感——同一元素只改属性不改正文时，基线 diff 与稳定性采样都视为"未变"。
- **滚动操作使用固定 network-settle 等待**（`scroll-ops.js` 的 `DEFAULT_SETTLE_MS=350ms` 逐次 sleep）：不等网络空闲，慢速接口的追加内容可能被误判为信息流耗尽。
- **hover 轮询每 100ms tick 序列化候选 outerHTML**：候选池巨大时（大 DOM + 宽 anchorSel）有性能悬崖，仅受 3000ms 默认超时兜底。
- **若干优雅降级路径静默 catch 不留日志**（基线采样、storage 持久化等 best-effort 分支）——故障定位时需对照源码确认这些路径未被触发。

## 15. 开发与贡献

### 运行测试

```bash
# 运行后台服务测试
cd native-host && npm test

# 运行单个测试文件
cd native-host && node --test test/host.test.js

# 运行扩展测试（需要在仓库根目录安装 jsdom）
cd extension && node --test test/*.test.js lib/*.test.js
```

### 前台运行 Host（指定端口，调试用）

```bash
./bin/scrapewright run --port=19880
# 或直接调用 node
cd native-host && node host.js --port=19880
```

前台运行时扩展仍走相同的 HTTP 长轮询协议；请确保扩展 Options 页 **Server Configuration** 中的端口与 `--port` 参数一致（`./bin/scrapewright doctor` 会检测两侧端口不匹配并给出提示）。

### 安装为操作系统服务（推荐的生产部署方式）

```bash
./bin/scrapewright install           # 安装并启动（默认端口 8765）
./bin/scrapewright install --port=9123  # 钉死到自定义端口
./bin/scrapewright status            # 服务状态 + /health
./bin/scrapewright doctor            # 完整诊断
./bin/scrapewright restart           # 修改代码后重启服务
./bin/scrapewright logs -f           # 跟踪日志
./bin/scrapewright uninstall         # 停止并卸载服务
```

服务随用户登录自动启动；崩溃后由 OS 监管器（systemd / launchd / 计划任务）在数秒内重启。`scrapewright doctor` 和 `install` 会自动检测并清除旧版 Native Messaging 产物（manifest 文件 / Windows 注册表项），并在终端打印一行通知。

### 更新代码后重启

修改扩展代码后，在 `chrome://extensions/` 页面点击扩展卡片上的刷新图标即可生效。修改后台服务代码后执行 `./bin/scrapewright restart` 重启服务即可，无需重启 Chrome —— 因为 HTTP 是无状态的，扩展下一次 `fetch()` 就会连上新进程。

**Windows (PowerShell):**
```powershell
# 强制重启服务
./bin/scrapewright restart
```

**Linux / macOS:**
```bash
./bin/scrapewright restart
```
