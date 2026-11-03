# AGENTS.md — dsh-session-bridge 开发约束

面向在此仓库工作的 agent（和未来的自己）。**第一条是硬性规则，改动前必读。**

---

## 1. 硬性规则：DSH 依赖只允许声明「下限」，必须向后兼容

本插件必须能装在 **`0.1.7-0` 及之后的任意 DSH 上**（含 `0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-rc.1`
以及未来的 `0.3.x` / `1.x`）。为此：

> **所有 `@deepseek-ai/dsh*` 的 `peerDependencies` 只能是 `>=x.y.z` / `>=x.y.z-pre` 形式的下限范围；
> 同时 `package.json` 的 `engines.dsh` 必须声明同一条下限（它在 `0.2.1-rc.1` 起单独裁决）。**

- ✅ `">=0.1.7-0"`、`">=0.2.0-rc.1"`
- ❌ `"^0.1.7-0"`（= `>=0.1.7-0 <0.2.0`，**会锁死 minor**）、`"~0.1.7-0"`、`"0.1.7-0"`（精确）、
  `">=0.1.7-0 <0.3.0"`、`"0.1.7-0 || 0.2.0-rc.2"`、`"workspace:*"`

`cordis` 是独立发版，不参与该闸门，保持 `"^4.0.0-rc.x"` 即可（它不是 `@deepseek-ai/dsh*`）。

### 为什么（不要重犯 0.4.0 的错）

harness 在安装与启动时都会跑闸门
`evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`
（`@deepseek-ai/dsh-app-boot`，即 `lib/types/plugin-compatibility.js`）。**它读的是插件自己的
`package.json`**（`dsh.plugin.json` 在整个 0.2.x 里没有任何读取方，见下方「配套要求」）。

闸门的判据在 `0.2.1-rc.1` 变了（官方发布说明「其他变更」原文：*第三方插件的版本兼容性优先按
`engines.dsh` 判断；未声明时沿用原有规则。插件作者需检查声明是否覆盖支持的 DSH 版本*）：

```js
// ① 声明了 engines.dsh 就只由它裁决，peerDependencies 全部忽略
if (Object.hasOwn(engines, 'dsh')) return satisfies(runtime, engines.dsh) ? {} : { 'engines.dsh': engines.dsh }
// ② 没有 engines.dsh 才逐个比对 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 前缀的 peer
for (const [name, range] of Object.entries(peerDependencies)) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
  if (!satisfies(runtime, workspacePeer ? runtime : range)) unmet[name] = range
}
// satisfies = semver.satisfies(runtime, range, { includePrerelease: true })；空范围/非法范围一律不满足
```

三条要点：

1. **`engines.dsh` 一旦存在就是唯一判据**——peer 写得多正确都不参与。所以它必须存在、是纯下限、
   且与 peer 下限逐字一致；写窄了会在 peer 本来能放行的 harness 上被拒，写宽了等于偷偷放宽承诺。
2. **`engines.dsh` 缺失时回落 peer**（旧行为）——这是 `0.1.7-0 … 0.2.0-rc.2` 上唯一生效的路径，
   所以 peer 下限仍然要正确，不能因为"现在由 engines 裁决"就放任 peer 漂移。
3. **`workspace:^` / `workspace:~` / `workspace:*` 只在 peer 里指"当前运行时"**（视为满足）；
   写进 `engines.dsh` 是无效范围 → 直接判不兼容。

后果（实测日志，桌面版 harness `0.2.0-rc.2`）：

```
dsh: installation rejected: Plugin dsh-session-bridge@0.4.0 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-session":"^0.1.7-0", ...}.
```

`^0.1.7-0` 的上界是 `0.2.0`，所以 DSH 一升到 `0.2.0-rc.x` 就被判 `incompatible-version`：安装被
**回滚**（`package.json` / `pnpm-lock.yaml` / `node_modules` 全部还原），已装好的 bundle 在启动时被
**静默跳过**，`session_bridge_*` 全部消失。**0.5.0 起已改为下限，别再改回去。**

实测矩阵（本仓库 0.8.0 的 manifest，用两版 harness 各自的 `evaluatePluginCompatibility` 求值）：

