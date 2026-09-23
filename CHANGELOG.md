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
