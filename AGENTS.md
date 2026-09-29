# AGENTS.md — dsh-session-bridge 开发约束

面向在此仓库工作的 agent（和未来的自己）。**第一条是硬性规则，改动前必读。**

---

## 1. 硬性规则：DSH 依赖只允许声明「下限」，必须向后兼容

本插件必须能装在 **`0.1.7-0` 及之后的任意 DSH 上**（含 `0.2.0-rc.1`、`0.2.0-rc.2` 以及未来的
`0.3.x` / `1.x`）。为此：

> **所有 `@deepseek-ai/dsh*` 的 `peerDependencies` 只能是 `>=x.y.z` / `>=x.y.z-pre` 形式的下限范围。**

- ✅ `">=0.1.7-0"`、`">=0.2.0-rc.1"`
- ❌ `"^0.1.7-0"`（= `>=0.1.7-0 <0.2.0`，**会锁死 minor**）、`"~0.1.7-0"`、`"0.1.7-0"`（精确）、
  `">=0.1.7-0 <0.3.0"`、`"0.1.7-0 || 0.2.0-rc.2"`、`"workspace:*"`

`cordis` 是独立发版，不参与该闸门，保持 `"^4.0.0-rc.x"` 即可（它不是 `@deepseek-ai/dsh*`）。

### 为什么（不要重犯 0.4.0 的错）

harness 在安装与启动时都会跑闸门
`evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`
（`@deepseek-ai/dsh-app-boot`，即 `lib/types/plugin-compatibility.js`）：

```js
// 只检查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 前缀的 peer
if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
// runtimeVersion（运行中的 harness 版本）参与比较；一旦任一 peer 不满足，整包被拒
if (!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range
```

后果（实测日志，桌面版 harness `0.2.0-rc.2`）：

```
dsh: installation rejected: Plugin dsh-session-bridge@0.4.0 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-session":"^0.1.7-0", ...}.
```

`^0.1.7-0` 的上界是 `0.2.0`，所以 DSH 一升到 `0.2.0-rc.x` 就被判 `incompatible-version`：安装被
**回滚**（`package.json` / `pnpm-lock.yaml` / `node_modules` 全部还原），已装好的 bundle 在启动时被
**静默跳过**，`session_bridge_*` 全部消失。**0.5.0 起已改为下限，别再改回去。**

实测（桌面版 harness 自身的 `evaluatePluginCompatibility`，`0.5.1` 的 manifest）：
`0.2.0-rc.1` ✅ `0.2.0-rc.2` ✅ `0.2.0` ✅ `0.3.0-rc.1` ✅ `0.3.0` ✅ `1.0.0` ✅；同一 manifest 换成
`^0.1.7-0` → `0.2.0-rc.2` ❌。

### 破坏性变更时：改代码就必须同步抬高下限

下限**不是永恒的 `0.1.7-0`**。上游一旦做了破坏性变更（删/改 API、改协议或事件形状、
改类型签名），导致旧 harness 上跑不了、必须改代码才能重新发布，那么：

> **抬下限和改代码、发版是同一个动作的一部分，不能只改代码不动下限。**

理由：不抬下限的后果比抬了下限更糟。旧下限会让兼容性闸门**放行**这个已经按新 API 写的版本，
用户把它装到旧 harness 上，闸门不拦，然后在运行期炸掉（崩溃、数据丢失），而不是在安装时被干净地拒绝。
抬下限等于把"这版起必须 ≥X"这个事实交给闸门去执行。

**判定新下限 = 最早一个能跑通新版代码的 DSH 版本**（通常就是破坏发生的那个版本，例如破坏发生在
`0.3.0-rc.1`，下限就是 `>=0.3.0-rc.1`）。

一次抬下限要**同时**改完这些（缺一处就会留下"声明与行为不一致"）：

1. `package.json` 里 **8 个** `@deepseek-ai/dsh*` peer 全部改成同一条新下限范围
   （守卫会校验"所有 peer 用同一个下限"）；
2. `dsh.plugin.json` 的 `engines.dsh` 改成**同一条**范围（守卫会校验它与 peer 下限一致）；
3. `devDependencies` 里 12 个 DSH 包的范围改成 `>=新下限`，然后 `pnpm install` 让锁文件解析到下限之后；
4. 走完整验证：`pnpm typecheck` / `pnpm check:compat` / `pnpm test` / `pnpm build` / `pnpm smoke`；
5. 桌面版 harness 单独验闸门（见 §2 末），确认新下限**不高于**运行版本；
6. `README.md` / `README.zh.md` 的「适配 DSH x 及之后 / verified against」与 `CHANGELOG.md`
   同步——CHANGELOG 必须写明：破坏点是什么、为什么必须在 X 起、**放弃哪些旧版本**
   （旧 harness 从此会收到 `incompatible-version` 拒绝，这是预期行为，不是 bug）。