| manifest 形态 | `0.2.0-rc.2`（旧闸门） | `0.2.1-rc.1`（新闸门） |
|---|---|---|
| 现状：peer 全下限 + `engines.dsh` 下限 | ✅ | ✅ |
| 删掉 `engines.dsh`（回落 peer） | ✅ | ✅ |
| peer 全下限 + `engines.dsh: "^0.1.7-0"` | ✅（`engines` 被忽略） | ❌ `{"engines.dsh":"^0.1.7-0"}` |
| peer 带上界 + `engines.dsh` 下限 | ✅ | ✅（**peer 被忽略**） |
| peer 里出现空范围 `""` | ❌ | ✅（**peer 被忽略**） |
| peer 全写 `workspace:*` | ✅ | ✅ |

注意第 4、5 行：新闸门下 `engines.dsh` 一旦存在，**peer 的错误完全不参与判定**——peer 漂移在
`0.2.1-rc.1` 上"看不见"，却会在 `0.2.0-rc.2` 这类旧 harness 上直接拒装。这正是守卫仍然强制校验
peer 的原因。

`0.1.7-0` ✅ `0.2.0-rc.1` ✅ `0.2.0-rc.2` ✅ `0.2.1-rc.1` ✅ `0.2.0` ✅ `0.3.0-rc.1` ✅ `1.0.0` ✅——
下限不设上界，后续版本默认兼容；同一 manifest 换成 `^0.1.7-0` → `0.2.0-rc.2` ❌。

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
2. `package.json` 的 `engines.dsh` 改成**同一条**范围（**权威声明**：`0.2.1-rc.1` 起它单独裁决，
   守卫会校验它与 peer 下限逐字一致）；`dsh.plugin.json` 的 `engines.dsh` 同步改成同一条
   （0.1.x 的遗留元数据，守卫也校验，别让它漂移）；
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

- **权威声明是 `package.json` 的 `engines.dsh`**：`0.2.1-rc.1` 起闸门先看它，存在就**单独裁决**，
  所以它必须存在、是纯下限、且与 peer 下限**逐字一致**（当前都是 `>=0.1.7-0`）。
- **`dsh.plugin.json` 是 0.1.x 的遗留元数据**：0.2.x 全系（实测两个安装树：CLI `0.2.1-rc.1` 与桌面版
  `0.2.0-rc.2`）**没有任何读取方**——grep 文件名零命中；真正把插件挂上的是 `package.json` 的
  `dsh.bundle.patch`。它仍随包发布给旧 harness，所以里面的 `engines.dsh` 也要与下限一致（守卫校验），
  但别以为改它就能影响闸门。（上游 `dsh-package-manifest` README 里"`engines.dsh` 不被强制校验"
  那句已经过时，它描述的是加入本判据之前的版本。）
- **`scripts/test-peer-floor.mjs` 强制这些规则**，已接入 `pnpm test`；CI 与发布工作流都会跑
  `pnpm test`。六类回归都实测会让它红掉：peer 带上界、`engines.dsh` 缺失、`engines.dsh` 写窄、
  `dsh.plugin.json` 漂移、dev 范围钉死、dev 范围低于下限。
- 真的绕不开时，用户侧只能逐版本豁免（不推荐、不写进插件）：
  `dsh plugin allow-version <包@版本> --dsh-version <runtime> --accept-risk`。
  豁免存在 profile 自己的 `compatibility.json` 里，键是**精确** `包名@版本` → 精确运行时版本列表，
  插件升级和 DSH 升级都**不继承**授权。

---

## 2. DSH 每次发新版后要做的事

上游发版节奏很快（`0.2.0-rc.1` → `0.2.0-rc.2` → `0.2.1-rc.1` 这类 rc 也常带真改动），
**升级-验证-重建**是固定动作：

