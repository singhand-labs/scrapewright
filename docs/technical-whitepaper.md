# Scrapewright 系统技术白皮书

> 版本：0.1.0 | 最后更新：2026-07-16

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
    dom-snapshot.js       # DOM 快照 — 压缩结构提取（测试用）
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
    maxRetries: number; // 默认 2
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

**错误处理：**
- 404 → 提示检查 Base URL 和模型名称
- 401/403 → 提示检查 API Key
- 非 JSON 响应 → 检测并抛出明确错误
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

**限制：** 最多 `MAX_ATTEMPTS` 次（静默 3 次，或带用户反馈 1 次）。仅对 `ELEMENT_NOT_FOUND` 和 `SCRIPT_ERROR` 类型错误触发；`LOGIN_REQUIRED` 立即失败。

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

### 6.3 消息传递协议

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

### 7.2 可用 API

| API | 返回类型 | 说明 |
|-----|----------|------|
| `$(selector)` | ElementData | 等待元素（30s 超时），返回数据对象 |
| `$click(selector)` | boolean | 点击元素 |
| `$type(selector, text)` | boolean | 输入文本 |
| `$extract(selector, attr?)` | string | 提取文本或属性 |
| `$wait(selector, delayMs?)` | boolean | 等待元素 + 可选延迟 |
| `$exists(selector, timeoutMs?)` | boolean | 检查元素是否存在（默认 5s） |
| `$check(selector, property)` | any | 读取元素属性 |
| `$list(selector)` | ElementData[] | 获取所有匹配元素（含 iframe） |
| `$count(selector)` | number | 计数匹配元素 |
| `$openTab(url, fnBody)` | any | 打开新标签页执行函数 |

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

## 8. 配置与部署

### 8.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCRAPEWRIGHT_PORT` | `8765` | HTTP 监听端口 |
| `SCRAPEWRIGHT_API_KEY` | `dev-key` | API 认证密钥 |

### 8.2 Chrome 存储

数据存储在 `chrome.storage.local`：

| 键 | 说明 |
|----|------|
| `services` | 服务列表 |
| `jobQueue` | 任务队列（最多 100 条） |
| `executionLogs` | 执行历史（最多 100 条） |
| `llmConfig` | LLM 配置 |
| `serverPort` | Host 端口号 |
| `debugLogs_YYYY-MM-DD` | 按日期的调试日志 |

### 8.3 Service Worker 保活

MV3 的 Service Worker 会在 30s 无活动后休眠。通过 `chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })` 每 24s 唤醒一次，检查连接状态并在断开时重连。

## 9. 扩展与二次开发指南

### 9.1 添加新的 $ API

1. **sandbox.js** — 添加 `window.$newApi = (...) => sendDomRequest('newAction', ...)`
2. **content-script.js** — 添加 `case 'newAction':` 处理器和 `domNewAction()` 实现
3. **wizard-utils.js** — 更新 `SCRIPT_DSL_GUIDE` 中的 API 列表
4. **wizard.js** — 如需在向导中使用，更新相关提示词

### 9.2 添加新的 LLM 提供商

1. **llm-client.js** — 在 `getDefaultBaseUrl()` 中添加 case
2. **options.js** — 在 provider 下拉框中添加选项
3. 如果提供商不兼容 OpenAI 格式，需要适配 `chat()` 方法

### 9.3 自定义步骤模板

在 `wizard-utils.js` 的 `STEP_TEMPLATES` 数组中添加新模板：

```javascript
{
  id: 'my-template',
  name: 'My Template',
  description: 'Template description',
  steps: [{ id, name, script, onSuccess, onFailure, maxIterations }]
}
```

### 9.4 修改 DOM 快照策略

`content-script.js:getDomSnapshot()` 控制完整快照，`getCompressedSnapshot()` 控制压缩快照。修改时注意：
- 同步更新 `lib/dom-snapshot.js`（测试用副本）
- 保持 `data-iframe-src` 标记约定（LLM 依赖此标记识别 iframe 内容）

### 9.5 调试技巧

1. **开启扩展调试**：在 Chrome DevTools Console 中查看 `[component]` 前缀的结构化日志
2. **查看持久化日志**：在 Console 中执行 `chrome.storage.local.get(null, console.log)` 查看所有存储数据
3. **手动测试脚本**：在向导阶段 2 中直接编辑脚本代码
4. **导出调试数据**：Options 页面可导出服务配置和执行历史

## 10. 已知限制

| 限制 | 原因 | 影响 |
|------|------|------|
| 同时只能执行一个任务 | Offscreen 文档使用全局 tabIdStack | 并发请求排队等待 |
| 无法采集跨域 iframe 内容 | 浏览器同源策略 | 跨域内容不可见 |
| Service Worker 可能休眠 | MV3 限制，30s 无活动 | 通过 alarm 保活，极端情况可能延迟 |
| AI 修复最多重试 2 次 | 防止无限重试循环 | 复杂错误可能需要手动修复 |
| 不支持登录态采集 | 无 Cookie 管理功能 | 需要登录的页面需手动登录后执行 |
| 默认 API Key 为 dev-key | 开发便利性 | 生产环境必须设置 `SCRAPEWRIGHT_API_KEY` |

## 11. 开发与贡献

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
