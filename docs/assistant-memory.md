# Scrapewright 助手记忆摘要（Assistant Memory Digest）

> 生成时间：2026-09-10 | 对应 HEAD：`f70a218`（第五十日志修复）| 测试：2455/2455
>
> 本文档是 Claude Code 助手在长期协作中沉淀的持久记忆的**整理输出**：协作原则、架构决策史、五十轮实战日志的失败模式与修复脉络。它既是项目演化史的索引，也是新会话/新贡献者的"为什么代码长这样"指南。对应的完整技术描述见[技术白皮书](technical-whitepaper.md)。

---

## 1. 协作铁律（用户原则，长期有效）

这些是用户在长期协作中明确确立的原则，优先级高于一切默认行为：

| 原则 | 内容 | 出处 |
|------|------|------|
| **通用性原则** | 一切改进/修复必须是基础设施级方案，禁止站点特化。代码守卫：`facebook\|twitter\|linkedin\|tiktok\|reddit\|instagram\|weibo\|zhihu\|douyin\|\bfb\b` 等令牌不得出现在提示词/lint/知识单元中（universality 测试强制） | 2026-08 起反复重申 |
| **分析工具优先于说教** | 多开发分析函数（检测器、探针、普查）供研究循环调用，优先于在提示词里写规则说教。运行时证据 > 静态规则 | 2026-09-01 ResearchSession 重构决策 |
| **绝不对真实用户文件做测试** | CLI/安装类改动先用临时目录验证（temp-home FIRST），绝不拿用户 live 配置当自测对象 | 安装器事故 |
| **提交不带 Co-Authored-By** | 用户是唯一作者，commit 信息永不添加 Claude 署名尾注 | 用户明确指示 |
| **页面证据慷慨预算** | LLM 要推理的页面证据给足预算：head+tail 双端保留并披露被切长度，聚合用条数控——勿单阈值硬截断 | 第三十九日志 |
| **正确执行优先于用户焦点** | 采集会话运行期间，自动激活目标标签页、必要时抢占窗口焦点是**被授权的**（用户在正常使用电脑可能切走，需要时自动切回） | 第四十九日志用户原话授权 |
| **标识符 typo 先于理论** | 遇 ReferenceError 先逐字符 diff 拼写再谈根因（曾把自造 typo 误诊为 V8 bug 烧一小时） | 2026-08 |
| **API 响应无框架遥测** | `GET /jobs/{id}` 只返回业务数据（曾移除 steps 字段）——外部调用方不需要框架内部细节 | 用户指示 |
| **反馈逐问题闭环** | 带用户反馈的修复，finish 摘要必须逐条回应反馈中的每个问题，不许"绿了就收场" | 第四十日志 |
| **一次多修，勿挤牙膏** | 日志复盘要求"举一反三、全面检查、争取一次把问题都解决"——根因同类的要一并修 | 第四十九/五十日志 |

---

## 2. 架构决策史（RC1–RC65 精要，按主题）

### 2.1 渲染节流对抗栈（六次复发才找到根因）

| 阶段 | 决策 | 教训 |
|------|------|------|
| RC12 | 后台标签 IO 节流 → popup 窗口方案 | GNOME 上 popup 自动抢焦点 |
| RC13 | MAIN-world `visibilityState` 覆盖 + rAF 保活 | 只管页面 JS 自查，不产合成器帧 |
| RC17 | popup + 立即焦点恢复（帧产出层需要活动标签） | 焦点偷取代价高 |
| RC18 | `Page.setWebLifecycleState`（Plan A）失败 | 生命周期层 ≠ 帧产出层；`debugger` 权限必须放必需 permissions（Chrome 静默剔除 optional） |
| RC19 | **可信滚轮兜底**：CDP `Input.dispatchMouseEvent` mouseWheel 是程序化产生 `isTrusted=true` 滚轮的唯一途径；站点过滤合成事件 | MV3 注入毛刺 → 内联镜像模式 |
| **RC20** | **架构定型**：短暂激活活动标签强制帧产出，`lib/tab-activation.js` 诞生；删除 popup 路径 | 第六次复发的根因是"帧只为活动标签产出"这一 Chrome 硬规则 |
| RC56 | 粘性激活（用户首个设计请求）：激活并保持，替代 activate/restore 抖动；`chrome.storage.session` 防 SW 挂起丢态 | |
| RC64 | `$openTab` 子标签在 `waitForTabLoad` 前激活——外壳挂载≠内容渲染 | |
| 49th log | **窗口聚焦强制**：tab 激活≠窗口聚焦（最小化/遮挡/他窗口）；隔离世界读真实 `visibilityState`/`hasFocus` 作证据通道（自己的 MAIN-world 保活骗不了自己的仪表）；滚动/点击家族全量补激活覆盖 | |

