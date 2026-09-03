# dsh-session-bridge — 会话桥 (Session bridge)

A [DSH](https://www.deepseek.com) plugin that lets the current agent drive
other real DSH sessions directly from a prompt — create sessions, send
messages to any session, wait for and read replies, resume offline sessions,
and find sessions across workspaces. On top of that it can **monitor and
schedule** a main task (watch its progress, nudge or correct its direction,
and stop it), and **archive** sessions the same way the DSH sidebar's Archive
action does.

> 中文文档见 [README.zh.md](./README.zh.md).

## What it does

- **Create real DSH sessions.** `session_bridge_create` makes a new main
  session (top-level UI session) in the current workspace, or in another
  workspace when you pass `workspaceId` / `cwd`. It can send one first prompt
  and optionally block until the first reply. Provider / model / reasoning
  effort are inherited from the calling session by default.
- **Send messages to any session.** `session_bridge_send` appends a turn
  (`mode=queue`) or injects steering into the running step (`mode=steer`), and
  can optionally wait for the next reply.
- **Wait for a reply.** `session_bridge_wait` blocks until a new text assistant
  reply appears after a given seq; with `requireTurnEnd` it also waits for the
  turn to settle. Timeout / abort return the partial result rather than
  throwing.
- **Read any session.** `session_bridge_read` folds a session's event log into
  readable rows — live or offline (from persistence) — with `sinceSeq` paging,
  role filtering, and a `limit` (default 20, max 100).
- **Resume offline sessions.** `session_bridge_resume` brings a persisted
  session back online (idempotent); it can also override provider / model.
- **Find sessions.** `session_bridge_find` matches by title, id, workspace, or
  directory across all workspaces, returning live/running state, title, and
  working directory. Bridge-registered titles act as aliases.
- **Monitor and schedule a main task.** `session_bridge_status` reads a
  session's real-time progress (running/idle, open turn, time since the last
  event for stall detection, pending work, latest reply). `session_bridge_cancel`
  stops a running session. `session_bridge_monitor_start` runs a **background
  watchdog loop** that polls the task, nudges it when it stalls, corrects it
  when it drifts, terminates it after it stays stuck, and wraps up when it
  finishes.
- **Archive sessions.** `session_bridge_archive` adds a session to the DSH
  workspace archive set (hidden from every grouping surface, history and
  workspace position preserved). `session_bridge_archived` lists the archive
  set, optionally resolving titles.

## Monitoring worker

`session_bridge_monitor_start` installs a timer-driven loop. Every poll it
**observes → judges → schedules → logs** the target session:

| Observation | Action |
|---|---|
| A `doneKeywords` string appears in the reply and the session is idle | Wrap up and stop the watchdog (log `DONE`) |
| Idle with no pending work | Wrap up (settled) — no pointless nudging / cancelling |
| `running` and no event for more than `stalledMs` | Record a stall → `steer` a nudge (with `useLlm`, judge `offtrack`/`stuck` first) |
| Stall repeats ≥ `maxStuckCycles` | `cancel` the session |
| Making progress | Reset the stall counter (steady) |

The watchdog only treats **running** sessions as stalled, so a finished or idle
task is wrapped up rather than nudged forever. Logs go to
`~/.dsh/super-injector/dsh-session-bridge-monitor.log` (overridable).

Control it with `session_bridge_monitor_start` / `_stop` / `_list`.

## Requirements

