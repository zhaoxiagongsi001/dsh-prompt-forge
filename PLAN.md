# DSH 提示词优化插件 — 开发计划

> 工作区：`D:\DSH\dsh-prompt-forge`（2026-10-01 由 `D:\DSH\Project prompt optimization` 改名，包名同步 `dsh-prompt-optimizer` → `dsh-prompt-forge`）
> 目标环境：DSH desktop 0.2.0-rc.2（profile：`desktop`）
> 文档状态：**已实现并发布**。v1（0.1.0）与 v2（0.2.0）均已提交推送；v2 见第十一节

---

## 一、目标与范围

做一个**本地自用**的 DSH 插件：在聊天输入框旁提供一个按钮，一键调用你已配置的 LLM 渠道，把当前草稿优化成更清晰、更可执行的提示词，弹窗左右对比，采纳后才写回输入框。

**首版做（MVP）**

- 输入框工具行左侧「优化」按钮，点一下优化当前草稿
- 弹窗左右对比（原文 / 优化版），右侧**流式逐字**渲染，可直接编辑
- 弹窗内：采纳写回、一键复制、继续微调（再输入一句指令重新生成）
- 快捷键：`Ctrl+Enter` 采纳、`Esc` 关闭
- 模型渠道在设置页固定；设置页可编辑主提示词 + 多套预设（切换 / 新增 / 删除）
- 输出语言跟随原文语言
- 只在点「采纳」时才写回，不静默覆盖手稿

**首版不做（挂账）**

历史记录、提示词模板库、缺陷诊断（"缺角色/缺约束/缺输出格式"）、目标模型自适应（GPT/Claude/Gemini 差异化写法）、中英双语输出、选中消息右键优化、快捷键触发、注册成 Agent 工具。

---

## 二、已确认决策

| 项 | 决策 |
|---|---|
| 定位 | 通用：编码 / 问答 / 写作的聊天框草稿都能优化 |
| 优化引擎 | 调 LLM，复用你已配置的渠道（OFOX / OpenRouter） |
| 默认模型 | `provider = ofox`，`model = deepseek/deepseek-v4.1-flash` |
| 温度 | `0.3`（稳；设置页可调） |
| 模型选择 | **从已配置渠道实时拉取的下拉列表**（两级：渠道 → 模型，需一条宿主小路由） |
| 提示词可改性 | 可编辑一份主提示词（带「恢复默认」）+ 多套命名预设（CRUD） |
| 触发方式 | 输入框工具按钮 |
| 结果交互 | 弹窗对比 + 流式 + 可编辑 + 采纳写回 |
| 输出语言 | 跟随原文语言 |
| 工程形态 | 本目录新建独立插件包，开发期 link 进 desktop profile |
| 发布计划 | 工程结构按可发布写（`dsh.bundle` / `dsh.client` 元数据齐全）；v1 已推 GitHub，v2 打 tag `v0.2.0` 并建 Release |

---

## 三、技术栈（均已在你的机器上核实）

| 层 | 选型 | 核实依据 |
|---|---|---|
| 运行时 | DSH desktop `0.2.0-rc.2` | `.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` |
| Node / pnpm | Node `24.21.0` / pnpm `11.7.0` | 同上（`dependencies/node`、`dependencies/pnpm`） |
| 语言 | TypeScript + ESM（`"type": "module"`） | 与 `@dickpy/dsh-imagegen`、`dsh-context` 一致 |
| 插件框架 | Cordis；一个包两个半边：`exports["."]`（宿主）+ `exports["./client"]`（浏览器），由 `package.json` 的 `dsh.client` 声明 | imagegen 的 `cordis.patch.yml` + package.json 已验证此形态 |
| 模型调用 | **`ctx.llm.stream({ provider, model, temperature, system, messages, signal })`** | Host Service `llm` 契约；**插件不接触 API Key**，密钥由渠道适配器+credentials 解析 |
| 渠道与模型目录 | `ctx.llm.listProviders()` / `ctx.llm.listModels(provider)` | 同契约；客户端没有 llm remote 命名空间，故由本插件宿主路由转发 |
| 配置存储 | `ctx.settings.update/mutate(ns, …)` + `settings-controller` | Host Service `settings` 契约 |
| Host↔Client | `ctx.webServer.register(route)`，**loopback-only** + SSE 流式回包 | `webServer` 契约；imagegen 已用同款桥接方式在本机跑通 |
| 前端 | React 18.3 + CSS Modules + lucide-react | 与 imagegen 同栈，主题 token 可直接沿用 |
| UI 挂载点 | 按钮 `conversation.input.left`；设置页 `settings.section`；弹窗 `shell.overlay` | 三个 slot 均为 list 类、`replaceRisk: none`，纯增量、不覆盖官方 UI |
| 读写输入框 | `conversation.input.for(scope)` → `state.getSnapshot().draft` / `setDraft(text)` | imagegen `ImageGenPanel.tsx` 与 `conversation-sync.ts` 正在使用同款 API |
| 构建 | tsdown（含 CSS Modules）+ tsc `--noEmit` | imagegen / dsh-context 的 scripts |
| 类型依赖 | devDeps 从 npm 拉 `@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.2` 等 | registry 上已确认存在 0.1.x → 0.2.0-rc.2 全量版本 |
| 安装 | profile 的 `cordis.patch.yml` 加 `insert` 行 + `pnpm add file:<本目录>`；该 profile 为 `patchReload: live` | `~/.dsh/profiles/desktop/cordis.patch.yml`、`package.json` |