### 2.2 悬浮卡管线（十二次迭代）

RC33（`$hover` 原语+CDP 中继）→ RC34（`opts.index` 而非 `:nth-of-type`）→ RC36（observer 先于派发）→ RC38（多信号评分取代硬过滤）→ RC39（elementsFromPoint 采样捕预分配弹层）→ RC40（backdrop 面积>50% 拒绝）→ RC41（min-dwell 500ms + 通用 400px 距离帽）→ RC42（400→600px）→ RC43（内容三重门：MATCH≠RENDERED）→ RC46（级联定稿 source>posAbsolute>z>dist>area）→ RC47（3000ms 无信号早退）→ RC48/50（**对称性原则**：同一 CDP 命令→同一基础设施，dismiss 与 hover 的超时/激活必须同步）→ 42nd-45th（labelledbyText 停留期收割；派发失败早退；游标持久池+tick 熔断）。

### 2.3 诊断中继与证据链

- 选择器诊断在**源头**注入（`$extractList` 等），经 DOM_RESPONSE → offscreen → sandbox → autoFix 提示词全链透传；中继跳曾静默丢 `_diagnostics`（RC2/RC3），现由 vm+JSDOM 回归钉死。
- 零匹配时的**活体选择器差分**（尾部 `:not()`/`:has()` 逐子句剥离计数）把"选择器错"从猜测变证据（25th log）；命中路径的**条款成本普查**是其补集（44th）。
- 滚动证据（49th）：`pageState` + `frameSample`（~300ms rAF 采样）区分 renderer 门控与真耗尽。

### 2.4 执行模型与 DSL