- [Node.js](https://nodejs.org) ≥ 20
- [pnpm](https://pnpm.io)
- DSH ≥ `0.1.0-rc.6`

## Build

```bash
# type-check + bundle the host build + pack a tgz (DSH_CHECKOUT points at the dsh source checkout)
bash scripts/build.sh && npm run build:client

# via the injector toolchain
dev_build_plugin dsh-session-bridge
```

`build.sh` type-links against a local DSH checkout and is only for local dev.
The GitHub Actions CI (`ci.yml`) instead resolves the `@deepseek-ai/dsh-*`
prereleases from the registry — pinned to the `0.1.2-alpha.2` line, which is
the DSH API surface this code targets — then runs `pnpm typecheck` and
`pnpm build:client` (the self-contained `tsdown` bundle). Bump that pin
together with the code when you migrate to a newer DSH API.

## Deploy

DSH web loads external plugins from the active profile. This package is a
**bundle**: its `package.json` declares `dsh.bundle.patch` →
[`cordis.patch.yml`](./cordis.patch.yml), whose `insert` row mounts the plugin.
That declaration is what lets `dsh plugin add` install the package *and*
activate it in one step.

### Install from npm

The package is published to [npmjs.com](https://www.npmjs.com/package/dsh-session-bridge).
Releases are cut on a `v*` git tag by the `publish.yml` GitHub Actions workflow;
`package.json` and `dsh.plugin.json` versions are synced to that tag before
publishing.

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add dsh-session-bridge
```

pnpm installs the published tarball and runs its `prepare` script (`tsdown`) to
ensure `lib/` is present, then `dsh` activates the bundle.

### Install from GitHub

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:heartmove/dsh-session-bridge
```

`dsh plugin` forwards to pnpm inside `~/.dsh/profiles/web/`, then reconciles the
bundle into the profile's `dsh.profile.bundles` layer list. A git install
fetches sources, so pnpm runs the package's `prepare` script (`tsdown`) to build
`lib/` from `src/` after checkout.

pnpm ≥ 10 refuses to run a git dependency's `prepare` script until it is
allowlisted, so the first `add` fails with an "Ignored build scripts" hint. Copy
the exact package key pnpm printed into the profile's `pnpm-workspace.yaml`
(`~/.dsh/profiles/web/pnpm-workspace.yaml`):

```yaml
allowBuilds:
  dsh-session-bridge: true
```

then re-run the `add`. That allowance means "run this package's code on my
machine at install time" — only allow packages whose source you trust, and pin a
commit (`github:heartmove/dsh-session-bridge#<sha>`) so a later push cannot
silently change what runs.

Restart `dsh web`, then hard-refresh the page (Ctrl/Cmd+Shift+R).

### Install from a local checkout

From the directory that contains this checkout:

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add ./dsh-session-bridge
```

pnpm links the checkout and `dsh` activates the bundle the same way.

### Manual link

To manage the profile by hand, link the package and list it as a bundle in
`~/.dsh/profiles/web/package.json` (the bundle's own `cordis.patch.yml` supplies
the loader row, so no `insert` entry is needed):

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

(On POSIX systems use `link:/path/to/dsh-session-bridge`.) Then run `pnpm install`
in the profile directory and restart `dsh web`.

### Inject directly (dev)

For fast iteration while developing the plugin, you can also load it directly
through the injector toolchain (no bundle entry required):

```bash
dev_inject_plugin D:\code\dsh-session-bridge
```

Remove it with `dev_uninject_plugin dsh-session-bridge` (clears the injector
registration and junction; not re-assembled on restart).

## Usage

| Tool | What it does |
|---|---|
| `session_bridge_create` | Create a main session (current or another workspace via `workspaceId` / `cwd`); optional first prompt + `waitForReply`. |
| `session_bridge_send` | Send a message (`mode=queue`/`steer`); optional wait-for-reply. |
| `session_bridge_wait` | Wait for a new text assistant reply after `sinceSeq`; optional `requireTurnEnd`. |
| `session_bridge_read` | Read messages — live or offline; `sinceSeq` paging, `role` filter, `limit`. |
| `session_bridge_resume` | Bring a persisted session back online (idempotent). |
| `session_bridge_find` | Find sessions by title / id / workspace / directory across workspaces. |
| `session_bridge_status` | Read a session's live progress (running, open turn, stall detection, pending work, latest reply). |
| `session_bridge_cancel` | Stop a running session (abort active turn; clear queued/steering work unless `keepInbox`). |
| `session_bridge_monitor_start` | Start a background watchdog on a main session (poll, nudge, correct, cancel, wrap up). |
| `session_bridge_monitor_stop` | Stop a watchdog (keep the session itself running). |
| `session_bridge_monitor_list` | List active watchdogs and their state. |
| `session_bridge_archive` | Archive a session (hidden from groupings; history and position preserved). |
| `session_bridge_archived` | List the archive set, optionally resolving titles. |

All tools return lossless JSON; wait-style tools never throw on timeout — they
return a `timedOut` / `aborted` flag.

## Project layout

```
src/
  index.ts    host plugin entry (registers the tools; mounts the monitor)
  core.ts     shared host logic (create/send/wait/read/find, status snapshot, archive attach)
  tools.ts    tool registrations (bridge + status/cancel + monitor + archive)
  monitor.ts  the background watchdog loop (statusSnapshot + rules + optional LLM judge)
  registry.ts bridge-side title/workspace registry (~/.dsh/session-bridge-registry.json)
scripts/
  build.sh    type-check + link types against the DSH checkout
```

## License

MIT