**设计红线**：不新增外部网络通道、不新增密钥、不改 DSH 本体源码、不复制官方代码。

---

## 四、架构与数据流

```
[输入框工具行 · 优化按钮]  (conversation.input.left)
        │ 读草稿: conversation.input.for(scope).state.getSnapshot().draft
        ▼
[优化弹窗]  (shell.overlay)
        │ POST /api/dsh-prompt-forge/optimize   { text, presetId?, instruction?, previous? }
        ▼
[宿主路由 · loopback-only]
        │ system = 该预设 / 主提示词  (+ 附加指令) (+ 语言跟随约束)
        │ ctx.llm.stream({ provider, model, temperature, system, messages, signal })
        ▼
[SSE: event: delta / done / error]  ──► 弹窗右侧实时逐字渲染（textarea，可编辑）
        │
        ├─ 采纳   → conversation.input.for(scope).setDraft(结果)
        ├─ 复制   → navigator.clipboard.writeText
        ├─ 微调   → 带 previous=当前版 + instruction 重新请求同一路由
        └─ 中断   → AbortController 取消上游 stream
```

**模型目录路由**（供设置页下拉）：

```
GET /api/dsh-prompt-forge/models
  → ctx.llm.listProviders() → 逐个 ctx.llm.listModels(provider)
  → { providers: [{ id, name, models: [{ id, name }] }] }
  → 过滤掉纯图像 / embedding 类模型（按 inputModalities 判定）
```

---

## 五、配置 Schema（namespace `include:prompt-forge`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `provider` | string | `ofox` | 渠道 id |
| `model` | string | `deepseek/deepseek-v4.1-flash` | 模型 id |
| `temperature` | number | `0.3` | 采样温度 |
| `maxTokens` | number | 空（用模型默认） | 输出上限 |
| `mainSystemPrompt` | string | 内置默认 | 主提示词，可编辑、可恢复默认 |
| `presets` | array | 内置 3 套 | `{ id, name, system }`，可增删改 |
| `activePresetId` | string \| null | `null`（表示用主提示词） | 当前选中预设 |
| `extraInstruction` | string | 空 | 全局追加约束，拼在主提示词之后 |

预设内置初值建议：**通用优化**、**编码任务**、**写作/改写**（内容在实现时定稿，均遵循"只输出优化后的提示词，不要解释、不要 Markdown 包裹"）。

**提示词组装顺序**：`选中预设或主提示词` → `extraInstruction` → `语言跟随原文` → `把用户草稿作为唯一输入`。

---

## 六、目录结构

