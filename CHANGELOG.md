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