```bash
# 1. 拉最新 DSH 发布包。devDependencies 写的是 >= 下限，但注意下面两个坑。
pnpm update '@deepseek-ai/dsh-agent' '@deepseek-ai/dsh-agent-preset-registry' \
  '@deepseek-ai/dsh-brand' '@deepseek-ai/dsh-home-paths' '@deepseek-ai/dsh-llm' \
  '@deepseek-ai/dsh-scope' '@deepseek-ai/dsh-session' '@deepseek-ai/dsh-session-persistence' \
  '@deepseek-ai/dsh-tools' '@deepseek-ai/dsh-util-values' '@deepseek-ai/dsh-workspace' \
  '@deepseek-ai/dsh-session-format-catalog'

# 2. 按新 API 面验证（缺一不可）
pnpm typecheck      # src/ 对锁文件里的新 DSH 类型
pnpm check:compat   # 已安装 harness 的 .d.ts + 产物内联版本来源校验
pnpm test           # wait/卡住、archived handler、V3→V4 迁移、peer 下限守卫
pnpm build          # 产物 lib/index.js 内联新 DSH（发版前另用干净目录复现一次，见坑 3）
pnpm smoke          # 产物真的能挂载并注册 15 个工具
```

**坑 1：新 tuple 的 rc 不会被 `>=` 下限解析到。** semver 规定预发布版本只在「comparator 的
`major.minor.patch` 完全相同」时参与匹配，所以 `>=0.2.0-rc.1` 能拿到 `0.2.0-rc.2`，却**拿不到**
`0.2.1-rc.1`（实测 `pnpm update` 报 `Already up to date`，`pnpm list` 仍是 `0.2.0-rc.2`）。
每遇到一个新 tuple，就要把那 12 个 dev 范围抬到 `>=<新 tuple>-rc.x` 再 `pnpm install`——
**这只动 devDependencies（构建目标），不动 peer / `engines.dsh`（运行时承诺）**，两者本来就允许不同
（守卫只要求 dev ≥ peer 下限）。

**坑 2：`pnpm update` 会把 dev 的 `>=` 下限改写成精确钉版。** 实测它把 12 个
`">=0.2.0-rc.1"` 直接写成 `"0.2.0-rc.2"`，`pnpm test` 的守卫随即报
`must be a floor-only range`。所以每次 `pnpm update` 之后**必须 `git diff package.json` 复核**，
把 dev 范围改回 `>=` 形式（本仓库 0.7.0 已踩过一次）。

**坑 3：本机 `pnpm build` 通过 ≠ CI 通过（`build.sh` 的 junction 会掩盖 TS2742）。**
`build.sh` 会在 `node_modules/` 里建 junction 指向本地 dsh checkout（例如
`node_modules/schemastery` → `D:\code\deepseek-harness\vendor\schemastery`），类型解析因此落到
**稳定路径**；而 CI 是**干净安装**，同一份代码会解析到 pnpm 虚拟 store 的深路径。0.7.0 就栽在这里：
`src/config.ts` 导出的 `Config` 类型是推导出来的，干净安装下 `tsc --emitDeclarationOnly` 直接报

```
src/config.ts(34,14): error TS2742: The inferred type of 'Config' cannot be named without a
reference to '.pnpm/@deepseek-ai+schemastery@3.18.5/node_modules/@deepseek-ai/schemastery'.
This is likely not portable. A type annotation is necessary.
```

本机 `pnpm build` 全绿，tag 推上去之后 CI 的 Build 步骤才红、`Publish to npm` 被跳过——**版本号已经
被 tag 占掉，但 npm 上什么都没有**。两条规则：

- **导出的 schema 必须显式命名类型**：`export const Config: z<PluginConfig> = z.object({ ... })`
  （官方插件的 `.d.ts` 就是 `export declare const Config: Schema<X>`）。这样产物 `.d.ts` 里只剩
  包名 `@deepseek-ai/schemastery`，不含任何 `.pnpm/...` 深路径。
- **发版前用干净目录复现一次 CI 的 build**（本机 junction 是唯一的差异来源）：

```powershell
git archive -o "$env:TEMP\head.zip" HEAD
Expand-Archive "$env:TEMP\head.zip" "$env:TEMP\ci-check" -Force
cd "$env:TEMP\ci-check"; pnpm install --frozen-lockfile; pnpm build
```

然后更新 `README.zh.md` / `README.md` 的「实测于 x.y.z」与 `CHANGELOG.md`，必要时发新版本。