两条边界，别弄反：

- **只是上游发了新版、或只是新增 API** → 不改下限、不加分支，只按 §2 重建并验证。
  下限只由"我们跑不了更老的版本"决定，不由"上游有更新版本"决定。
- **能兼容就不要抬** → 如果加一个运行时特性检测/双路径分支就能在旧版本上继续工作，
  优先保持不抬（下限覆盖越宽越好）。只有真的无法在旧版本上工作时才抬，
  并在 CHANGELOG 里记下这个取舍。
- **无论抬到哪，上界永远禁止**：`>=0.3.0-rc.1` ✅，`^0.3.0-rc.1` / `>=0.3.0-rc.1 <0.4.0` ❌。
  抬下限解决"旧版本跑不了"，加上界会重新制造"新版本装不上"。

### 配套要求

- `dsh.plugin.json` 的 `engines.dsh` 必须与 peer 下限**逐字一致**（当前都是 `>=0.1.7-0`）。
  注意：**`engines.dsh` 目前不被安装器/加载器强制校验**（见 `dsh-package-manifest` README），
  真正卡人的是 `peerDependencies`——不要把闸门问题误判成 `engines` 问题。
- **`scripts/test-peer-floor.mjs` 强制这条规则**，已接入 `pnpm test`；CI 与发布工作流都会跑
  `pnpm test`，所以带 `^` / 上界的改动、或改了 peer 忘了改 `engines.dsh`，都会直接让流水线红掉。
- 真的绕不开时，用户侧只能逐版本豁免（不推荐、不写进插件）：
  `dsh plugin allow-version <包@版本> --dsh-version <runtime> --accept-risk`。

---

## 2. DSH 每次发新版后要做的事

上游发版节奏很快（`0.2.0-rc.1` → `0.2.0-rc.2` 这类 rc 也常带真改动），**升级-验证-重建**是固定动作：

```bash
# 1. 拉最新 DSH 发布包（devDependencies 是 >= 下限，pnpm update 即可）
pnpm update '@deepseek-ai/dsh-agent' '@deepseek-ai/dsh-agent-preset-registry' \
  '@deepseek-ai/dsh-brand' '@deepseek-ai/dsh-home-paths' '@deepseek-ai/dsh-llm' \
  '@deepseek-ai/dsh-scope' '@deepseek-ai/dsh-session' '@deepseek-ai/dsh-session-persistence' \
  '@deepseek-ai/dsh-tools' '@deepseek-ai/dsh-util-values' '@deepseek-ai/dsh-workspace' \
  '@deepseek-ai/dsh-session-format-catalog'

# 2. 按新 API 面验证（缺一不可）
pnpm typecheck      # src/ 对锁文件里的新 DSH 类型
pnpm check:compat   # 已安装 harness 的 .d.ts + 产物内联版本来源校验
pnpm test           # wait/卡住、archived handler、V3→V4 迁移、peer 下限守卫
pnpm build          # 产物 lib/index.js 内联新 DSH
pnpm smoke          # 产物真的能挂载并注册 15 个工具
```

然后更新 `README.zh.md` / `README.md` 的「实测于 x.y.z」与 `CHANGELOG.md`，必要时发新版本。

### 验证运行中的 harness（桌面版）

桌面版的 DSH 包在 `app.asar` 里，`check:compat` 的目录锚点扫不到它，因此桌面版要单独验证：

```powershell
# 桌面版 CLI 的版本（应为运行中的版本）
$env:ELECTRON_RUN_AS_NODE=1
& "E:\soft\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version
```

用桌面版**自己的**闸门评估本仓库的 manifest（`<app>` = DeepSeek Harness 安装目录）：

```js
// ELECTRON_RUN_AS_NODE=1 "<app>\DeepSeek Harness.exe" --expose-internals gate.mjs
import { pathToFileURL } from 'node:url'
const boot = await import(pathToFileURL(
  '<app>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-app-boot\\lib\\index.js').href)
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
console.log(boot.getDshRuntimeVersion(), boot.evaluatePluginCompatibility(manifest) ?? 'ACCEPTED')
```

