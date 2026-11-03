# 0.8.0

- **适配 DSH `0.2.2-alpha.3`，并修掉它引入的一个真破坏：`installModelSelection` 少了一个参数。** 上游把
  `installModelSelection(agentCtx, selection)` 改成 `installModelSelection(agentCtx)`——模型选择权从"调用方持有的可变引用"
  迁到了 `AgentModel` + 持久化的 `modelSelection` session 投影，函数本体只剩"装模型切换提示监听"这一件事。
  插件此前无条件传第二参数：在新宿主上不会报错，但**第二参数被静默忽略**，于是"继承调用方模型路由"这条语义从代码里消失，
  只剩 `agentOptions` 这条兜底在硬撑——一旦上游哪天不再把 `agentOptions` 当路由兜底，就会变成静默降级。
  现在 `src/session-create.ts` 里新增 `installModelSelectionCompat()`，按**形参个数**做特性探测：
  `length >= 2` 走老签名（传 `selection` 引用），否则走新签名（只传 `agentCtx`，选择由 `agentOptions` + 投影持有）；
  安装器缺失或抛错时返回 `false`，调用方退回自己挂的 `agent/request` 兜底钩子。**两条宿主路径都能拿到正确路由，
  所以运行时下限保持 `>=0.1.7-0` 不变**（能特性检测就不要抬下限，见 AGENTS.md §1）。
- **回归测试 +5 例（`scripts/test-tools-create.mjs`）**：两参数安装器必须收到调用方的 `selection`；一参数安装器必须
  **不带**第二参数调用（并断言桩函数真实 arity 为 1）；安装器抛错时返回 `false` 且打印可读原因；安装器缺失时返回 `false`；
  以及"已安装的 `dsh-agent` 安装器 arity 必须是 1 或 2"——上游若再改签名，这条会先红。
- **修掉 `session_bridge_status` 在"会话尚无标题事件"时整条失败（`value is not lossless JSON`）。** 此前
  `statusSnapshot` 无条件写 `title: titleOf(events)`，标题未产生时字段值是 `undefined`，宿主因此拒绝**整个** status 结果
  （与 0.3.3 修过的 archived 是同一类故障：桥刚 create、还没写 title 事件的会话一查状态就整条报错）。现在按
  `title === undefined ? {} : { title }` 省略字段——标题缺失只是信息缺失，不该让工具整体失败。
- **构建基线抬到 `0.2.2-alpha.3`（只动 devDependencies，不动运行时下限）。** 12 个 DSH dev 范围改为
  `>=0.2.2-alpha.3`；`cordis` 对齐到运行中 harness 的 `4.0.6-alpha.2`（DSH 0.2.2-alpha.3 把 Cordis Core 同步到
  `4.0.0-rc.11` 一线），`@deepseek-ai/schemastery` 对齐到 `3.18.6-alpha.2`。重建后 `check:compat --strict` 全绿：
  `lib/index.js` 内联 `0.2.2-alpha.3` + `cordis 4.0.6-alpha.2`，与已安装 harness **完全一致**。
- **逐项复核 `0.2.2-alpha.3` 的其它改动，确认对本插件无影响**：① `SessionStore` 现在要求"进入 + `session/created` 公告完成后"
  才允许 `append`（未公告前只读）——桥只经 `agents.create()` 与 `agent.followup()` 走宿主自己的发布路径，从不直接
  `session.append`；② `agents.create()` 的 `setup` 时机改到"会话已进入并公告之后、Agent 注册之前"，桥的 `setup` 只做
  `agentPresets.mount/composeFrom` 与模型选择安装，不依赖旧时机；③ `dsh-tools` 内部重构（`defineTool` 移到
  `contracts.ts`、`ToolDefinition` 拆分）对插件用法零影响，`defineTool` 仍从包根导出；④ 新 cordis 的配置校验改成走
  standard-schema（`runtime.Config["~standard"].validate`）——实测本插件的 `Config` 带 `~standard`（v1），校验后 9 个
  volatile 字段仍是稳定引用（`ref(true)`/`ref("reasoning")`/…），非法值（`loopGuard: "yes"`、`loopMinConfidence: 5`）
  仍被拒绝；⑤ `agentPresets.mount/composeFrom` 签名未变，`dsh-workspace`/`dsh-home-paths`/`dsh-util-values` 的
  `.d.ts` 与 0.2.1-rc.1 逐字相同。
- **闸门实测接受本版本。** 用运行中 harness（`0.2.2-alpha.3`）自己的 `evaluatePluginCompatibility` 对 `package.json`
  manifest 求值：`ACCEPTED`（`engines.dsh` 仍是 `>=0.1.7-0`，与 8 个 peer 逐字一致）。