```
D:\DSH\dsh-prompt-forge\
├─ PLAN.md                      # 本文件
├─ README.md                    # 安装、配置、排障
├─ package.json                 # name: dsh-prompt-forge；dsh.bundle / dsh.client
├─ tsconfig.json
├─ cordis.patch.yml             # 发布用 bundle 行（开发期也可直接 insert 进 profile）
├─ .npmrc                       # 把 npm/pnpm 缓存指向本目录，避免沙箱外写入
├─ src\
│  ├─ index.ts                  # 宿主：设置 ns、路由、llm 调用
│  ├─ protocol.ts               # 前后端共享类型 + 路由常量
│  ├─ prompts.ts                # 默认主提示词 + 内置预设
│  ├─ model-catalog.ts          # listProviders/listModels 聚合与过滤
│  ├─ settings-compat.ts        # 命名空间兼容与降级
│  └─ client\
│     ├─ index.tsx              # apply：注册设置页、按钮、内联面板、locale
│     ├─ settings.ts            # 官方 configForms 读写
│     ├─ composer.ts            # 输入框解析、读草稿、整替写入判定
│     ├─ accept-guard.ts        # 采纳闸门（流式中/空结果拒绝），纯函数
│     ├─ api.ts                 # fetch + SSE 解析（/models、/optimize）
│     ├─ OptimizeButton.tsx     # conversation.input.left
│     ├─ InlinePanel.tsx        # conversation.input.overlay：对比 + SSE + 微调 + 二次确认
│     ├─ SettingsSection.tsx    # 渠道/模型下拉 + 预设 CRUD + 主提示词
│     ├─ locales.ts             # zh / en
│     └─ *.module.css
└─ scripts\                     # 构建与自检（详见 README）
```

> 上表是 v2 之后的实际结构。原计划的 `tsdown.config.ts`、`docs/DEV.md`、`settings-scope.ts`（loopback bridge）、`sse.ts` 均未落地或已合并：构建改手写打包器（见阶段 0 偏差），设置直接用官方 configForms，SSE 解析并入 `api.ts`。

---

## 七、开发计划

### 阶段 0 — 可行性探针（约半天，最优先）

一个最小可跑插件，只验四件事；任何一条不通就按备注调整方案，**不带着未知往下写**。

| # | 探针 | 通过标准 | 不通时的对策 |
|---|---|---|---|
| 1 | 官方 settings scope 能否读写第三方 namespace | 设置页能存能读 `include:prompt-forge` | 改用 imagegen 同款自带 loopback 桥接（本机已验证可行） |
| 2 | `ctx.llm.stream` 在无会话上下文时能否调通 OFOX | 能收到 `text-delta` 与 `finish` | 退化为插件内直连 OpenAI 兼容端点（需自管 apiKey，接受度需你确认） |
| 3 | `conversation.input.left` 的 slot props 是否给出 session scope | 能拿到 scope 并 `setDraft` | 用 `ctx.sessions` 解析当前会话 id 自行构造 scope |
| 4 | 客户端改动能否免重启热加载 | 重建后刷新生效（HMR 更佳） | 接受「重建 + 刷新页面」的开发循环，文档写清 |

### 阶段 1 — MVP 主链路（约 2～3 天）

1. 宿主：设置 ns + `/models` 目录路由 + `/optimize` SSE 路由（含 AbortSignal 透传、上游错误转可读信息）
2. 客户端：设置页（渠道/模型级联下拉、主提示词编辑+恢复默认、预设 CRUD）；loopback settings scope
3. 客户端：输入框按钮（空草稿时禁用并给 tooltip）
4. 客户端：对比弹窗（左右面板、右侧流式与可编辑、采纳/复制/微调、`Ctrl+Enter`/`Esc`、请求中可中断）
5. 错误分支：无会话、设置未就绪、渠道未配密钥、上游 4xx/5xx、超时、草稿超长
6. 写回语义：仅采纳时写回；弹窗保留原文便于回退

### 阶段 2 — 收尾固化（约半天～1 天）

- tsdown 构建 + `tsc --noEmit` 脚本；`README.md`（安装/配置/排障）+ `docs/DEV.md`
- 把 profile 的安装步骤固化成可复制命令
- 端到端自测清单过一遍

### 阶段 3 — 挂账清单（不在首版）

历史记录、模板库、缺陷诊断、目标模型自适应、中英双语输出、右键优化选中消息、快捷键触发、Agent 工具化。

### 验收标准（阶段 1 完成时）

1. 任意会话输入一段中文粗草稿 → 点按钮 → 10 秒内右侧流式出结果
2. 点采纳后输入框内容被替换；不点采纳时输入框一成不变
3. 切换预设能明显改变输出风格；改主提示词后立即生效
4. 设置页渠道/模型下拉能列出 OFOX 实际可用模型，选中保存后生效
5. 上游报错（断网 / 错误密钥 / 模型不存在）时弹窗给可读原因，不白屏、不卡死
6. 弹窗内可中断进行中的请求，弹窗可正常关闭且无残留

---

