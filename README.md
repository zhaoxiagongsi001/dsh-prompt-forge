# dsh-prompt-forge

DSH 桌面版（DSH desktop）的**提示词优化插件**：在聊天输入框旁加一个按钮，一键调用你已配置的模型渠道，把草稿改写成更清晰、更可执行的提示词。左右对比、流式输出、**只有点「采纳」才写回输入框**。

- **宿主半边**：`ctx.llm` 调用、渠道/模型目录、设置命名空间、两条 loopback 路由
- **浏览器半边**：输入框工具按钮、设置页、对比弹窗
- **不接触密钥**：模型渠道复用 DSH 已配置的 provider，插件自己不存任何 API Key

---

## 功能

| 能力 | 说明 |
|---|---|
| 一键优化 | 输入框左侧「优化」按钮，点击优化当前草稿 |
| 左右对比 | 左原文、右优化版，弹窗内可**直接编辑**结果 |
| 流式输出 | 右侧逐字出现，请求中可随时「停止」 |
| 继续微调 | 弹窗底部再输入一句要求（如「再短一点」），基于上一版继续改 |
| 采纳 / 复制 | `Ctrl+Enter` 采纳写回输入框（**流式进行中会被拒绝**，避免写回半截文本），`Esc` 关闭；一键复制（流式途中也可复制，便于中断后取用已有内容） |
| 预设切换 | 弹窗内可切换预设，切换即按新预设重跑 |
| 设置页 | 渠道/模型下拉（从你已配置渠道实时拉取）、温度、主提示词、预设增删改 |
| 语言跟随 | 中文进中文出，英文进英文出 |

## 不做什么

首版刻意不含：优化历史记录、提示词模板库、缺陷诊断（缺角色/缺约束）、目标模型自适应、中英双语输出、选中消息右键优化、Agent 工具化。这些都在 `PLAN.md` 的挂账清单里。

---

## 安装

### 用户安装（从市场或 GitHub）

仓库自带构建产物（`lib/` 已提交），因此 GitHub 源码安装开箱可用：

```sh
dsh plugin --profile web add github:zhaoxiagongsi001/dsh-prompt-forge
```

或从插件市场一键安装。装完**刷新一次页面**（客户端 bundle 首次加载必须刷新），输入框左下角即出现「优化」按钮。

### 开发期安装

以下是把本地源码装进 `desktop` profile 的步骤。

#### 1. 构建

```powershell
# 用 DSH 自带的 node
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node node_modules/typescript/bin/tsc --noEmit   # 类型检查
& $node scripts/build.mjs                          # 构建
& $node scripts/smoke.mjs                          # 43 项：bundle 契约与纯函数
& $node scripts/host-check.mjs                     # 29 项：宿主路由集成
& $node scripts/render-check.mjs                   # 106 项：真实 React 渲染、采纳闸门与写回路径
```

### 2. 装进 profile

`cordis.patch.yml` 里的行 id 是**承重的**：托管式设置 provider 用 Loader entry id 作设置命名空间，而 `insert` 进去的行，其 entry id 是 `include:<行id>` —— 所以本插件实际的设置命名空间是 **`include:prompt-forge`**，不是行里那个裸名字。浏览器半边会在运行时解析这个具体字符串（精确匹配 → `:<行id>` 后缀 → schema 指纹），所以改行 id 仍能工作，但会**改变设置值的存放位置**。