- **全量验证**：`pnpm typecheck` / `pnpm check:compat --strict` / `pnpm test`（peer 下限守卫 + create 18 例 + config 20 例
  + archived 14 例 + V4 迁移 3 例）/ `pnpm build` / `pnpm smoke`（产物挂载并注册 15 个工具）全绿。
- **版本 0.7.0 → 0.8.0。**

# 0.7.0

> 0.6.0 从未发布到 npm（registry 上最高是 0.5.2），所以它下面的改动与本节一起，作为 **0.7.0** 交付。

- **思维链循环自动中断现在有两条开启路径，共用同一份配置。** 总开关与全局默认值放进插件 `Config`（9 个字段全部标 `volatile`）：① 斜杠命令 `/cot-loop on|off|status|...` 直接改——写回 profile patch，Loader 走 volatile-only 提交，**立即生效、不需要重启或重载插件**；② 设置 → Plugins → `dsh-session-bridge` 的表单自动渲染这些字段（`dsh-settings` 只把 volatile 字段渲染成控件，所以设置页这一半**不需要客户端代码**）。单个守护仍可用 `session_bridge_monitor_start({ loopGuard: false })` 单独关闭。
- **`/cot-loop` 子命令**：`on` / `off` / `status` / `field <reasoning|text|both>` / `descendants <report|stop|ignore>` / `max-transfers <n>` / `min-cycles <n>` / `min-repeats <n>` / `min-hits <n>` / `cooldown <ms>` / `confidence <f>` / `reset` / `help`。参数类改动从**下一个** `monitor_start` 起生效；`on` / `off` 对**已运行**的守护立即生效（守护每 tick 实时读 volatile 引用）。宿主没有 `configEditor` 服务或写回失败时退化成**本进程内存开关**，回执里明确写"仅本次运行有效"，不会假装持久化成功。
- **`Config` 必须 volatile，且 schemastery 必须留在外部依赖里（打包踩坑记录）。** `volatile()` 由 schemastery 装在 `Schema.prototype` 上；一旦把它内联进 bundle，rolldown 会把那条 prototype 赋值当死代码摇掉，产物里的字段就**静默丢掉** `meta.volatile`，设置页看不到开关（实测：内联时 `Config.toJSON()` 里 `meta.volatile` 直接消失，改回外部依赖后恢复）。因此 `@deepseek-ai/schemastery` 改为外部依赖（`deps.neverBundle`，peer `^3.18.4`）——它不在 `@deepseek-ai/dsh*` 前缀内，不参与兼容性闸门，宿主本来就装着它（官方插件同样从宿主解析）。产物由 686.89 kB 降到 620.55 kB。
- **新增 `src/config.ts`（Config schema + LoopPolicy）与 `src/commands.ts`（命令 + 写回配置）。** `LoopPolicy.enabled()` 是 `override ?? config.loopGuard ?? true`：`override` 只用于"写不回配置"的退化路径；`defaults()` 让守护没显式传参时用插件级全局默认值，非法值一律回落/裁剪而不抛错。`createConfigWriter` 按 `options.id === 'dsh-session-bridge'` 定位 profile entry，再 `configEditor.edit()` 把 patch 合并进当前 config。两个服务（`commands` / `configEditor`）都用 `ctx.inject` 运行时探测，缺失时静默跳过——不新增任何 peer 依赖，也不动下限 `>=0.1.7-0`。
- **回归测试 +20 例（`scripts/test-config.mjs`，已接入 `pnpm test`）**：断言 9 个字段全部 volatile（否则设置页不显示）、`Config({})` 解析出稳定引用与文档默认值、`readValue` 兼容引用与裸值、引用原地更新立即翻转开关、内存覆盖优先与 `reset` 回退、非法值回落/裁剪、各子命令写回的字段、非法输入的报错文本、`registerLoopCommands` 在 `commands` 服务存在/缺失/无 `inject` 三种情形下的行为、`createConfigWriter` 定位 entry 与合并 patch、entry 或服务缺失时的可读原因。
- **`scripts/smoke-bundle.mjs` 增加产物级断言**：产物必须导出 volatile 的 `Config`（设置页读的就是它）、必须在宿主提供 `commands` 时注册 `cot-loop`、命令 `on` 必须把 `loopGuard: true` 写进配置、插件开关关闭时 `monitor_list` 必须显示 `plugin switch`。
- **文档**：`README.md` / `README.zh.md` 的循环小节新增「开启与关闭（两种方式）」与插件配置字段表；`session_bridge_monitor_start` 的描述说明插件级开关与单守护开关的区别。
- **适配 DSH `0.2.1-rc.1` 的兼容性策略变化：`engines.dsh` 变成权威声明。** 官方发布说明写明「第三方插件的版本兼容性优先按 `engines.dsh` 判断；未声明时沿用原有规则。插件作者需检查声明是否覆盖支持的 DSH 版本」。闸门实现（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）实测确认：**声明了 `engines.dsh` 就只由它裁决，`peerDependencies` 全部忽略**（旧闸门恰好相反，只认 peer）。本插件此前只在 `dsh.plugin.json` 里写 `engines.dsh`，而那个文件在整个 0.2.x 里**没有任何读取方**（实测 grep CLI `0.2.1-rc.1` 与桌面版 `0.2.0-rc.2` 两棵安装树，零命中；真正挂载插件的是 `package.json` 的 `dsh.bundle.patch`），所以此前一直是 peer 在把关。现在把 `engines.dsh: ">=0.1.7-0"` 写进 `package.json`，与 peer 下限逐字一致。
- **下限不变，兼容承诺不变。** `0.2.1-rc.1` 上 `src/` 零类型错误、产物照常注册 15 个工具，没有任何 API 破坏，所以 peer 与 `engines.dsh` 都保持 `>=0.1.7-0`：`0.1.7-0` 起的旧 harness 走"没有 `engines.dsh` 就回落 peer"的路径，行为与之前完全一致。实测矩阵（同一 manifest，用两版 harness 各自的闸门求值）：peer 全下限 + `engines.dsh` 下限 → `0.2.0-rc.2` ✅ / `0.2.1-rc.1` ✅；删掉 `engines.dsh`（回落 peer）→ 两版都 ✅；`engines.dsh` 写窄成 `^0.1.7-0` → 旧闸门 ✅（忽略 engines）、新闸门 ❌ `{"engines.dsh":"^0.1.7-0"}`；peer 带上界 + `engines.dsh` 下限 → 新闸门 ✅（**peer 被忽略**）；peer 出现空范围 → 旧闸门 ❌、新闸门 ✅（**peer 被忽略**）；peer 全写 `workspace:*` → 两版都 ✅（只在 peer 里表示"当前运行时"，写进 `engines.dsh` 则无效）。**后两行说明：新闸门下 `engines.dsh` 一存在，peer 的错误就完全不参与判定——它在 `0.2.1-rc.1` 上"看不见"，却会在 `0.2.0-rc.2` 这类旧 harness 上直接拒装**，所以守卫仍然强制校验 peer。
- **`scripts/test-peer-floor.mjs` 守卫升级**：新增"`package.json` 的 `engines.dsh` 必须存在、纯下限、与 peer 下限逐字一致"，`dsh.plugin.json` 的遗留声明仍需一致。六类回归都实测会红：peer 带上界、`engines.dsh` 缺失、`engines.dsh` 写窄、`dsh.plugin.json` 漂移、dev 范围钉死、dev 范围低于下限。
- **构建基线抬到 `0.2.1-rc.1`（只动 `devDependencies`，不动运行时下限）。** 12 个 DSH dev 范围改为 `>=0.2.1-rc.1`，产物重新内联 `0.2.1-rc.1`；内联的 `cordis` 同步从 4.0.4 对齐到 4.0.5（运行中的 harness 声明 `~4.0.5`），`check:compat` 的 cordis 漂移提示随之消失，产物 612.72 kB。
- **两个 `pnpm update` 陷阱（已写进 AGENTS.md §2）**：① semver 规定预发布只在 comparator 的 `major.minor.patch` 相同时参与匹配，所以 `>=0.2.0-rc.1` **解析不到** `0.2.1-rc.1`（实测 `pnpm update` 直接报 `Already up to date`、`pnpm list` 仍是 `0.2.0-rc.2`）——每遇到新 tuple 就要把那 12 个 dev 范围抬到 `>=<新 tuple>-rc.x`；② `pnpm update` 会把 dev 的 `>=` 下限**改写成精确钉版**（实测 12 个全被写成 `0.2.0-rc.2`，守卫立刻报 `must be a floor-only range`），所以每次都要 `git diff package.json` 复核改回。
- **桌面版验证路径已失效需更正**：`0.2.0-rc.2` 起 `resources\app.asar` 已展开为 `resources\app\`（只剩 `app.asar.bak`），`resources\runtime\cli\bin\dsh.cmd` 仍按 `app.asar` 拼路径，实测报 `Cannot find module ...app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`。验闸门要直接 import `resources\app\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`（实测桌面版 `0.2.0-rc.2` 对本 manifest ✅）。
- **`pnpm-workspace.yaml` 白名单规范化**：新增的 `dsh-fs` / `dsh-working-directory` 按本仓库约定只列包名不带版本，去掉锁文件里已不存在的旧版本号，并移除已随 `0.2.1-rc.1` 从运行时删掉的 `dsh-invariants`。
- **修掉一个只在干净安装（CI/Linux）才暴露的构建失败：导出的 `Config` 必须显式命名类型。** 发版时 CI 的 Build 步骤直接红掉、`Publish to npm` 被跳过：`src/config.ts(34,14): error TS2742: The inferred type of 'Config' cannot be named without a reference to '.pnpm/@deepseek-ai+schemastery@3.18.5/node_modules/@deepseek-ai/schemastery'. This is likely not portable. A type annotation is necessary.` ——本机 `pnpm build` 全绿，是因为 `build.sh` 在 `node_modules/` 里建了指向本地 dsh checkout 的 junction（`node_modules/schemastery` → `D:\code\deepseek-harness\vendor\schemastery`），类型解析落到了稳定路径；CI 是干净安装，解析到 pnpm 虚拟 store 的深路径。改为 `export const Config: z<PluginConfig> = z.object({ ... })`（与官方插件 `.d.ts` 的 `export declare const Config: Schema<X>` 写法一致），产物 `.d.ts` 里只剩包名 `@deepseek-ai/schemastery`。已在**干净目录**（`git archive HEAD` + `pnpm install --frozen-lockfile`）里复现该失败、并验证修复后 `typecheck`/`test`/`build`/`smoke` 全绿；"发版前用干净目录复现一次 CI 的 build"已写进 AGENTS.md §2 坑 3。

# 0.6.0

- **新增思维链循环检测：命中即中断原会话，并把任务转移到新会话。** 用户的原始诉求是「写。/好。/Go。」这种反复自问自答——`stalledMs` 卡住判定对它**天然失明**（每转一圈都有新事件，距最近事件始终很小，永远到不了阈值），`coRules` 的 `contains` / `not-contains` 也表达不了「同一小段周期重复」。新增 `src/loop-guard.ts`（纯函数、零宿主依赖）：把思维链按 `。！？；!?;` 与换行切成单元（**标点保留在单元内**，所以 `写。` 与 `好。` 是两个不同单元），在 1200 字符的**尾部窗口**内用「尾部连续段」扫最小周期，再用字符 n-gram 重复率兜底无标点的情况。`session_bridge_monitor_start` 默认开启（`loopGuard: false` 关闭），判定参数全部可调：`loopField`（reasoning/text/both）、`loopMinCycles`、`loopMinRepeats`、`loopMinConfidence`、`loopMinHits`、`loopCooldownMs`、`loopMaxTransfers`、`loopTransfer`、`loopAutoMonitor`、`loopDescendants`、`loopHandoffPrompt`、`loopTransferDepth`。
- **动作顺序不可颠倒：先建新会话、投递交接提示词，成功之后才中断原会话。** 反过来（先停后建）一旦创建失败任务就丢了；现在「创建失败 = 保持原监控、什么都不停」，并按 `max(intervalMs, 10s)` 节流重试。交接提示词（`src/handoff.ts`）携带原会话 id、任务指令、最近指令 / 最后回复 / 最后思维链摘要与子代理清单，并要求新会话用 `session_bridge_read` 自己读原会话日志（不塞全文，省 token）。转移链继承同一份转移记录，所以**转移预算不会随新会话重置**；预算耗尽（默认 `loopMaxTransfers: 3`，同时是深度上限）或 `loopTransfer: false` 时只中断（`LOOP-CANCEL`）。
- **子代理处置明确化（回答「子代理要不要一起停」）。** 判定「谁是子代理」优先用宿主能力（`agents.isOwnedBy` / `roots()`），拿不到时回落会话 header 的 `origin === 'subagent'` / `parentSession`，再拿不到按顶层处理——**只会少转移，不会乱转移**。五种场景：A) 主会话循环、子代理仍在正常跑 → **不取消**，列进交接提示词并注明「不要重做」（`loopDescendants: 'report'`，默认）；B) `loopDescendants: 'stop'` → 转移**前**逐个取消并记入 `stopped`；C) `'ignore'` → 不取消也不写进交接；D) **子代理**循环（主会话正常）→ 取消该子代理 + `steer` 主会话重派，**不转移**（坏的是子任务）；E) **子代理会话自己**是监控目标且循环 → **只取消不转移**（它的身份是子代理，另建顶层会话会打乱执行树），父会话收到通知。
- **`session_bridge_create` 的建会话逻辑抽成 `src/session-create.ts`，与循环转移共用一份实现。** 工具与守护循环必须走同一条路径（目标 cwd 解析 → 模型继承 → `agents.create` + setup → workspace 记账 → 可选首条 prompt），否则转移出来的会话会缺字段或记账不一致。工具参数与返回值**完全不变**。
- **回归测试 +23 个用例（`pnpm test` 已接入）。** `scripts/test-loop-guard.mjs`（20 例）：报告的 `写。/好。/Go。`×3 → `period=3 repeats=3`；`3 单元 × 2 轮` 与 `2 单元 × 2 轮` 不命中（重复次数下限 3）；长前缀不掩盖尾部循环；尾部窗口有界；无标点重复走 `kind=char` 兜底；`splitUnits` / `tailPeriodicRepeat` / `charRepeatRate` 边界。`scripts/test-handoff.mjs`（11 例）：占位符替换、任务/上下文提取（含进行中推理回落）、子代理三类分段与「已终止的不再出现在仍在运行段」、超量折叠、自定义模板。`scripts/test-monitor-loop.mjs`（16 例）：用桩宿主驱动**真实** `SessionMonitor`——顶层循环 → 新会话创建 + 交接提示词 + 原会话带 `chain-of-thought loop detected` 原因中断 + 监控迁移（`loopTransferDepth=1`）；`loopGuard:false` / 空闲会话 / 正常长推理都不触发；子代理五场景全测；深度上限、`loopTransfer:false`、创建失败保留原监控、`loopMinHits` 连续命中、`loopAutoMonitor:false`；以及 `monitor_start` 的 13 个 `loop*` 参数逐一映射到配置、`monitor_list` 渲染循环行。
- **`scripts/smoke-bundle.mjs` 增加产物级断言。** 光有 `src/` 测试证明不了跑的是新产物：现在断言产物**内联了循环守卫**（`chain-of-thought loop detected` / `LOOP-TRANSFER` / `LOOP-SUBAGENT-CANCEL` / 交接提示词文案）、`monitor_start` 暴露全部 `loop*` 参数、描述里写明循环检测，且在**没有 `agents.roots()` / `isOwnedBy()`** 的桩宿主上依然能挂载并跑 `monitor_start` / `monitor_list` / `monitor_stop`（旧 harness 的降级路径）。
- **`SessionMonitor` 构造函数改为显式字段赋值。** 原来用 TS 参数属性，而本仓库的测试用 `node --experimental-strip-types` 直接跑 `src/*.ts`，Node 的 strip-only 擦除不支持参数属性——不改这一处，守护循环就没法被端到端测试直接 import。行为零变化。
- **版本 0.5.2 → 0.6.0。** peer 下限保持 `>=0.1.7-0` 不变（新增功能只用了既有的 `agents.get/list`、`sendLiveMessage`、`cancel`，`roots()` / `isOwnedBy()` 都做了特性检测与回落，旧 harness 上只是退化为「按顶层处理 + header 兜底」）。`pnpm typecheck` / `check:compat` / `test` / `build` / `smoke` 全绿。

# 0.5.2

- **查明"指定了 `@latest` 仍装到 0.4.0"的真正原因：pnpm 11 的 `minimumReleaseAge` 默认 24 小时。** pnpm 11 默认开启供应链保护，[`minimumReleaseAge` 默认 `1440` 分钟](https://pnpm.io/zh/blog/releases/11.0)，registry 上发布不满 24h 的版本不参与解析；而 `minimumReleaseAgeStrict` 默认 `false`，所以 pnpm **静默回退**到最新一个"够老"的版本——本次实测把 `dsh-session-bridge@latest` 解析成了 `0.4.0`（`pnpm view dist-tags` 仍显示 `latest: 0.5.1`，两者不一致正是这个原因），随后闸门按 0.4.0 的旧 peer 报 `incompatible-version`；换精确版本 `@0.5.1` 则直接 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（cutoff 恰为 now-1440min）。三种解法均实测通过：使用方 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: [dsh-session-bridge]`（`@latest` 立刻解析到 0.5.1）、装本地 tarball（实测装到 0.5.2）、等满 24h（0.5.1 于 `2026-09-28T22:08:01Z` 发布，即 `2026-09-30 06:08` Asia/Taipei 之后自动可解析）。AGENTS.md 与 README 已记录该坑与排查路径（先看日志里**实际解析到的版本**，再查那个版本的 peer）。
- **按 DSH `0.2.0-rc.2` 重建并验证。** 桌面版 harness 已升到 `0.2.0-rc.2`，本版把锁定的发布依赖从 `0.2.0-rc.1` 升到 `0.2.0-rc.2` 并重建宿主 bundle。`pnpm typecheck`（`src/` 对 rc.2 的 `.d.ts`）、`pnpm test`、`pnpm build`、`pnpm smoke` 全绿——**rc.1 → rc.2 没有任何 API 破坏，代码无需改动**；产物内联版本与运行中的桌面版 harness 一致（原先内联的是 rc.1）。
- **实测：桌面版 harness 自身的兼容性闸门接受本插件。** 用桌面版 `app.asar` 里的 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）对 `package.json` 的 manifest 求值：`0.2.0-rc.1` ✅ `0.2.0-rc.2` ✅ `0.2.0` ✅ `0.3.0-rc.1` ✅ `0.3.0` ✅ `1.0.0` ✅（下限 `>=0.1.7-0` 不设上界，后续版本默认兼容）；把同一 manifest 的 peer 换回 0.4.0 的 `^0.1.7-0` 则 `0.2.0-rc.2` ❌——这正是用户报的"装了但提示版本不对"。
- **新增 `AGENTS.md`：把版本策略写成硬性规则。** 所有 `@deepseek-ai/dsh*` 的 `peerDependencies` 只能是 `>=x.y.z[-pre]` 形式的下限，禁止 `^` / `~` / 精确版本 / 上界；同时记录闸门机制、判据出处（`peerDependencies`，而非不被强制校验的 `engines.dsh`）、每次 DSH 发版后的升级-验证-重建清单，以及桌面版 harness 的单独验证方法（`ELECTRON_RUN_AS_NODE=1` + `app.asar` 内的 `dsh-app-boot`）。`dsh.plugin.json` 的 `engines.dsh` 保持 `>=0.1.7-0` 不变。
- **`AGENTS.md` 另立一条：破坏性变更时必须同步抬高下限。** 下限不是永恒值——上游一旦有破坏性变更（删/改 API、改协议或事件形状）导致必须改代码才能发布，抬下限就是"改代码 + 发版"这个动作的一部分：只改代码不动下限，闸门会**放行**一个已按新 API 写好的版本，用户装到旧 harness 上不被拦截、改为运行期崩溃，比抬下限更糟。清单（缺一处就声明与行为不一致）：8 个 peer → `engines.dsh` → 12 个 devDependencies 范围 → 全量验证 → 桌面版验闸门 → README/CHANGELOG 写明破坏点与放弃的旧版本。同时划清边界：上游只是发新版或新增 API **不**抬下限；能用运行时特性检测兼容就优先不抬；无论抬到哪都不许加上界。
- **新增 `scripts/test-peer-floor.mjs` 作为机器守卫**（已接入 `pnpm test`）：校验每个 `@deepseek-ai/dsh*` peer 都是纯下限、所有 peer 用同一个下限、`engines.dsh` 与 peer 下限**逐字一致**、两个 manifest 的版本号一致、12 个 devDependencies 的下限不低于 peer 下限（防止"抬了 peer 忘改 dev/engines"）；并先自检判定函数能拒绝 `^0.1.7-0` / `~` / 精确版本 / `>=a <b` / `||` / `workspace:*` / `*`。四类回归（带上界、engines 漂移、dev 低于下限、版本号不一致）都实测会失败。CI 与发布工作流都跑 `pnpm test`，所以把范围写回上界、或抬下限时漏改声明，会直接让流水线红掉，不会再悄悄退回 0.4.0 那种"装不上"的状态。

# 0.5.1

- **产物内联的 cordis 对齐到运行中的 harness。** bundle 会把 `@deepseek-ai/cordis` 一起内联（`alwaysBundle` 把所有非 `node:` 依赖都打进去），而 devDependency 一直钉在 `4.0.3`：DSH `0.2.0-rc.1` 的包声明 `cordis ~4.0.4`，运行中的 harness 装的是 `4.0.4`，于是产物里跑的是另一份 cordis。devDependency 改为 `npm:@deepseek-ai/cordis@^4.0.4`（范围而非钉死），重建后产物内联 `4.0.4`，与已安装版本一致；`pnpm peers check` 不再报 `unmet peer @deepseek-ai/cordis`。功能无改动，15 个工具行为不变。
- **`check:compat` 现在单独跟踪 cordis 漂移。** 此前来源校验只统计 `dsh-*` 版本（cordis 与 DSH 发版节奏不同，混在一起会永远报错），结果是"产物内联 cordis 4.0.3 / 宿主 4.0.4"这类漂移完全看不见。现在 cordis 单独成组，与**已安装的 cordis** 比对：一致则确认，不一致按同一策略给提示（`--strict` 下判失败）。用伪造 scope（harness 0.3.0-rc.1 + cordis 4.0.5）实测过三个分支。
- **`pnpm-workspace.yaml`** 里 cordis 的 `minimumReleaseAgeExclude` 同样去掉版本（与上一版对 DSH 包的处理一致）。

# 0.5.0

- **去掉强版本绑定：peer 只声明下限。** 此前 `peerDependencies` 写的是 `^0.1.7-0`（等价于 `>=0.1.7-0 <0.2.0`），harness 一升到 `0.2.0-rc.1`，DSH 的插件兼容性闸门就把整个 bundle 判为 `incompatible-version` **静默跳过**——本插件在运行中的 web profile 里根本没挂载，`session_bridge_*` 全部不可用（实测 `dsh --profile web --dump-config` 报 `skipping profile bundle "dsh-session-bridge"`）。现在 8 个 peer 全部改为 `>=0.1.7-0`：只保留下限、不设上限，后续版本默认兼容，不再需要按版本逐个发版或申请 exact-version 豁免。`dsh.plugin.json` 的 `engines.dsh` 同步改为 `>=0.1.7-0`。
- **构建与类型检查对齐运行中的 harness（0.2.0-rc.1）。** devDependencies 从锁定 `0.1.7-rc.1` 改为 `>=0.2.0-rc.1`（lockfile 仍固定到具体版本，CI 用 `--frozen-lockfile`），产物按 0.2.0-rc.1 重建。`pnpm typecheck`、`pnpm check:compat`、`pnpm test`、`pnpm smoke` 全绿——**0.2.0-rc.1 上没有任何 API 破坏，代码无需改动**，此前只是被版本闸门挡住。
- **`check:compat` 的来源校验不再是"必须完全一致"。** 旧规则要求 `lib/index.js` 内联的 DSH 版本与已安装 harness 逐字相同，等于每次 harness 升级都红灯。新规则只把"内联版本**低于**声明下限（0.1.7-0）"判为失败，其余漂移给出提示（含 `pnpm build` 的建议）；传 `--strict` 或 `DSH_COMPAT_STRICT=1` 可恢复旧的严格判定。三个分支都用假 scope（伪造 0.3.0-rc.1）与伪造下限实测过。
- **`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 不再绑定版本。** 原先每个 `@deepseek-ai/dsh-*` 都钉着 `0.1.7-alpha.1 || 0.1.7-rc.1`，新版本会被 install 策略挡住；现在只列包名，DSH 发布当天即可安装。cordis / schemastery 与 DSH 不同步发版，仍保持钉版本。
- **归档结果不再回显整个归档集合。** `session_bridge_archive` / `session_bridge_unarchive` 过去把集合里每个 id 都塞进工具结果——作者的 profile 已有 200+ 个归档会话，单次调用实测约 4k token，真正的结果被埋在 id 列表里。现在报告"受影响 id + 集合规模 + 最新 20 条（其余以 `+N earlier omitted` 概括）"；返回值的 `archivedSessionIds` 保持完整不变。
- **`session_bridge_archived` 新增 `limit`（默认 50，最大 500，从最新往回取），`total` 始终是真实规模。** `resolveTitles: true` 也只解析返回的这段 id（此前会对几百个会话逐个读日志），列表被截断时渲染会先给出 `N archived; newest M:` 表头。
- **回归测试 ×5 + 产物冒烟断言。** `scripts/test-tools-archived.mjs` 新增：archive 渲染只摘要不整列、unarchive 渲染同规则且被移除 id 不再出现、`limit` 取最新一段且 `total` 不变、非法 `limit` 在读注册表前即被拒、`resolveTitles` 只读取返回的 id；`scripts/smoke-bundle.mjs` 增加产物级断言（内联构件确实带 `limit`、渲染确实有界），因为 `src/` 测试抓不到"产物是旧版"的情况。
- **运行中宿主实机复测 15 个工具全部通过（DSH 0.2.0-rc.1）。** create（含 `sinceSeq` 锚点）/ send（queue + steer 打断 25s 睡眠任务）/ resume（offline → live，跨工作区标题解析）/ wait（新回复、`waitFor: segment`、零新输出回落既有回复并标 `[stale]`）/ segments（turn 中途的 reasoning 段）/ read（live + 归档中的 offline 会话）/ find（live、offline、`liveOnly`、按 bridge 别名命中）/ status（running + `openTurn: yes` + 实时思维链、idle、`stalledMsThreshold`）/ cancel（清空 inbox）/ monitor_start + monitor_list + monitor_stop（含"目标空闲且无待处理即自动收尾"后 `monitor_stop` 返回 no active monitor）/ archive（活跃会话拒绝 + 提示、`stopActivity: true` 归档并停掉运行中工作、空闲直接归档）/ unarchive / archived。注意：运行中的宿主缓存已加载的模块，本次的渲染改动需重启（或热重载）后才生效——实机里旧构件仍返回完整列表。

# 0.4.0

- **修复产物与运行中 harness 不一致。** `lib/index.js` 此前内联 DSH `0.1.7-alpha.2`，而运行中的 harness 是 `0.1.7-rc.1`，`pnpm check:compat` 因此红灯（"the built lib/index.js inlines DSH ... but the installed harness is ..."）。锁定的 devDependencies 升到 `0.1.7-rc.1` 并重建宿主 bundle；现在 `check:compat` 全绿：`src/` 对 rc.1 类型检查通过，且产物内联版本与运行中 harness 一致。
- **新增 `session_bridge_unarchive`。** 把会话移出 workspace 全局归档集合，回到它记录的位置重新可见（官方 `unarchiveSession` 的桥侧入口）。此前会话桥只能归档不能取消归档，撤销必须回到 UI 手动操作。未知 / 未归档 id 为幂等空操作。
- **`session_bridge_archive` 新增 `stopActivity` 参数。** 归档一个仍在运行的会话会被官方注册表拒绝（`the session is active (turn)`），而桥侧此前无法表达"先停掉再归档"——该参数对应官方 `ArchiveSessionOptions.stopActivity`：先写归档、再经官方 `workspace/session-stop` 路径停掉其运行中工作（turn、子 agent、job、schedule）。被拒绝时的报错现在附带你该传 `stopActivity: true` 的提示。
- **回归测试。** `scripts/test-tools-archived.mjs` 用桩宿主驱动真实注册的 handler，新覆盖 archive 的"活跃会话拒绝 + 提示""`stopActivity` 透传并归档成功"与 unarchive 的"移除并返回剩余集合""未归档 id 幂等""空 id 先校验"；工具总数断言 14 → 15。
- **新增产物挂载冒烟测试。** `scripts/smoke-bundle.mjs`（`pnpm smoke`）把构建出来的 `lib/index.js` 挂到一个桩宿主上下文上，断言 15 个工具全部注册、archive/unarchive handler 在**产物**里可用、且产物不含 `0.1.7-alpha` 残留；CI 与发布 workflow 都在 `pnpm build` 之后跑它——`check:compat` 只能证明来源版本一致，证明不了产物能加载。
- **运行中宿主实机复测。** 14 个既有工具全部按预期工作：create / send（queue+steer）/ resume / wait（新回复、`stale` 回落）/ segments / read（live+offline）/ find / status（含实时思维链）/ cancel / monitor_start / monitor_stop / monitor_list / archived（`resolveTitles: true`）；`archive` 的活跃会话拒绝路径在实机复现，其成功路径与 `unarchive` 由上述桩测试与产物冒烟测试覆盖。注意：运行中的宿主加载的是上一版 bundle，新工具与 `stopActivity` 需重启（或热重载）后才出现在工具列表里。

# 0.3.3

- 修复 `session_bridge_archived`（`resolveTitles: true`）在归档集合里存在"没有标题事件、也没有首条用户消息"的会话时，整个工具调用报 `value is not lossless JSON` 并失败：解析不出标题的会话现在直接省略 `title` 字段（不再写入 `undefined`），标题缺失不再升级成整体失败。新增 `scripts/test-tools-archived.mjs`，用桩宿主上下文驱动真实注册的 handler 覆盖该路径。
- 适配 DSH `0.1.7-alpha.2`：锁定的发布依赖升到 `0.1.7-alpha.2` 并重建宿主 bundle，使 `check:compat` 的产物来源校验与运行中的 harness 一致（此前 bundle 内联的是 `0.1.7-alpha.1`）。
- 运行中的宿主里实机验证 13 个工具通过（create / send / resume / wait / segments / read / find / status / cancel / monitor_start / monitor_stop / monitor_list / archive）；`session_bridge_archived` 的 `resolveTitles` 路径由上述测试驱动真实 handler 覆盖（宿主已加载旧代码，改动需重启后生效）。
- `pnpm test` 现在包含三项：wait/卡住核心回归、archived handler 回归、V3→V4 迁移回归。

# 0.3.3-alpha.1

- 适配 DSH `0.1.7-alpha.1`，迁移到 `dsh-agent-preset-registry`，最低版本声明同步为 `^0.1.7-0`。
- 保留由官方持久化层读取和迁移 V3/V4 日志的路径，新增官方迁移器回归测试，验证缺失 `turn/end` 的修复、重编号后的游标及恢复会话的状态判断。
- 本地和 CI 统一使用锁定的发布依赖；构建无需本地 DSH checkout，生成宿主 bundle 和类型声明。
- 修复 Windows 下 pnpm 缩短目录名导致 bundle 来源版本被误判的问题。

V3→V4 迁移可能插入事件并改变 seq。跨升级保留的旧 sinceSeq 游标应通过重新读取会话刷新；插件不自行改写用户日志或执行批量迁移。