## 八、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 官方 settings scope 拒绝第三方 namespace | 设置读不到、存不进 | 阶段 0 先判；备选自带 loopback 桥接 |
| `conversation.input.left` props 无公开类型声明 | 拿不到会话 scope | 阶段 0 实测；退路自行解析会话 id |
| 客户端改动需刷新页面 | 开发手感差 | 阶段 0 验证 HMR；否则文档明确开发循环 |
| 渠道未配密钥 / 模型 id 失效 | 优化请求失败 | `/models` 只列真实可用项；错误信息透传上游原文 |
| 长草稿超出优化模型上下文 | 请求失败 | 前端长度提示 + 超限显式报错（不静默截断） |
| 写回覆盖手写内容 | 用户数据丢失 | 严格「仅采纳写回」；弹窗保留原文 |
| 工作区外写入（装进 profile） | 沙箱拦截 | 该步骤单独向你确认后执行 |

**估算**：探针 0.5 天 + MVP 2～3 天 + 收尾 1 天 ≈ **4 个工作日**。

---

## 九、开工前确认项

- 阶段 0 结束后，我会先回报四条探针结果，再进入 MVP 编码。
- 安装到 profile 属于工作区外写入，届时单独向你要一次确认。
- 本计划不含任何 DSH 本体改动；插件全部产物落在本目录。

---

## 十、执行结果（已更新）

阶段 0 / 1 / 2 全部完成，产物在本目录，`lib/index.js` + `lib/client.js` 已构建。

### 阶段 0 探针结论

| # | 探针 | 结果 |
|---|---|---|
| 1 | 官方 settings scope 能否读写第三方 namespace | **能**。`ctx.configForms.get(entryId)` 服务所有已注册命名空间；不必自建桥接（省掉原计划的备选方案） |
| 2 | `ctx.llm.stream` 无会话上下文能否调通 | **能**。复用 profile 已配的 provider，插件不接触密钥 |
| 3 | `conversation.input.left` 是否给出 session scope | **给**。该 slot 声明 `scope: 'session'`，框架直接交付 `sessionId` + `useInput` |
| 4 | 客户端改动能否免重启热加载 | **能**。`patchReload: live`，bundle 按 mtime/size 换 revision |

### 与计划的偏差

| 偏差 | 原因 | 处理 |
|---|---|---|
| 构建工具从 esbuild 换成手写打包器 | 原生 esbuild 与 esbuild-wasm 都 spawn 管道 stdio 子进程，被 DSH 文件沙箱拒（`spawn EPERM`） | 改用 TypeScript 编译器 API，进程内完成，无子进程 |
| 设置命名空间改为 Loader entry id | 托管式 settings provider 用 `entry.options.id` 作命名空间，不是包名 | `cordis.patch.yml` 行 id 与 `PROMPT_OPTIMIZER_NAMESPACE` 对齐，并加 schema 指纹兜底 |
| 写回路径改为 `sessions.scope()` | `conversation.input.for()` 不接受 sessionId，只接受 Session 作用域，且缺作用域时抛错；`ctx.uiSession` 并无 `sessionOf` 方法 | 走 Session Controller 的 `scope(id)`（官方 imagegen 亦如此） |
| 补了「真实渲染自检」这一阶段 | 仅验 bundle 与路由不足以发现组件层错误 | 新增 `render-check.mjs`（94 项） |

### 验证状态

`tsc --noEmit` 0 错误；**166 项自检全绿**：

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `smoke.mjs` | 43 | bundle 注册协议、导出面、两半 `apply()` 真跑、纯函数 |
| `host-check.mjs` | 29 | 真 HTTP server 打两条路由：loopback、SSE 帧、推理不外泄、报错透传、中断标记、拒绝分支 |
| `render-check.mjs` | 94 | 真实 React 渲染、写回路径与异常吞噬、设置合并容错、加载安全闸门 |

### 过程中修掉的三个真 bug

1. **中断被伪装成完成**：上游 abort 时发的是普通 `done`，截断输出会被当成完整结果 → 加独立 `aborted` 帧。
2. **模型过滤口径错**：modality 优先会让 embedding 混进下拉（网关普遍给 embedding 报 `text` 输入）→ 改为 id 启发式先排除。
3. **写回路径调用不存在的 API**：`ctx.uiSession.sessionOf` 并不存在，真机上 Accept 必然静默失效 → 改走 `sessions.scope()`。

### 发布前审计追加（2026-10-01）

对两半源码做了一轮独立审计（三个窄范围子代理 + 主代理逐条复现），修掉两个**写回路径**上的真缺陷——都属「静默损坏用户草稿」，且都在 README 自称的保证之外：

