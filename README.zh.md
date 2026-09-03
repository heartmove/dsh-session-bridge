# dsh-session-bridge — 会话桥（Session bridge）

一个 [DSH](https://www.deepseek.com) 插件：让当前 agent 能通过提示词驱动其它真实的 DSH 会话——
创建主会话、向任意会话发消息、等待并读取回复、恢复离线会话、跨工作区按名称或 id 查找会话。
在此之上，它还能**监控并调度**一个主任务（观察进度、卡住时催办、偏离时纠偏、必要时终止），
以及像 DSH 侧边栏的 Archive 一样**归档**会话。

> English docs: [README.md](./README.md).

## 功能

- **创建真实 DSH 会话。** `session_bridge_create` 在当前工作区创建新的主会话（顶层 UI 会话），
  传 `workspaceId` / `cwd` 则跨工作区；可选发送首条 prompt 并阻塞等待首条回复。provider / model /
  reasoning effort 默认继承调用会话。
- **向任意会话发消息。** `session_bridge_send` 追加一轮（`mode=queue`）或向运行中的步骤注入
  steering（`mode=steer`），可选等待下一条回复。
- **等待回复。** `session_bridge_wait` 阻塞直至 `sinceSeq` 之后出现新的带文本 assistant 回复；
  开 `requireTurnEnd` 则同时等待回合收尾。超时 / 中止返回部分结果，而非抛错。
- **读取任意会话。** `session_bridge_read` 把会话事件日志折叠为可读行——live 或离线（持久化）均可；
  支持 `sinceSeq` 分页、role 过滤、`limit`（默认 20，最大 100）。
- **恢复离线会话。** `session_bridge_resume` 让持久化会话重新上线（幂等），可覆盖 provider / model。
- **查找会话。** `session_bridge_find` 跨全部工作区按 标题 / id / workspace / 目录 匹配，返回
  live/running 状态、标题、工作目录；bridge 登记的标题作为别名参与匹配。
- **监控并调度主任务。** `session_bridge_status` 读取会话实时进度（running/idle、是否 `openTurn`、
  距最近事件毫秒数做卡住检测、待处理消息、最新回复）；`session_bridge_cancel` 停止一个运行中的会话；
  `session_bridge_monitor_start` 运行一个**后台守护循环**，轮询任务、卡住时催办、偏离时纠偏、
  持续卡住则终止、完成即收尾。
- **归档会话。** `session_bridge_archive` 把会话加入 DSH workspace 归档集合（从所有分组视图隐藏，
  历史与位置保留）；`session_bridge_archived` 列出归档集合，可选解析标题。

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

守护只对 **running** 会话判定"卡住"，因此已完成/空闲的任务会被收尾而非无限催办。日志写入
`~/.dsh/super-injector/dsh-session-bridge-monitor.log`（可用 `logFile` 覆盖）。

用 `session_bridge_monitor_start` / `_stop` / `_list` 控制。

## 环境要求

- [Node.js](https://nodejs.org) ≥ 20
- [pnpm](https://pnpm.io)
- DSH ≥ `0.1.0-rc.6`

## 构建

```bash
# 类型检查 + 打包 host bundle + 生成 tgz（DSH_CHECKOUT 指向 dsh 源码 checkout）
bash scripts/build.sh && npm run build:client

# 或经注入器工具链
dev_build_plugin dsh-session-bridge
```

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

pnpm 会安装发布的 tarball 并运行其 `prepare` 脚本（`tsdown`）以确保 `lib/` 就绪，
随后 `dsh` 激活该 bundle。

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
| `session_bridge_create` | 创建主会话（当前或其它工作区，经 `workspaceId` / `cwd`）；可选首条 prompt + `waitForReply`。 |
| `session_bridge_send` | 发消息（`mode=queue`/`steer`）；可选等待回复。 |
| `session_bridge_wait` | 等待 `sinceSeq` 之后新的带文本 assistant 回复；可选 `requireTurnEnd`。 |
| `session_bridge_read` | 读取消息 —— live 或离线；`sinceSeq` 分页、`role` 过滤、`limit`。 |
| `session_bridge_resume` | 让持久化会话重新上线（幂等）。 |
| `session_bridge_find` | 跨工作区按 标题 / id / workspace / 目录 查找会话。 |
| `session_bridge_status` | 读取会话实时进度（running、openTurn、卡住检测、待处理、最新回复）。 |
| `session_bridge_cancel` | 停止运行中的会话（中止活动 turn；`keepInbox` 保留排队/steering 输入）。 |
| `session_bridge_monitor_start` | 对一个主会话启动后台守护（轮询、催办、纠偏、终止、收尾）。 |
| `session_bridge_monitor_stop` | 停止守护（会话本身不终止）。 |
| `session_bridge_monitor_list` | 列出活动守护及其状态。 |
| `session_bridge_archive` | 归档会话（从分组隐藏；历史与位置保留）。 |
| `session_bridge_archived` | 列出归档集合，可选解析标题。 |

所有工具输出 lossless JSON；等待类工具超时不抛错，返回 `timedOut` / `aborted` 标记。

## 项目结构

```
src/
  index.ts    host 插件入口（注册工具；挂载监控）
  core.ts     共享 host 逻辑（create/send/wait/read/find、status 快照、archive 记账）
  tools.ts    工具注册（bridge + status/cancel + monitor + archive）
  monitor.ts  后台守护循环（statusSnapshot + 规则 + 可选 LLM 判定）
  registry.ts 桥侧标题/workspace 登记表（~/.dsh/session-bridge-registry.json）
scripts/
  build.sh    类型检查 + 链接 DSH checkout 类型
```

## License

MIT