把本插件作为 profile 依赖添加，并让 profile 载入它的 bundle：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
cd $profile
# 指向本地目录。用 link: 而不是 file: —— file: 是拷贝，重建后不会同步，
# 结果是「改了源码、跑了 build，界面却还是旧行为」。link: 指向源目录，重建即生效。
pnpm add "link:D:\DSH\dsh-prompt-forge"
```

然后在 `$profile\package.json` 的 `dsh.profile.bundles` 数组末尾加上：

```json
"dsh-prompt-forge"
```

该 profile 是 `patchReload: live`，保存后即刻生效。若未生效，重启 DSH。

> 换名/换路径后必须重装一次：`pnpm remove` 旧名 → 删掉 `node_modules` 里的旧目录 → `pnpm add` 新名 → `pnpm install`。残留的旧目录会让 loader 看到两个 bundle。

### 3. 先跑通配置

打开 **设置 → 提示词优化**：

1. 确认「渠道」下拉能列出你配置的渠道（如 `ofox`），「模型」下拉能列出该渠道的聊天模型
2. 选好默认模型（默认 `ofox` / `deepseek/deepseek-v4.1-flash`）
3. 温度保持 `0.3`
4. 需要时改主提示词，或在「预设」里增删

> 模型下拉会自动过滤掉图像、embedding 等非聊天模型 —— 它们在网关的 `/models` 里和聊天模型混在一起。

---

## 使用

1. 在输入框里写一段草稿（中文或英文都行）
2. 点输入框左下角的 **优化** 按钮
3. 右侧流式出结果，可以直接改
4. `Ctrl+Enter` 或点「采纳」写回输入框；不采纳则原稿一字不动。**生成中采纳键呈禁用态**（`Ctrl+Enter` 同样被拒），等输出结束再采纳；中断后用「复制」取走已有内容

草稿为空、插件被关闭、或草稿超过 20000 字时，按钮会禁用并说明原因。

---

## 架构

```
[输入框工具行 · 优化按钮]   conversation.input.left
        │  读草稿（回写也只有这条路径）
        ▼
[优化弹窗]                  shell.overlay
        │  POST /api/dsh-prompt-forge/optimize
        ▼
[宿主路由 · loopback-only]
        │  system = 预设 / 主提示词（+ 上一版 + 本次要求）
        │  ctx.llm.stream({ provider, model, temperature, system, messages, signal })
        ▼