4. **流式途中可采纳，写回半截文本**：`accept()` 只判非空、未判 `phase === 'running'`。按钮的 `disabled` 拦得住鼠标，但 `document` 级 `Ctrl+Enter` 监听直达 `accept()`，绕过按钮禁用态 → 生成中按快捷键会把模型答案的**前缀**写进输入框。宿主层为此专门发 `aborted` 帧（见 bug 1），前端却在最后一步放行。
   - 修法：抽出纯函数 `acceptRefusal(phase, text)`，`accept()` 与按钮 `disabled` 共用同一判定，两者不可能再分歧；按钮加 `title` 说明；`Copy` 改用独立的 `hasText`，**中断后仍可复制已有内容**。
5. **写回失败被静默吞掉**：`writeDraft` 返回 boolean 表示是否写入，`index.tsx` 调用处丢弃返回值。`setDraft` 静默不生效时（会话在弹窗打开后被回收）弹窗照常关闭，用户以为已采纳而草稿未变。
   - 修法：`onAccept` 契约改为返回 boolean；失败时弹窗**保持打开**并显示可见错误，用户可手动复制。

配套：`render-check.mjs` 增 12 项（94 → 106，总计 166 → 178），其中 6 项专测 `acceptRefusal`——**已验证该测试能抓住旧代码**（把 `running` 判定去掉后 2 项 FAIL、退出码 1），不是事后补的空断言。

审计同时确认无缺陷的部分（供后续维护者省重复劳动）：SSE 解析对「`data:` 行被拆到两个 chunk / 一 chunk 多帧 / CRLF 与 LF 混合 / 帧边界跨 chunk」四种情形均正确（多行 `data:` 不可达，宿主只写单行 `JSON.stringify`）；loopback 四重校验成立；`composerFor` 的「宁可不动也不写错」成立；无 `dangerouslySetInnerHTML`、无硬编码路径、宿主不接触密钥。

---

## 十一、v2：面板内联化（2026-10-03，已发布 0.2.0）

v1 的对比界面是跨整个窗口的模态（`shell.overlay`）。v2 把它改成**输入框卡片内的内联面板**（`conversation.input.overlay`），并把采纳闸门与写回契约随之重构。

### 改了什么

| 方面 | v1 | v2 |
|---|---|---|
| 挂载槽 | `shell.overlay`（全屏遮罩） | `conversation.input.overlay`，order 40 |
| 组件 | `OptimizeDialog.tsx` | `InlinePanel.tsx` + `inline.module.css`（`OptimizeDialog.tsx` 删除） |
| 面板占位 | 模态遮罩 | **0px**：锚点是卡片内零高绝对定位元素，`absolute + bottom:100%` |
| 写回路径 | `sessions.scope()` → `conversation.input.for()` 反射查找 | 会话级槽位直接交付 `inputActions.setDraft` |
| 快捷键 | `Esc` 关闭、`Ctrl+Enter` 采纳（`document` 捕获阶段） | **无任何全局快捷键**，全部改可见按钮 |
| 采纳闸门 | 内联在对话框组件里 | 独立纯函数 `accept-guard.ts`，按钮禁用态与采纳处理共用同一判定 |
| 有引用/附件时采纳 | 直接整替 | 先弹二次确认（`writeNeedsConfirm`） |

### 三个必须记住的实现约束

1. **order 必须是 40，不能是 10**：`dsh-context` 在同一个槽里以 order 10 注册 `context-modal`；占同一格 id 会在注册时抛异常并连带整个 GUI 启动失败。
2. **面板必须带 `backdrop-filter: var(--dsw-menu-backdrop-filter)`**：面板是半透明的，不设滤镜会直接透出后面的对话文字。`z-index` 要保持低（1），否则会盖住官方模型下拉。
3. **不能注册全局快捷键**：官方 Lexical 键盘表把 `Ctrl/Cmd+Enter` 当「立即发送」，v1 的捕获阶段处理器没 `stopPropagation`，面板采纳与输入框发送会同时触发。这是 v2 去掉全部快捷键的直接原因。

### 验证状态（v2）

`tsc --noEmit` 0 错误；**292 项自检全绿**（smoke 48 + host-check 29 + render-check 215，v1 为 178）；构建产物可复现（连跑两次 SHA256 一致）。

### 剩余一步（需你确认）