- 步骤图（onSuccess/onFailure 边 + maxIterations 轮询）取代 SELF 哨兵；`validateChain` 全程把关（孤儿/重复/SELF 拒绝保存）。
- 20 原语 DSL：读（$/count/list/extract/check/exists/wait/labelledby）、交互（click/type/clickInList/waitForStable）、列表（extractList/extractListMulti/**extractWithHover**）、滚动（scrollBy 内层容器回退/scrollToBottom/scrollIntoView）、hover、`$openTab`。
- **probe↔DSL 信封对齐**是反复出事故的不变量（32nd RC-C labelledby 对象；48th multi:true 数组）。
- 内联镜像纪律：list-extract-ops / scroll-ops 在 content-script 内有防御性副本，drift-guard 测试钉住两份同步（RC8/RC35/RC19-fu 三次事故后建立）。

### 2.5 LLM 集成

- 双线协议（OpenAI chat/completions + Anthropic Messages），auto 按 Base URL 探测；Claude Code agent 客户端签名让编码套餐通道正确分类流量（34th）。
- 网关 HTTP-200 错误信封按**体语义**解码（35th）；计费类 429/余额错误立即失败并给补救（34th）。
- maxTokens 纪律：每次向导对话必带（RC52 事故：136,953 token 无 maxTokens → length+空）；空+length 不可重试（RC55）；glm 尾部退化以 `finish_reason:"stop"` 发半截 JSON——宽松解析链按体恢复。
- 宽松 JSON 解析器（4 起事故语料）：repairCommonJsonMistakes → 截断感知 → CODE_BEARING_KEYS → 末段引号感知重写。

### 2.6 ResearchSession 引擎（2026-09-01 重构）

用户决策："autofix 期望一次交互得到正确结果不符合 research 逻辑"。重构为：规则手册→可检索知识库；探查代码→工具函数；DSL 语义进提示词、其余在研究中发现；杜绝无观察依据的盲猜（spec §8）。四库（session-persistence/live-rail/verify-runner/session-tools）+ research-session 引擎回路 + 17 工具袋 + 接地门 + 发现台账 + 知识库。wizard.js 3839→1560 行薄壳。

---

## 3. 五十轮实战日志战役（console.log 复盘流水）

每轮：用户更新 `docs/console.log`（含 result.json），用 systematic-debugging 流程做根因分析→一次多修→测试→文档→campaign commit。测试从 1628 增长到 2455。

| 轮 | 主导失败 | 修复要点 |
|----|---------|---------|
| 1 | 五缺口（P-A~P-E） | 引擎首战基建补齐（6ba8690） |
| 2 | D1/D2/D3 | 实战验证前修 ✓ |
| 3 | glm 未转义引号 | F1-F3 宽松解析强化（ed71710） |
| 4 | 自然语言 schema 致盲 verify | G1-G4（b71f906） |
| 5 | D4 截断×2（no-json 零证据） | H1-H3（d6c0e1f） |
| 6 | grounding 死锁三叠加 | 用户复盘三项（0218d88） |
| 7 | 60 轮无配速研究到死 | J1-J3 预算通告（c20ce99） |
| 8 | **首次完整完成**（43/60） | K1 verify report 226K 泄漏（cd95994） |
| 9 | 续修继承耗尽预算+字面量页 | M1-M4（412c3ef） |
| 10 | io.confirm 首战✓；false-green junk | N1-N3 junkValues 检测器（9c760f0） |
| 11 | 修复栈全面验证✓（score 201.6） | O1 规则6 锚定过泛化（bdde76c） |
| 13 | Mode B 种群分歧+跨窗口激活饿死 | FIELD_MATCH_ZERO+规则8（9daff27+bef3c48） |
| 14 | 429 下 resume 四层门全拒 | 缺冒号 JSON 修复+INPUT_VALUE_SUSPECT 换值重测（7a6c07b） |
| 15 | 反爬乱序 time 字段"best-effort"绿 | 规则10 混淆文本+属性兜底（8a3a313） |
| 16 | 部分空字段绿 ship | PARTIAL_EMPTY_FIELDS 全链（38558d0） |
| 17 | $openTab 信封泄漏（day-one）+无字段 schema 双门放行 | 五修（618d4d4） |
| 18 | 末轮工件双截断→会话被清空 | 续接拼接+四门放行+AD_MARKER 极性（a691af2） |
| 19 | typeless-items 假绿+合成 index 掩护+429 风暴 | 用户三改进（3711525） |
| 20 | 语法错死亡螺旋四根因 | SYNTAX_ERROR 定位器/bag 检测器/执行模型教学（17210e8） |
| 21 | 确认合同永不落地三死锁 | 五修+diag.read（f8eaeda） |
| 22 | 假绿 ship：修订挪出 required+200 slice 旁路 | 两修（d4fefc3） |
| 23 | $exists 可见性门×无门读取不对称 | 假值证伪诊断+count 普查（5605d71） |
| 24 | 时间戳 tooltip 永不渲染×暖研冷验×verify 吞 debug | 三修（3761326） |
| 25 | 尾部 :not() 猜测清空种群×检测器被 error 门禁 | 活体差分+$labelledby 第 20 原语（3bcba5a） |
| 26 | **首次双段成功**（40+14） | REQUIRED_FIELD_EMPTY 门+回执引号折叠（13a84c9） |
| 27 | v7 落地即 finish 从未验证 | 单记录假绿+llm:length 宽限重试（162967a） |
| 28 | postingTime 三连红盲猜冷页 | resultPreview 管道可见性（abaaaf4） |
| 29 | timeMapSize 仪器被头切销毁 | head+tail 预览（8a77dae） |
| 30 | $count 无 await 烧 14 轮 | Promise 比较永假×结构谎言（439c3ea） |
| 31 | 时间字段盲区烧 15 轮+3s 自缩 probe | 四修（bf6d3ef） |
| 32 | 转录层平切致盲+probe↔DSL 信封不对称 | 三修（ac16aec） |
| 33 | 反爬诱饵 blob 当 postingTime | 四修 D1-D4（6f82384） |
| 34 | 智谱 429 反转：配额在编码通道 | 余额 429 立即失败+Anthropic auto 优先（6bb031b） |
| 35 | 旧构建未重载+网关 HTTP-200 信封 | 体语义解码（20217ce） |
| 36 | 确认合同不落库×hover 收割门恒假×ready≠hydrated | 五修（f37b15d） |
| 39 | 冻结计数选择器下滚到预算尽 | probe.scrollUntil 有界工具+规则7（2a30649） |
| 40 | 明确反馈三问题未修却绿完收场 | popoverHtml 发明字段 lint+反馈逐问题闭环（026af01） |
| 41 | 四十场四修全验证✓；outerHTML 99K+跨 run 泄漏 | HTML cap 50000+run 边界 scrub（90683b1） |
| 42 | tooltip 全值被捕获后装配丢弃 | labelledbyText 停留期收割（cb920a3） |
| 43 | labelledby 后代下降+装配重命名兜底 | emptyFieldDiagnostics 装配（9eca7be） |
| 44 | 采值先于 hover 批×冷页批才水合 | 批后重读回填+条款成本普查（f930b81） |
| 45 | 派发失败仍跑全管线×3 烧光预算致弃悬浮卡 | 早退/游标池/tick 熔断+流式页探针（b232770） |
| 46 | 3/5 缺口不可见+滚动伪证据+可选字段洗白 | testInput 同面板/内层回退/缺口全披露/相对时间戳/marker bag（fa295f9） |
| 47 | 深度-1 普查盲区：嵌套记录全隐身于绿 verify | 嵌套递归+声明数组 required 门+HTML_FIELD_NO_MARKUP（1918b62→） |
| 48 | 正确 id 正则早就在，probe↔DSL 信封不对称=字符迭代死代码 | fieldMap multi:true/emptyRecordSamples/container-zero 佐证降级（0299d67） |
| 49 | 滚动家族无激活覆盖×窗口失焦短路×冻结非零计数×anchorHref 不上溯×容器级 id 兜底 | F1-F4+用户授权抢焦点（a923797） |
| 50 | **首个完整绿收场**（47 轮 score 153.5）暴露四残余：冻结自愈误报/红跑零普查/testInput 不落地/计数隐藏值无对比 | F1-F4：终态判定+error 分支普查+落地附带+COUNT_FIELD_HIDDEN_VALUE+POLL_EXHAUSTED 节奏（f70a218） |

---

## 4. 事故元模式（反复出现的形状，写新代码时自检）

1. **证据在引擎手里，却没送到模型眼前** — 时间戳/计数/节奏/序号，引擎全都算得出，但错误消息或普查没带上 → 模型只能盲猜。修法：把证据内嵌进模型必读的载荷（POLL_EXHAUSTED 轨迹+节奏、emptyRecordSamples、sibling contrast）。
2. **信封不对称** — probe 与 DSL 原语返回形状不一致（标量 vs 数组、对象 vs 字符串），按探针形状写的脚本静默死代码。修法：信封对齐为不变量，新原语必须配对探针。
3. **内联镜像漂移** — content-script 里的防御性副本错过 lib 的新函数。修法：drift-guard 测试钉两份同步。
4. **对称性原则** — 同一底层命令（CDP/激活/超时）的每条路径必须共享同一基础设施；只修一侧=待发生的事故（hover/dismiss、激活覆盖家族）。
5. **假绿家族** — 合同洗白（挪出 required）、可选字段硬编码空串、合成 index、伪装字段（htmlSnippet=content 切片）、字面量字段、typeless items、单记录门。修法：数据驱动检测器套件（~25 个），纯报告普查不受 `!error` 门禁。
6. **检测器门控类缺陷** — 普查挂在 `!error` 或 `else if (result)` 下，最需要证据的红跑恰好零普查（48th/50th 两次同型）。修法：报告类普查无条件运行，events-only 的进 error 分支。
7. **检测器精度** — 误报与唠叨训练模型无视标签（零陷阱反唠叨、自愈冻结抑制、severe-only 挂附）。修法：只在该报的终态打标。
8. **可见性≠帧产出** — visibilityState 覆盖、生命周期 ACTIVE、tab 激活、窗口聚焦是四个不同的层；每层各有其检测/对抗手段（五层栈）。
9. **值藏在 aria 结构里** — 时间戳/计数/完整文本常只在 aria-labelledby 引用的隐藏 span 或 aria-label 属性中；textContent 空不等于不可提取（25th/31st/50th 三次同型）。
10. **截断要披露** — 任何预览/快照截断必须带长度与头尾双端，否则下游把"看不见"误读为"不存在"（29th head+tail 原则）。
11. **冷热分歧是预期** — verify 新标签是冷加载，与研究标签种群不同是正常的；计数问题回研究页用探针查，不要反复重验证。
12. **模型会在压力下学会错误结论** — 三次预算击杀教会它"弹层不可用"；修复不仅要修 bug，还要修被教会的行为（budgetNote 教学：这是瞬态，重试）。

---

## 5. 当前状态与停靠项

- **状态**：五十轮日志修复完毕；扩展测试 2455/2455、主机测试全绿；**尚未 push**（等用户明确说"提交到 github"）。
- **停靠项（观察中，非缺陷）**：hovercards 单 account 卡（种群决定）；hover htmlSnippet 偶发 64K（OUTPUT_FIELD_SIZE 咨询性已报）；postId 从 photo fbid 派生的语义偏移（story_fbid 在测试页零匹配）；悬停卡捕获率 ~42%（第六日志已知停靠）。
- **计划文件**（gitignored 本地）：`docs/superpowers/plans/2026-09-0*-*.md` 三份 + spec 一份。
- **旁支任务**：SoftwareX 论文（plan 已完成，等 E1-E5 实验数据后成文；INSIGHT 按用户原话引用）。

---

*本摘要由助手的持久记忆系统整理生成；记忆随会话持续更新，本文档按需再版。*
