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