### 上游破坏了函数签名时：先特性检测，再考虑抬下限（0.2.2-alpha.3 实例）

`0.2.2-alpha.3` 把 `@deepseek-ai/dsh-agent` 的 `installModelSelection(agentCtx, selection)` 改成
`installModelSelection(agentCtx)`（选择权迁到 `AgentModel` + 持久化的 `modelSelection` 投影，函数只剩
"装模型切换提示监听"）。这类**只改形参**的破坏最危险：多传的那个实参会被 JS 静默忽略，旧代码照常不报错，
只是语义悄悄消失。处理顺序固定为：

1. **先做运行时特性探测**（本例按形参个数：`install.length >= 2` 走老签名，否则走新签名；安装器缺失或抛错
   就退回落 `agent/request` 兜底钩子）。能同时支持新旧宿主，就**不抬下限**——下限覆盖越宽越好。
2. 探测做不到（老 API 不可调用、协议/事件形状变了）才抬下限，并按 §1「破坏性变更时」把 8 个 peer、
   `engines.dsh`（两份 manifest）、12 个 dev 范围一起抬，同时在 CHANGELOG 写明放弃哪些旧版本。
3. **无论哪种，都要给探测本身补回归**（`scripts/test-tools-create.mjs` 的 5 例）：两种 arity 各测一次、
   安装器抛错/缺失的回落路径各测一次，再加一条"已安装包的 arity 必须是 1 或 2"——上游再改签名时这条先红。

顺带记住这一版的两处**无关但容易误判**的改动：`SessionStore` 的会话在 `session/created` 公告完成前**只读**
（桥只走 `agents.create()` / `agent.followup()`，从不直接 `session.append`，所以不受影响）；新 cordis 的配置
校验改走 standard-schema（`runtime.Config["~standard"].validate`），本插件的 `Config` 带 `~standard`，校验后
volatile 字段仍是稳定引用——换 cordis/schemastery 版本后，`pnpm smoke` 与这段探测就是用来证明这点的。

### 验证运行中的 harness（两处安装，都要验）

**① 会话里正在跑的 harness**（全局 npm / scoop 安装，本例 `0.2.2-alpha.3`）——`pnpm check:compat`
的目录锚点扫的就是它（`<dsh 安装目录>\node_modules\@deepseek-ai`），所以这一侧已被 `check:compat`
覆盖；要单独求值就直接 import 它的 `dsh-app-boot`：

```js
// node gate.mjs "<dsh 安装目录>\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js"
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
const boot = await import(pathToFileURL(process.argv[2]).href)
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
console.log(boot.getDshRuntimeVersion(), boot.evaluatePluginCompatibility(manifest) ?? 'ACCEPTED')
```

**② 桌面版（`E:\soft\DeepSeek Harness`）**——桌面版的 DSH 包**不在 `app.asar` 里**：`0.2.0-rc.2`
起 `resources\app.asar` 已展开成 `resources\app\`（只剩一个 `app.asar.bak`），所以闸门在
`<app>\resources\app\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`。
`resources\runtime\cli\bin\dsh.cmd` 那个包装脚本已经**失效**（仍按 `app.asar` 拼路径，实测
`Cannot find module ...app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`），
取版本别用它，直接读 `resources\app\dsh\package.json` 的 `version`。把上面的 `gate.mjs` 指向桌面版
那份 `dsh-app-boot` 即可。

实测（0.8.0 的 manifest）：scoop `0.2.2-alpha.3` ✅、桌面版 `0.2.0-rc.2` ✅。

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
- **运行时下限只由"我们跑不了更老的版本"决定**，当前是 `>=0.1.7-0`（peer 与 `package.json` 的
  `engines.dsh` 必须一致）。上游发新版不构成抬下限的理由；真的遇到破坏性变更、必须改代码才能发布时，
  按 §1「破坏性变更时」把下限一起抬上去。**devDependencies 是构建目标，不是运行时承诺**：它随
  运行中的 harness 走（可以是 `>=0.2.1-rc.1` 这种更新的 tuple），只要求不低于 peer 下限。
- 运行中的宿主会缓存已加载模块：改完渲染/工具后需**重启或热重载**才能在实机看到效果。