[SSE: start / delta / done / error]  ──►  右侧逐字渲染
```

**模型目录**：`GET /api/dsh-prompt-forge/models` → `ctx.llm.listProviders()` + `listModels()`，
过滤非聊天模型后供设置页下拉使用。客户端拿不到 `ctx.llm`（客户端运行时没有 `llm` remote 命名空间），所以由宿主投影。

### 关键设计取舍

| 取舍 | 原因 |
|---|---|
| 弹窗放 `shell.overlay` | 输入框工具行是窄横条，左右对比塞不下 |
| 写回只在「采纳」 | 草稿是用户手写的，任何隐式覆盖都是数据丢失 |
| 流式途中拒绝采纳 | 屏幕上的文本是模型答案的前缀而非答案，写回去就是残缺提示词；按钮 disabled 拦不住 `Ctrl+Enter`，所以闸门放在采纳逻辑里 |
| 写回失败不关弹窗 | 会话在弹窗打开后被回收时 `setDraft` 会静默不生效；此时若照常关闭，用户会以为已采纳而草稿未变 |
| 丢弃 `reasoning-delta` | 推理模型的思维链会混进要被粘贴的提示词里 |
| 草稿超长直接报错 | 静默截断会让用户拿到一段残缺提示词却不知道 |
| 优化中断标记为 `aborted` | 截断的输出不能伪装成完整结果 |
| 系统提示词由前端组装后传入 | 宿主不必再解析一遍插件设置，两边规则只有一处 |

---

## 开发

```powershell
# 监视 src/，改动即重建
& $node scripts/build.mjs --watch
```

### 构建说明

构建脚本是**手写的、无子进程的**打包器（`scripts/build.mjs`），基于 TypeScript 编译器 API：

- 原生 `esbuild` 与 `esbuild-wasm` 都会 spawn 带管道 stdio 的辅助进程，DSH 文件沙箱会拒绝（`spawn EPERM`）；TS 编译器 API 是纯 JS，在进程内跑得通
- 浏览器半边输出必须包成 `window.__ModuleLoader__.load({ id, factory })` 这种自注册经典脚本；`react` 与 `@deepseek-ai/dsh-client-store` 走外壳的冻结模块表，其余全部内联
- `*.module.css` 编译成注入一个带 `data-plugin-css` 标签的模块 —— 模块系统在 factory 首次材料化时认领 `<style>`，所以注入必须发生在那时，标签则让禁用/替换代码时能回收
- 宿主半边输出普通 ESM，`node:*` 与 `@deepseek-ai/*` 保持外部依赖，由宿主进程解析

### 自检覆盖（178 项）

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `scripts/smoke.mjs` | 43 | bundle 注册协议、只用种子模块能否材料化、导出面、两半 `apply()` 能否真跑完、纯函数（提示词组装、配置归一化、草稿校验、模型过滤） |
| `scripts/host-check.mjs` | 29 | 真起 HTTP server 打两条路由：loopback 语义、SSE 帧、推理块不外泄、上游报错透传、中断标记、微调请求体形状、各拒绝分支 |
| `scripts/render-check.mjs` | 106 | 真实 React 渲染三处 surface：按钮各禁用态与其原因文案、设置页读写态与预设增删、弹窗结构/语义/模型名/空结果禁用、**采纳闸门**（流式进行中拒绝采纳，含 Ctrl+Enter 绕过按钮 disabled 的路径）；写回路径（composer 解析与异常吞噬、`writeDraft` 落库与拒绝）；设置合并的容错；外加**加载安全闸门**与 `dsh.client` 声明形状 |

**自检不等于 GUI 渲染通过。** 这三个脚本证明 bundle 能加载、路由行为正确、组件能渲染出预期结构、写回路径不会抛异常；但按钮在你真实输入框里的位置、弹窗与外壳主题的实际观感、以及 `ctx.configForms` 在你 profile 里的真实握手，只有真实页面能证明 —— 这正是最后一步要在 GUI 里验收的原因。

> 加载安全闸门值得单独说：浏览器里 `require(未知包)` 是**硬加载失败**，插件会整体不出现且没有任何提示。所以「bundle 里每个裸 require 都在平台种子表里」这一条，比其余所有断言加起来都更能防止「装上但没反应」。

### 目录

```
src/
├─ protocol.ts           前后端共享契约（命名空间、路由、类型）
├─ prompts.ts            默认主提示词 + 内置预设 + 提示词解析
├─ model-catalog.ts      渠道/模型聚合与聊天模型过滤
├─ settings-compat.ts    设置 provider 世代兼容
├─ index.ts              宿主半边：设置 + 两条路由 + llm 调用
└─ client/
   ├─ index.tsx          浏览器半边：注册三处 surface
   ├─ settings.ts        设置读取/写入（官方 configForms）
   ├─ composer.ts        按 session 解析输入框并读/写草稿
   ├─ api.ts             /models + /optimize（含 SSE 解析）
   ├─ locales.ts         zh/en 文案
   ├─ OptimizeButton.tsx 输入框工具按钮
   ├─ OptimizeDialog.tsx 左右对比弹窗
   ├─ SettingsSection.tsx 设置页
   └─ optimizer.module.css
scripts/
├─ build.mjs             无子进程打包器（TS 编译器 API）
├─ smoke.mjs             43 项 bundle 契约与纯函数自检
├─ host-check.mjs        29 项宿主路由集成自检
├─ render-check.mjs      106 项真实渲染、采纳闸门、写回路径与加载安全自检
├─ asar-list.mjs         开发期参考：列 app.asar 内文件
├─ asar-extract.mjs      开发期参考：从 app.asar 提取文件
└─ pack-ref.ps1          开发期参考：拉取指定版本类型包
```

> 后三个脚本只在核对上游契约时用过，产物在 `.refs/`（已在 `.gitignore` 里）。保留它们是为了将来 DSH 升级时能快速重新核对，不影响构建与运行。

---

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 输入框旁没有按钮 | 插件未启用（设置页开关）、未装进 profile，或 profile 未重载 |
| 按钮一直灰着 | 草稿为空、草稿超 20000 字，或输入框处于提交中状态 |
| 提示「没能写入输入框」 | 弹窗打开后该会话已被回收，宿主拿不到输入框；内容仍在弹窗里，手动复制即可（不会覆盖原稿） |
| 设置页下拉是空的 | 宿主没有报告渠道：确认 `cordis.patch.yml` 的行 id 与 `PROMPT_FORGE_NAMESPACE` 一致 |
| 设置页显示只读 | 当前设置文档不接受写入（非 loopback 页面），插件退回默认值 |
| 优化报「模型不存在」 | 设置里存的模型已不在该渠道目录中，重选一次 |
| 优化报上游错误 | 原文透传自 provider（如限流、密钥无效），按提示处理 |

---

## 许可

MIT