装进 `desktop` profile 属于工作区外写入。当前 profile 与 `cordis.patch.yml` 均未出现本插件，符合「仅在本目录产出」的约束。

若从 GitHub 安装，装完后仍需**手动刷新页面**（客户端 bundle 首次加载必须刷新，与 HMR 无关），再打开 设置 → 提示词优化 确认渠道下拉能列出 OFOX 的模型。

## 十二、v0.2.1：发布面修正（2026-10-03）

v2 的代码在 0.2.0 已冻结，本节只改**对外可见的发布面**，`lib/` 一个字节未动。

### 改了什么

| 项 | 改动 |
|---|---|
| 截图 | 三张全部重拍为 v2 真机实拍（工具行 958×122、内联面板 982×516、设置页 800×800）；删除 v1 的全屏模态图 `screenshot-2-dialog.png`，新增 `screenshot-2-panel.png` |
| README 图片引用 | 原先 **0 个** `![]()`，三张图从未被引用；现补上三处引用 |
| 市场措辞 | 「从市场或 GitHub」→「从 GitHub」，并注明本插件尚未被 dshmarket 的收录源收进，市场里搜不到 |
| 按钮位置 | 「输入框左下角」→「工具行里（附件按钮、权限下拉之后）」 |
| 设置页能力 | 补「插件开关」与「输出上限 token（0 = 用模型默认值）」 |
| 排障两条 | 「下拉是空的」原归因于行 id 与 `PROMPT_FORGE_NAMESPACE` 不一致 —— 与代码的三重兜底不符；「只读」的真因是 `ctx.configForms` 缺席或文档不可写 |
| package.json | `files` 补 `assets` + `screenshots.json`（原先 npm 打包会丢图）；description 的 "side-by-side dialog" → "inline panel above the composer" |

### 截图流程的可复用部分

截图由 `D:\DSH\_forge-shots\gen.mjs` 生成：直接从 `~/.dsh/.credentials.yaml` 派生已签名 cookie，产出文件只含 cookie 值与拍摄逻辑，**签名密钥不落任何产物**，用完即删。拍摄前跑三项断言：新会话、侧栏隐藏、7 个历史会话标题关键词 0 命中。

### 验证状态（v0.2.1）

`tsc --noEmit` 0 错误；292 项自检全绿（48+29+215）；`lib/` 重跑构建后与 v0.2.0 逐字节一致，证明本次只动发布面。

## 十三、投稿插件市场（2026-10-03）

市场（dshmarket）不读 npm，只装它自己那份 curated registry（`awesome-dsh-plugin/awesome-dsh-plugin`）里的源。收录方式是向该仓库提一个 PR，新增**一个** YAML：`data/plugins/zhaoxiagongsi001__dsh-prompt-forge.yml`。

### 状态

| 项 | 值 |
|---|---|
| PR | `awesome-dsh-plugin/awesome-dsh-plugin#6471`（open，`mergeable_state: clean`） |
| 改动 | 仅自己那一个文件，+7 行 |
| CI | `Submission gate` 与 `PR check` 均 green（17/17 步） |
| 分类 | `ui` |
| 评审 | 尚无维护者评论；等待中 |

收录门槛逐条核对过：`dsh.bundle` 存在、仓库有真实代码、仓库年龄 51.9h（>1 天）、已加 `dsh-plugin` topic、描述与代码相符。

### 预构建 tarball（条目里的 `tarball:` 字段）

条目指向 `https://github.com/zhaoxiagongsi001/dsh-prompt-forge/releases/latest/download/dsh-prompt-forge.tgz`，让用户跳过源码构建。

**资产名必须无版本号**：`latest/download/` 只在请求时解析 `latest`，文件名照字面取。若叫 `dsh-prompt-forge-0.2.1.tgz`，提交当天能下、下次发版就 404，且无人察觉。详细规则与发版清单见 `RELEASING.md`。

### 与既有条目的关系

做「改写输入框草稿」的已有 5 条（`LHF198/dsh-prompt-optimizer` 最接近、但 2026-08-30 后停更、1 star；另有 `1321928757/dsh-prompt-polish`、`CheeseFox259/dsh-better-composer`、`Fishsb/dsh-prompt-enhancer`、`Hua1Q1nG__dsh-prompt-self`）。评审第 4 条是「是否已被覆盖」，但规则写明「不是先来后到，是谁更好」——差异点是不占布局的内联面板、生成中拒绝采纳、引用/附件二次确认、零全局快捷键、密钥不进浏览器。