安装日志在 `<DSH_HOME>\profiles\<profile>\.plugin-manager\logs\operation-*\pnpm.log`，被拒时会写
`installation rejected: ... incompatible with dsh ...`——排查"装了但没生效"先看这里。

### 发布后 24 小时内 `@latest` 会静默回退到旧版本（pnpm 11 的 `minimumReleaseAge`）

**症状**：用户明明指定了 `@latest`，装到的却是**旧版本**（实测拿到 0.4.0），于是闸门按旧版本的
peer 报 `incompatible-version`——看起来像"peer 又写错了"，其实不是。

**原因**：pnpm 11 把供应链保护默认打开，[`minimumReleaseAge`](https://pnpm.io/zh/blog/releases/11.0)
默认为 `1440`（分钟，即 1 天），registry 上发布不满 24h 的版本**不参与解析**。关键坑点：
`minimumReleaseAgeStrict` 默认 `false`，所以既不报错也不提示，`@latest` 直接**静默回退**到最新一个
"够老"的版本。`pnpm view <pkg> dist-tags` 仍显示 `latest: 0.5.1`，`pnpm add <pkg>@latest` 却给出
`0.4.0`；两者不一致就是这个原因（不要怀疑 registry 或 dist-tag）。

实测证据（桌面版 profile，pnpm 11.7.0）：

```
dependencies:
+ dsh-session-bridge ^0.4.0            # 指定的是 @latest
# 换成精确版本则硬报：
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
  dsh-session-bridge@0.5.1 was published at 2026-09-28T22:08:01.057Z,
  within the minimumReleaseAge cutoff (2026-09-28T11:37:11.388Z)   # now - 1440min
```

**三条出路（均实测通过）**：

1. 在**使用方 profile** 的 `pnpm-workspace.yaml` 里排除本包 —— `@latest` 立刻解析到 0.5.1：
   ```yaml
   minimumReleaseAgeExclude:
     - dsh-session-bridge
   ```
2. 装本地 tgz（不经 registry 解析）：`dsh plugin add <路径>/dsh-session-bridge-x.y.z.tgz` → 实测装到 0.5.2；
3. 等满 24h（0.5.1 发布于 `2026-09-28T22:08:01Z`，即 **2026-09-30 06:08（Asia/Taipei）** 之后自动可解析）。

注意：`dsh plugin add <pkg>@<精确版本>` **不能**绕过该策略（实测直接 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。

**对本仓库的含义**：

- 发版说明/回复用户时要写清"新版本发布后约 24h 才会被 `@latest` 解析到"，否则会被误判成插件的 bug。
- 作者自用 profile 建议把 `dsh-session-bridge` 加进 `minimumReleaseAgeExclude`
  （本仓库根 `pnpm-workspace.yaml` 对 `@deepseek-ai/dsh-*` 就是这么做的，理由同源）。
- 排查"装了但版本不对"：先看日志里**实际解析到的版本**（`+ dsh-session-bridge ^x.y.z`），
  再去看那个版本的 peer——本次真实解析到的是 0.4.0，不是 0.5.x。

---

## 3. 其它仓库约定

- **产物是自包含 bundle**：`lib/index.js` 通过 tsdown 内联所有非 `node:` 依赖（含 DSH 与 cordis），
  所以 harness 升级后**必须 `pnpm build` 重建**，否则跑的是旧内联代码。`lib/` 不入库（见 `.gitignore`）。
- **`lib/index.js` 是唯一生效的东西**：`src/` 测试证明不了产物是不是旧的，`pnpm smoke` 才证明产物
  可挂载——改动工具注册/渲染时，`src/` 与产物级断言都要覆盖。
- **锁文件 = 已验证版本**：CI / 发布都用 `pnpm install --frozen-lockfile`；`pnpm-workspace.yaml` 的
  `minimumReleaseAgeExclude` 只列包名**不列版本**（DSH 发布当天即可安装；cordis / schemastery 例外）。
- **peer 下限只由"我们跑不了更老的版本"决定**，当前是 `>=0.1.7-0`。上游发新版不构成抬下限的理由；
  真的遇到破坏性变更、必须改代码才能发布时，按 §1「破坏性变更时」把下限一起抬上去。
- 运行中的宿主会缓存已加载模块：改完渲染/工具后需**重启或热重载**才能在实机看到效果。
