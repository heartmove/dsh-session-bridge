# dsh-session-bridge — 会话桥（Session bridge）

适配 DSH **0.1.7-0 及之后的版本**：`peerDependencies` 与 `package.json` 的 `engines.dsh` 都只声明
下限（`>=0.1.7-0`），不设上限。**DSH `0.2.1-rc.1` 起 `engines.dsh` 单独裁决**（声明了就忽略
`peerDependencies`），所以两者逐字一致，当前实测于 **0.2.2-alpha.3**。详见[兼容性变更](CHANGELOG.md)与
[AGENTS.md](./AGENTS.md)（版本策略是硬性规则，有 `pnpm test` 守卫）。

一个 [DSH](https://www.deepseek.com) 插件：让当前 agent 能通过提示词驱动其它真实的 DSH 会话——
创建主会话、向任意会话发消息、等待并读取回复、恢复离线会话、跨工作区按名称或 id 查找会话。
在此之上，它还能**监控并调度**一个主任务（观察进度、卡住时催办、偏离时纠偏、必要时终止），
以及像 DSH 侧边栏的 Archive 一样**归档**会话。

> English docs: [README.md](./README.md).

## 功能

- **创建真实 DSH 会话。** `session_bridge_create` 在当前工作区创建新的主会话（顶层 UI 会话），
  传 `workspaceId` / `cwd` 则跨工作区；可选发送首条 prompt 并阻塞等待首条回复。provider / model /
  reasoning effort 默认继承调用会话。异步创建（不带 `waitForReply`）会返回 `sinceSeq` 锚点，
  之后可用它精确地 `session_bridge_wait` 取回首条回复。
- **向任意会话发消息。** `session_bridge_send` 追加一轮（`mode=queue`）或向运行中的步骤注入
  steering（`mode=steer`），可选等待下一条回复；异步发送同样返回 `sinceSeq` 锚点。
- **等待回复或段落。** `session_bridge_wait` 阻塞直至 `sinceSeq` 之后出现新的 assistant 输出
  （默认 `sinceSeq` = 调用时刻的最新事件 seq）：`waitFor=reply`（默认）在有新的**文本**回复可读时
  立即返回；`waitFor=segment` 在任意新**已完成输出步骤**出现时立即返回（一个 `assistant/message`
  ——文本、推理或工具调用段），*无需*等整个 turn 结束，从而可以按段落逐段观察输出。开
  `requireTurnEnd` 则同时等待回合收尾。超时 / 中止返回部分结果，而非抛错。
  **回复早已落地也不会丢**：预算内没等到新输出时，会返回预算前就存在的最新回复/段落并置
  `stale: true`（不会再出现 `(no text)`）。要精确取回"某次发送之后的回复"，把 `session_bridge_send` /
  `session_bridge_create` 异步返回的 `sinceSeq` 作为锚点传进来即可（与调用方延迟无关）；
  `sinceSeq: -1` 表示"连既有事件也算"，即新建会话的锚点。
- **读取任意会话。** `session_bridge_read` 把会话事件日志折叠为可读行——live 或离线（持久化）均可；
  支持 `sinceSeq` 分页、role 过滤、`limit`（默认 20，最大 100）。
- **按段落读取输出。** `session_bridge_segments` 返回会话的**已完成输出段落**——每个已完成的
  assistant 步骤（一个 `assistant/message`：其文本、推理与请求的工具调用）作为一行，用 `sinceSeq`
  增量翻页并返回下一游标。live 或离线均可用，*无需*等整个 turn 结束，因此可以逐步跟踪长 agentic
  任务（模型流式推理时，段落中一并包含思维链）。
- **恢复离线会话。** `session_bridge_resume` 让持久化会话重新上线（幂等），可覆盖 provider / model。
- **查找会话。** `session_bridge_find` 跨全部工作区按 标题 / id / workspace / 目录 匹配，返回
  live/running 状态、标题、工作目录；bridge 登记的标题作为别名参与匹配。
- **监控并调度主任务。** `session_bridge_status` 读取会话实时进度（running/idle、是否 `openTurn`、
  距最近事件毫秒数做卡住检测、待处理消息、最新回复）；只有 **running** 会话才会被标 `[STALLED]`
  （空闲会话没有进展是正常状态，与守护循环判定一致）。`session_bridge_cancel` 停止一个运行中的会话；
  `session_bridge_monitor_start` 运行一个**后台守护循环**，轮询任务、卡住时催办、偏离时纠偏、
  持续卡住则终止、完成即收尾；**思维链陷入循环**（如 `写。好。Go。` 反复）时自动中断原会话，
  并把任务（含子代理清单）**转移到新会话**继续做。
- **归档 / 取消归档会话。** `session_bridge_archive` 把会话加入 DSH workspace 归档集合（从所有分组视图隐藏，
  历史与位置保留）——目标仍在跑时默认拒绝归档，传 `stopActivity: true` 则先归档再按官方路径停掉它的
  运行中工作（turn、子 agent、job、schedule）；`session_bridge_unarchive` 把会话移出归档集合、回到原位
  置重新可见；`session_bridge_archived` 列出归档集合，可选解析标题——解析不出标题的会话
  只省略标题，不会让整个调用失败。归档集合会无限增长，因此 archive/unarchive 的结果只报
  受影响 id + 集合规模并摘要最新若干条，`session_bridge_archived` 支持可选 `limit`
  （默认 50、从最新往回取，`total` 始终是真实规模）。

## 监控守护循环

`session_bridge_monitor_start` 安装一个定时器驱动的循环。每轮对目标会话执行
「观察 → 判定 → 调度 → 落日志」：

| 判定 | 动作 |
|---|---|
| 回复命中 `doneKeywords` 且会话空闲 | 收尾并停止守护（日志 `DONE`） |
| 空闲且无待处理 | 收尾（settled）——不无谓催办 / 取消 |
| `running` 且距最近事件超过 `stalledMs` | 记一次卡住 → `steer` 催办（开 `useLlm` 时先判 `offtrack`/`stuck`） |
| 连续卡住 ≥ `maxStuckCycles` | `cancel` 终止 |
| 正常推进 | 重置卡住计数（steady） |
| `running` 且思维链出现循环（默认开启） | 创建新会话承接任务 → 中断原会话（转移，日志 `LOOP-TRANSFER`） |
| 循环但转移预算用尽 / `loopTransfer: false` | 只中断（日志 `LOOP-CANCEL`） |
| **子代理**思维链循环 | 取消该子代理 + `steer` 主会话重派（**不转移**） |

守护只对 **running** 会话判定"卡住"，因此已完成/空闲的任务会被收尾而非无限催办
（`session_bridge_status` 的 `[STALLED]` 标注同理，只对 running 会话显示）。日志写入
`~/.dsh/super-injector/dsh-session-bridge-monitor.log`（可用 `logFile` 覆盖）。

用 `session_bridge_monitor_start` / `_stop` / `_list` 控制。

### 思维链（CoT）监控与规则

会话桥可以**实时监控**另一个会话的思维链（chain-of-thought / reasoning），而不只等它的最终回复：

- **实时观察**：`session_bridge_status` 对运行中会话返回三块思维链字段——`lastReasoning`
  （最近一条已定型推理块）、`liveReasoning`（当前正在处理的 turn 的进行中推理，来自
  `assistant/chunk` 的 `reasoning-delta` 流）、`reasoningTail`（紧凑、受字符上限的合并预览）。
  用 `reasoning` 参数（`none | last | live | tail`）选择返回哪些字段，默认 `tail` 最省 token。
- **按段落读取**：`session_bridge_segments` 把每个已完成输出步骤（一个 `assistant/message`——文本、推理或工具调用段）当作一个段落返回，用 `sinceSeq` 增量翻页，无需等整个 turn。
- **按消息读取**：`session_bridge_read` 带 `includeReasoning` 可返回每条 assistant 消息的已定型推理。
- **规则执行**：`session_bridge_monitor_start` 接受 `coRules`（数组，元素为 { match:
  contains|not-contains, field: reasoning|text|both, value: string, action: steer|cancel,
  message?: string }）与 `cotMinHits`。每次轮询守护用规则的匹配条件对照实时思维链/文本，
  连续命中 `cotMinHits` 次（默认 1）后触发动作：`steer` 注入引导性用户消息，`cancel` 终止会话。
  示例——"思维链一旦不再包含 I'm 就停止该会话"：

      coRules: [{ "match": "not-contains", "field": "reasoning", "value": "I'm", "action": "cancel" }]

  注意：作用在 `reasoning` 上的 `not-contains` 规则在目标会话**完全不产生推理**时故意不触发
  （如非推理模型或 reasoningEffort off），避免误 cancel 根本不流式思维链的会话。重复触发有冷却
  节流，每次评估/触发都会写入监控日志。

### 思维链循环检测与任务转移

**为什么不能靠「卡住」检测**：循环会话每转一圈都产生新事件，「距最近事件毫秒数」始终很小，
`stalledMs` 永远到不了阈值——卡住判定对循环**天然失明**。所以循环必须由**内容**判定。

判定（`src/loop-guard.ts`，纯函数、无副作用、不依赖宿主）：把思维链按 `。！？；!?;` 与换行切成
单元（**标点保留在单元内**，所以 `写。` 与 `好。` 是两个不同单元），在**尾部窗口**（1200 字符）
内找「同一小段周期重复」。实测判定：`写。/好。/Go。` 各 3 轮 → `period=3 repeats=3` 命中；
`3 单元 × 2 轮` 与 `2 单元 × 2 轮` 不命中（重复次数下限为 3）；很长的正常推理不命中；
尾部循环不会被前面的长前缀掩盖；无标点的重复由字符 n-gram 兜底（`kind=char`）。

| 参数 | 默认 | 含义 |
|---|---|---|
| `loopGuard` | `true` | 传 `false` 关闭循环检测 |
| `loopField` | `reasoning` | 扫哪块：`reasoning`（实时思维链，优先 `liveReasoning`，无则回落 `lastReasoning`）/ `text` / `both` |
| `loopMinCycles` | `2` | 至少重复几轮 |
| `loopMinRepeats` | `3` | 同一单元至少重复几次；**生效下限是 `max(loopMinCycles, loopMinRepeats)`** |
| `loopMinConfidence` | `0.6` | 置信度阈值（按单元长度、覆盖轮数、周期长度加权） |
| `loopMinHits` | `1` | 同一签名（字段+周期+单元）连续命中几次才动作 |
| `loopCooldownMs` | `max(intervalMs*2, 30000)` | 同一签名的冷却，防抖动重复动作 |
| `loopMaxTransfers` | `3` | 最多转移几次（同时是**转移深度上限**） |
| `loopTransfer` | `true` | `false` = 只中断、不转移 |
| `loopAutoMonitor` | `true` | 新会话是否自动纳入守护 |
| `loopDescendants` | `report` | 子代理处置策略，见下表 |
| `loopHandoffPrompt` | 内置模板 | 自定义交接提示词，占位符 `{{sessionId}}` `{{cwd}}` `{{reason}}` `{{task}}` `{{evidence}}` `{{descendants}}` |

命中后的动作（**顺序不可颠倒**）：先在原工作目录**创建新主会话并投递交接提示词，成功之后才中断原会话**。
反过来（先停后建）一旦创建失败任务就没了；当前实现选择「创建失败 = 保持原监控、什么都不停」，
并按 `max(intervalMs, 10s)` 节流重试。交接提示词含原会话 id、任务指令、最近指令 / 最后回复 /
最后思维链摘要，以及子代理清单，并要求新会话用 `session_bridge_read` **自己读原会话日志**
（不塞全文，省 token）。转移链会继承同一份转移记录，所以预算不会随新会话重置。

预算耗尽（`loopMaxTransfers` 或转移深度到顶）或 `loopTransfer: false` → **只中断**（日志 `LOOP-CANCEL`）。
相关日志：`LOOP-HIT` / `LOOP-TRANSFER` / `LOOP-TRANSFER-FAILED` / `LOOP-CANCEL` /
`LOOP-SUBAGENT-CANCEL` / `LOOP-SUBAGENT-NOTIFY`。

#### 子代理怎么处理

| 场景 | 处置 | 为什么 |
|---|---|---|
| A. 主会话循环，子代理**仍在正常跑** | **不取消**，列进交接提示词（`report`，默认） | 它们的活没白干；新会话被告知「不要重做」，可等结果或继续指挥 |
| B. 主会话循环 + `loopDescendants: 'stop'` | 转移**之前**逐个取消，并记入 `stopped` | 你要的是干净交接、不留孤儿工作 |
| C. 主会话循环 + `loopDescendants: 'ignore'` | 不取消，也不写进交接 | 子代理与后续任务无关 |
| D. **子代理**循环（主会话正常） | 取消该子代理 + `steer` 主会话重派，**不转移** | 坏掉的是子任务不是主任务；主会话最清楚怎么重派 |
| E. **子代理会话自己**就是监控目标且循环 | **只取消，不转移** | 它的身份是子代理，另建顶层会话会打乱执行树；父会话收到通知 |

判定「谁是子代理」优先用宿主能力（`agents.isOwnedBy` / `roots()`），拿不到时回落到会话 header 的
`origin === 'subagent'` / `parentSession`，再拿不到就按顶层处理——**只会少转移，不会乱转移**。
转移链受 `loopMaxTransfers` 限制：转移过去又循环，最多再转移一次……直到预算用尽，之后只中断，
不会 A→B→C 无限接力。

### 开启与关闭（两种方式）

循环检测**默认开启**，总开关与全局默认值都放在**插件配置**里（profile patch 中本插件 entry 的 `config`），
所以下面两条路径改的是**同一份值**：

**1. 斜杠命令** `/cot-loop` —— 在交互式 UI 里直接改，写回配置后**立即生效**（不需要重启或重载插件）：

```
/cot-loop status                      # 当前开关、检测参数、设置页入口
/cot-loop off                         # 关闭思维链循环自动中断（全局）
/cot-loop on                          # 重新打开
/cot-loop field text                  # 只扫最终回复（默认扫思维链 reasoning）
/cot-loop descendants stop            # 转移前先停掉仍在运行的子代理
/cot-loop max-transfers 3             # 最多转移几次（0 = 只中断不转移）
/cot-loop help                        # 全部子命令
```

参数类改动从**下一个** `session_bridge_monitor_start` 起生效；`on` / `off` 对**已运行**的守护立即生效
（守护每个 tick 都实时读 volatile 引用）。宿主没有 `configEditor` 服务（或写回失败）时，命令会退化成
**本进程内存开关**，并在回执里写明"仅本次运行有效"——不会假装持久化成功。

**2. 设置页开关** —— 设置 → Plugins → `dsh-session-bridge`：表单由 `Config` 里标了 volatile 的字段自动渲染
（`dsh-settings` 只把 volatile 字段渲染成控件，所以这一半不需要任何客户端代码），`loopGuard` 就是总开关，
改完同样写回 profile patch 并立即生效。

单个守护仍可单独关闭：`session_bridge_monitor_start({ sessionId: '...', loopGuard: false })`。

| 插件配置字段 | 默认 | 含义 |
|---|---|---|
| `loopGuard` | `true` | **总开关**：`false` 时任何守护都不做循环检测（设置页 / `/cot-loop` 改的就是它） |
| `loopField` | `reasoning` | 扫哪块：`reasoning` / `text` / `both` |
| `loopMinCycles` | `2` | 至少重复几轮 |
| `loopMinRepeats` | `3` | 同一单元至少重复几次 |
| `loopMinConfidence` | `0.6` | 置信度阈值 |
| `loopMinHits` | `1` | 连续命中几次才动作 |
| `loopCooldownMs` | `60000` | 同一签名的冷却时间（毫秒） |
| `loopMaxTransfers` | `3` | 最多转移几次（`0` = 只中断不转移） |
| `loopDescendants` | `report` | 子代理处置策略，见下表 |

## 环境要求

- [Node.js](https://nodejs.org) ≥ 20
- [pnpm](https://pnpm.io)
- DSH `0.1.7-0` 或更高（`peerDependencies` 与 `engines.dsh` 都是 `>=0.1.7-0`；构建与实测基于
  `0.2.2-alpha.3`）。

## 构建

```bash
# 安装锁定的 DSH 发布依赖，再类型检查并构建
pnpm install --frozen-lockfile
pnpm build

# 针对"实际安装的 dsh"做类型检查（不需要 checkout）
npm run check:compat

# peer 下限守卫、wait/卡住判定、循环判定与交接、守护循环端到端、archived handler、V3→V4 迁移
npm test

# 或经注入器工具链
dev_build_plugin dsh-session-bridge
```

`build.sh` 按本地 dsh 源码 checkout 做类型链接，仅用于本地开发。该 checkout 常常
落后于插件实际加载进的 harness，因此 `build.sh` 通过**并不**代表插件在运行中的
DSH 上可用——两者版本不一致时 `build.sh` 会给出警告。要验证运行版本请用
`npm run check:compat`：它按已安装 DSH 包内随附的 `lib/types/*.d.ts`（即插件真正
加载的 API 面）对 `src/` 做类型检查，随后把产物内联的 DSH 版本与已安装 harness
比对——内联版本**低于**声明下限（`0.1.7-0`）才判失败，其余漂移只给提示（传
`--strict` 可恢复"必须完全一致"的严格判定），因为本插件声明的是"下限及之后"。
内联的 `cordis` 单独成组，与已安装的 cordis 比对。

## 部署

DSH web 从活动 profile 加载外部插件。本包是一个 **bundle**：`package.json` 声明了
`dsh.bundle.patch` → [`cordis.patch.yml`](./cordis.patch.yml)，其 `insert` 行挂载插件。
正是这一声明让 `dsh plugin add` 能**一步安装并激活**本包。

### 从 npm 安装

本包已发布到 [npmjs.com](https://www.npmjs.com/package/dsh-session-bridge)。
发布由 `publish.yml` GitHub Actions 工作流在 `v*` 标签触发；发布前会把
`package.json` 与 `dsh.plugin.json` 的版本同步到该标签。

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-session-bridge
```

预发布标签（`v0.3.2-alpha.1`）会发布到自己的 dist-tag（`alpha`/`beta`/`rc`），
而不会占用 `latest`，因此不会顶掉其他用户使用的稳定版。需要显式选用：

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-session-bridge@alpha
```

pnpm 会安装发布的 tarball 并运行其 `prepare` 脚本（`tsdown`）以确保 `lib/` 就绪，
随后 `dsh` 激活该 bundle。

> **新版本发布后约 24 小时内，`@latest` 会解析到旧版本。** pnpm 11 默认开启供应链保护
> （[`minimumReleaseAge` 默认 1440 分钟](https://pnpm.io/zh/blog/releases/11.0)），发布不满
> 24h 的版本不参与解析；`minimumReleaseAgeStrict` 默认为 `false`，所以 **pnpm 会静默回退**到
> 最新一个"够老"的版本，不报错也不提示。此时 `pnpm view dsh-session-bridge dist-tags` 仍显示
> `latest` 是新版，但实际装到的是旧版——而旧版的 peer 范围可能已被新的 DSH 拒绝，于是出现
> "指定了 latest 却说版本不兼容"。三种解法：
>
> 1. 在使用方 profile 的 `pnpm-workspace.yaml` 里排除本包，`@latest` 立刻生效：
>    ```yaml
>    minimumReleaseAgeExclude:
>      - dsh-session-bridge
>    ```
> 2. 装本地 tarball（不经 registry 解析）：`dsh plugin --profile <p> add <路径>/dsh-session-bridge-x.y.z.tgz`；
> 3. 等满 24 小时。指定精确版本不能绕过该策略（会硬报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。

### 从 GitHub 安装

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:heartmove/dsh-session-bridge
```

`dsh plugin` 在 `~/.dsh/profiles/web/` 内转发给 pnpm，然后把本 bundle 归并到 profile 的
`dsh.profile.bundles` 层列表。git 安装会拉取源码，因此 pnpm 会在 checkout 后运行本包的
`prepare` 脚本（`tsdown`）从 `src/` 构建 `lib/`。

pnpm ≥ 10 默认拒绝运行 git 依赖的 `prepare` 脚本，首次 `add` 会报 "Ignored build scripts" 提示。
把 pnpm 打印出的包名复制到 profile 的 `pnpm-workspace.yaml`
（`~/.dsh/profiles/web/pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-session-bridge: true
```

然后重新运行 `add`。该放行表示"在安装时运行这个包的代码"——只放行源码可信的包，并锁定 commit
（`github:heartmove/dsh-session-bridge#<sha>`）以避免后续推送静默改变运行内容。

之后重启 `dsh web`，并强制刷新页面（Ctrl/Cmd+Shift+R）。

### 从本地 checkout 安装

在包含本 checkout 的目录下：

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add ./dsh-session-bridge
```

pnpm 链接该 checkout，`dsh` 以同样的方式激活 bundle。

### 手动 link

想手动管理 profile 时，把本包链接并列入 `~/.dsh/profiles/web/package.json` 的 bundles
（bundle 自带的 `cordis.patch.yml` 提供 loader 行，无需额外的 `insert` 条目）：

```json
{
  "dependencies": {
    "dsh-session-bridge": "link:D:\\path\\to\\dsh-session-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-bridge"]
    }
  }
}
```

（POSIX 系统用 `link:/path/to/dsh-session-bridge`。）然后在 profile 目录运行 `pnpm install` 并重启 `dsh web`。

### 直接注入（开发用）

开发调试阶段也可经注入器工具链直接加载（无需 bundle 条目）：

```bash
dev_inject_plugin D:\code\dsh-session-bridge
```

卸载用 `dev_uninject_plugin dsh-session-bridge`（清除注入器注册与 junction；重启不再自动装配）。

## 工具清单

| 工具 | 作用 |
|---|---|
| `session_bridge_create` | 创建主会话（当前或其它工作区，经 `workspaceId` / `cwd`）；可选首条 prompt + `waitForReply`；异步时返回 `sinceSeq` 锚点。 |
| `session_bridge_send` | 发消息（`mode=queue`/`steer`）；可选等待回复；异步时返回 `sinceSeq` 锚点。 |
| `session_bridge_wait` | 等待 `sinceSeq` 之后新输出（默认 = 调用时刻最新 seq，`-1` = 从头发算）：`waitFor=reply`（文本）或 `waitFor=segment`（任一已完成步骤即返回，无需等整个 turn）；可选 `requireTurnEnd`；零新输出时回落既有回复并置 `stale`。 |
| `session_bridge_read` | 读取消息 —— live 或离线；`sinceSeq` 分页、`role` 过滤、`limit`。 |
| `session_bridge_segments` | 增量读取已完成输出段落（每个已完成的 assistant 步骤）—— live 或离线。 |
| `session_bridge_resume` | 让持久化会话重新上线（幂等）。 |
| `session_bridge_find` | 跨工作区按 标题 / id / workspace / 目录 查找会话。 |
| `session_bridge_status` | 读取会话实时进度（running、openTurn、卡住检测、待处理、最新回复）及实时/已定型思维链（`reasoning` 参数）；`[STALLED]` 仅对 running 会话显示。 |
| `session_bridge_cancel` | 停止运行中的会话（中止活动 turn；`keepInbox` 保留排队/steering 输入）。 |
| `session_bridge_monitor_start` | 对一个主会话启动后台守护（轮询、催办、纠偏、终止、收尾）；支持思维链 `coRules`（如 reasoning not-contains "I'm" → cancel），以及**思维链循环检测**（默认开启：命中即中断原会话并把任务转移到新会话，含子代理处置 `loopDescendants`）。 |
| `session_bridge_monitor_stop` | 停止守护（会话本身不终止）。 |
| `session_bridge_monitor_list` | 列出活动守护及其状态。 |
| `session_bridge_archive` | 归档会话（从分组隐藏；历史与位置保留）；对运行中的会话需显式 `stopActivity: true`。返回受影响 id、集合规模与最新若干条。 |
| `session_bridge_unarchive` | 取消归档（回到原位置重新可见；未知/未归档 id 为幂等空操作）。 |
| `session_bridge_archived` | 列出归档集合（从最新往回，可选 `limit`，默认 50），可选为返回的 id 解析标题。 |

所有工具输出 lossless JSON；等待类工具超时不抛错，返回 `timedOut` / `aborted` / `stale` 标记。

## 项目结构

```
src/
  index.ts    host 插件入口（注册工具；挂载监控）
  core.ts     共享 host 逻辑（create/send/wait/read/find、status 快照、archive 记账）
  tools.ts    工具注册（bridge + status/cancel + monitor + archive）
  monitor.ts  后台守护循环（statusSnapshot + 规则 + 循环检测/转移 + 可选 LLM 判定）
  loop-guard.ts  思维链循环判定（纯函数：切单元 + 尾部周期重复 + n-gram 兜底）
  handoff.ts  交接提示词（任务/上下文提取 + 子代理分段 + 模板）
  session-create.ts  建会话的唯一实现（create 工具与循环转移共用）
  registry.ts 桥侧标题/workspace 登记表（~/.dsh/session-bridge-registry.json）
scripts/
  build.sh    类型检查 + 链接 DSH checkout 类型
  test-bridge-core.mjs  wait/卡住判定回归测试（npm test）
  test-loop-guard.mjs  循环判定回归测试：写。/好。/Go。 等形态（npm test）
  test-handoff.mjs  交接提示词回归测试：占位符 + 子代理分段（npm test）
  test-monitor-loop.mjs  守护循环端到端回归：转移/子代理五场景/预算/失败保留（npm test）
  test-tools-archived.mjs  归档 / 取消归档 + archived handler 回归测试（npm test）
  check-dsh-compat.mjs  对已安装 DSH 做 src/ 类型检查 + 校验产物来源（npm run check:compat）
  smoke-bundle.mjs  挂载构建产物 lib/index.js 并断言工具全部注册（npm run smoke）
```

## 生命周期与卸载

DSH ≥ 0.1.6 支持**运行时挂载/卸载**插件（设置 → 插件页开关、注入器热重载）。
本插件可干净卸载：不注册 loader 级状态，工具随插件 fiber 一并释放，监控定时器
经 `ctx.effect` 在卸载时清理。

该所有权模型带来一个后果：`session_bridge_create` 创建的会话归插件 fiber 所有
（agent 在插件上下文下创建），因此**卸载/重载插件会停止这些会话的活动 agent**。
会话本身已持久化并显示为离线，可用 `session_bridge_resume` 重新上线；守护循环
同样在卸载时停止。

## License

MIT
