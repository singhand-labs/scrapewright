# Scrapewright 系统技术白皮书

> 版本：0.1.0 | 最后更新：2026-06-09

## 1. 系统概述

Scrapewright 是一个 LLM 驱动的网页数据采集平台，由 Chrome 扩展（Manifest V3）和 Node.js Native Messaging Host 组成。用户通过自然语言描述采集需求，LLM 自动分析目标网页结构并生成采集脚本，在真实浏览器环境中执行，返回结构化数据。

### 设计目标

| 目标 | 实现方式 |
|------|----------|
| **零代码采集** | 自然语言描述 → LLM 生成脚本 → 自动执行 |
| **真实浏览器环境** | Chrome 扩展注入，支持 JS 渲染、iframe、动态加载 |
| **AI 自愈** | 脚本失败时自动捕获 DOM 快照 → LLM 修复 → 重试 |
| **标准 API** | HTTP API 对外服务，异步执行队列，JSON Schema 约束 I/O |
| **可视化操作** | 7 步向导流程，元素标注，实时执行日志 |

### 技术栈

- Chrome Extension Manifest V3（Service Worker + Offscreen API + 沙盒 iframe）
- Vanilla JavaScript（无前端框架依赖）
- Node.js >= 18（Native Messaging Host）
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
│                   Native Messaging Host                          │
│                     (Node.js 进程)                               │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ HTTP Server  │  │ Native Msg   │  │ Extension Poll       │   │
│  │ (API 路由)   │  │ (stdin/out)  │  │ (长轮询通道)          │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         └─────────────────┼──────────────────────┘               │
│                           │                                      │
│              sendToExtension() 统一发送接口                       │
│              handleIncomingMessage() 统一接收接口                 │
└───────────────────────────┼──────────────────────────────────────┘
                            │ Chrome Native Messaging / HTTP 长轮询
┌───────────────────────────▼──────────────────────────────────────┐
│                   Chrome 扩展 (Manifest V3)                      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │              background.js (Service Worker)                  ││
│  │  ExecutionQueue ── ServiceRegistry ── LLMClient             ││
│  │  StepOrchestrator ── OffscreenExecutor ── AutoFix            ││
│  │  LongPollingClient ── NativeMessagingPort                    ││
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

### 2.2 两条通信通道

Host 与扩展之间有两条通信通道，自动选择：

| 通道 | 触发条件 | 方向 | 协议 |
|------|----------|------|------|
| Native Messaging | Chrome 自动启动 Host | stdin/stdout 管道 | 长度前缀 JSON |
| HTTP 长轮询 | 手动启动 Host | 扩展主动轮询 | HTTP GET/POST |

**选择逻辑**（`background.js:initCommunication`）：
1. 先探测 HTTP 端口（3s 超时）— 如果有已运行的 Host，用长轮询
2. HTTP 不可用 → 尝试 Native Messaging（`chrome.runtime.connectNative`）
3. 两者都失败 → 定时重连（25s keepalive alarm）

### 2.3 双沙盒设计

MV3 的内容安全策略（CSP）禁止在 Service Worker 和内容脚本中使用 `eval`/`new Function`。为此，系统设计了两个沙盒：

1. **content-script.js 内的沙盒 iframe** — 处理直接注入到目标页面的脚本执行（旧路径，保留兼容）
2. **offscreen.js 内的沙盒 iframe** — 主要执行路径，通过 Offscreen API 创建独立文档

两个沙盒都加载 `sandbox.html`（在 `manifest.json` 中声明为 sandbox page），具有 `eval` 权限。

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

### 4.7 Native Messaging（原生消息协议）

**文件：** `native-host/lib/native-messaging.js`

Chrome Native Messaging 协议实现：

```
编码：4 字节小端序长度 + UTF-8 JSON 字节流
解码：状态缓冲区 + 帧分割 + JSON.parse
```

**防护措施：**
- 长度字段超过 10MB 视为损坏，丢弃并重置缓冲区
- JSON.parse 失败时跳过损坏帧，不中断后续消息处理

### 4.8 DebugLogger（调试日志）

**文件：** `extension/lib/debug-logger.js`

结构化日志系统，按日期存储到 `chrome.storage.local`：

- 内存缓冲区：最多 500 条
- 持久化：按日期键存储，每天最多 2000 条
- 自动清理：3 天以上的日志自动删除
- 组件标签：`background`、`content-script`、`sandbox`、`offscreen`、`step-orchestrator`、`wizard`

## 5. 向导系统

**文件：** `extension/wizard.js` + `wizard.html`

7 步 AI 向导流程：

| 步骤 | 功能 | 关键函数 |
|------|------|----------|
| 1 | 输入目标 URL | `loadPage()` |
| 2 | 描述需求 + AI 研究 | `startResearch()` → `continueResearch()` |
| 3 | 标注元素 | `startAnnotationMode()` / `stopAnnotationMode()` |
| 4 | 命名服务 + 查看/编辑脚本 | — |
| 5 | I/O Schema + 测试输入 | — |
| 6 | 执行测试 | `testScript()` / `runTestFromStep5()` |
| 7 | 查看结果 + AutoFix | `updateStep7UI()` |

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

### AutoFix 自动修复

脚本执行失败时自动触发：

```
StepOrchestrator 抛出错误（含 stepId、snapshot）
  → tryAutoFixStep(service, stepId, error)
    → 捕获当前页面 DOM 快照（压缩模式）
    → 构建修复提示词（DSL 指南 + 错误 + 快照 + 原脚本 + 标注）
    → LLM 生成修复后的脚本
    → 替换失败步骤的 script 字段
    → 保存服务 → 重试执行
```

**限制：** 最多重试 `maxRetries` 次（默认 2 次）。仅对 `ELEMENT_NOT_FOUND` 和 `SCRIPT_ERROR` 类型错误触发。

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

Host 与扩展之间的消息格式：

```typescript
// 请求
interface HostMessage {
  type: 'EXECUTE' | 'GET_JOB_STATUS' | 'GET_JOBS' | 'GET_SERVICES' | 'CANCEL_JOB';
  reqId: number;        // 请求 ID
  serviceName?: string;
  input?: object;
  jobId?: string;
}

// 响应
interface ExtensionResponse {
  reqId: number;
  success: boolean;
  jobId?: string;
  job?: Job;
  services?: Service[];
  error?: string;
}
```

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
3. **手动测试脚本**：在向导 Step 4 中直接编辑脚本代码
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
