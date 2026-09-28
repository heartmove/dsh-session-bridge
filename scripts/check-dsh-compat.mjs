#!/usr/bin/env node
/**
 * Type-check src/ against the DSH packages that are ACTUALLY INSTALLED,
 * rather than against $DSH_CHECKOUT.
 *
 * Why this exists: scripts/build.sh type-checks against a DSH *source* checkout.
 * That checkout routinely lags the harness the plugin is loaded into (e.g. the
 * checkout sat at 0.1.5-alpha.2 while the running harness was 0.1.6-alpha.1), so
 * a green `build.sh` silently proves nothing about the running version. This
 * script reads the `lib/types/*.d.ts` that ship inside the installed DSH npm
 * package, i.e. the exact API surface the plugin loads against — so an upstream
 * break shows up here even when the checkout is stale.
 *
 * Usage:
 *   node scripts/check-dsh-compat.mjs [--dsh <path>] [--strict]
 *
 * <path> may be either the DSH package directory or the `@deepseek-ai` scope
 * directory that holds dsh-session, dsh-agent, ... . When omitted, the installed
 * location is probed (DSH_INSTALLED_MODULES, then `npm root -g`).
 *
 * Provenance policy: the plugin declares only a peer FLOOR (>=0.1.7-0), so a
 * newer harness is supported by design. This script therefore fails only when
 * the artifact inlines DSH code OLDER than that floor; any other drift from the
 * installed harness is reported as a note. Pass --strict (or set
 * DSH_COMPAT_STRICT=1) to restore the old exact-match failure.
 *
 * Exits 0 when the plugin's src/ type-checks against those types, 1 otherwise.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a JSON file, or return undefined when it is absent/unreadable. */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** True when `dir` looks like the `@deepseek-ai` scope directory. */
function isScopeDir(dir) {
  return dir !== undefined && existsSync(join(dir, 'dsh-session', 'package.json'))
}

/**
 * Resolve the `@deepseek-ai` scope directory holding the installed DSH packages.
 * Accepts an explicit path (package dir or scope dir) and otherwise probes.
 */
function resolveScopeDir(argv) {
  const flagAt = argv.indexOf('--dsh')
  const explicit = flagAt !== -1 ? argv[flagAt + 1] : (process.env.DSH_INSTALLED_MODULES ?? undefined)
  const candidates = []
  if (explicit !== undefined && explicit !== '') {
    const base = resolve(explicit)
    // Accept the scope dir itself, the dsh package dir, or a node_modules tree.
    candidates.push(base, join(base, 'node_modules', '@deepseek-ai'), join(base, '@deepseek-ai'))
  }

  // Anchor 1: the global install root. execSync (string command) rather than
  // execFileSync, because npm is a .cmd shim on Windows that cannot be spawned
  // without a shell.
  let globalRoot
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { globalRoot = undefined }
  if (globalRoot !== undefined && globalRoot !== '') {
    // npm layout, then the common "dsh nests its own deps" layout.
    candidates.push(join(globalRoot, '@deepseek-ai'), join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }

  // Anchor 2: walk up from the `dsh` executable itself. Its path is usually a
  // symlink (scoop/volta), so resolve it first or the walk misses the real tree.
  try {
    const found = execSync(process.platform === 'win32' ? 'where dsh' : 'which dsh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    for (const line of found) {
      let dir
      try { dir = dirname(realpathSync(line)) } catch { dir = dirname(line) }
      for (let hop = 0; hop < 4 && dir !== dirname(dir); hop++) {
        candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
        candidates.push(join(dir, 'node_modules', '@deepseek-ai'))
        dir = dirname(dir)
      }
    }
  } catch { /* dsh not on PATH; the other anchors decide */ }

  // Anchor 3 (last resort): this repository's own install. CI pins the
  // @deepseek-ai packages through pnpm overrides and installs no DSH app, so
  // the scope only exists here; probing it keeps check:compat runnable in CI.
  // A developer machine resolves one of the anchors above first, so the
  // *running* harness keeps priority there.
  candidates.push(join(ROOT, 'node_modules', '@deepseek-ai'))

  for (const candidate of candidates) if (isScopeDir(candidate)) return candidate
  return undefined
}

/** Resolve a package's types entry point inside the scope directory. */
function typesEntry(scope, pkg) {
  const dir = join(scope, pkg)
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest === undefined) return undefined
  const declared = typeof manifest.types === 'string' ? manifest.types : undefined
  const candidates = [
    ...(declared !== undefined ? [join(dir, declared)] : []),
    join(dir, 'lib', 'types', 'index.d.ts'),
    join(dir, 'index.d.ts'),
  ]
  return candidates.find((c) => existsSync(c))
}

function fail(message) {
  console.error('check-dsh-compat: ' + message)
  process.exit(1)
}

/**
 * Compare two semantic versions, prerelease-aware (enough for DSH's version
 * shapes: `0.2.0-rc.1`, `0.1.7-alpha.2`, `0.2.0`). A release outranks any
 * prerelease of the same core; numeric prerelease parts compare numerically.
 */
function compareVersions(a, b) {
  const [coreA, preA = ''] = a.split('-', 2)
  const [coreB, preB = ''] = b.split('-', 2)
  const numsA = coreA.split('.').map(Number)
  const numsB = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const delta = (numsA[i] ?? 0) - (numsB[i] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  if (preA === preB) return 0
  if (preA === '') return 1
  if (preB === '') return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numX = /^\d+$/.test(x)
    const numY = /^\d+$/.test(y)
    if (numX && numY) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
      continue
    }
    if (numX !== numY) return numX ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Lowest DSH version this plugin declares support for: the first version named
 * in each @deepseek-ai/dsh* peerDependencies range (`^0.1.7-0`, `>=0.1.7-0` and
 * `0.1.7` all name 0.1.7-0). Only a peer FLOOR is declared on purpose — the
 * plugin means "this harness or any later one", so the floor is the only
 * version this repo treats as unsupported below it.
 */
function declaredFloor(manifest) {
  let floor
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string') continue
    const found = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
    if (found === null) continue
    if (floor === undefined || compareVersions(found[0], floor) < 0) floor = found[0]
  }
  return floor
}

const STRICT_PROVENANCE = process.argv.includes('--strict') || process.env.DSH_COMPAT_STRICT === '1'

const scope = resolveScopeDir(process.argv.slice(2))
if (scope === undefined) {
  fail('could not locate the installed DSH packages. Pass --dsh <path> (the DSH package dir or its @deepseek-ai scope dir) or set DSH_INSTALLED_MODULES.')
}

/** Read the version of the `dsh` package that owns this scope directory. */
function dshVersionOf(scopeDir) {
  // Nested layout puts dsh two levels above its own scope dir; a flat global
  // install puts it beside the other packages.
  for (const candidate of [join(scopeDir, 'dsh', 'package.json'), join(scopeDir, '..', '..', 'package.json')]) {
    const manifest = readJson(candidate)
    if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
  }
  // Repo-local install (CI overrides): there is no `dsh` app package, but the
  // release versions every dsh-* package together, so any of them names the
  // harness version the types and the bundle were resolved from.
  for (const pkg of ['dsh-tools', 'dsh-session', 'dsh-agent']) {
    const manifest = readJson(join(scopeDir, pkg, 'package.json'))
    if (typeof manifest?.version === 'string') return manifest.version
  }
  return undefined
}

/**
 * Inspect the built tsdown bundle's source map for the DSH version it INLINED.
 *
 * `check:compat` type-checks src/ against the installed harness, but src/ is not
 * what loads: lib/index.js is a self-contained bundle that inlines every
 * @deepseek-ai/* import. A stale checkout therefore type-checks green while the
 * artifact ships old DSH code (observed: checkout 0.1.5-alpha.2 / host
 * 0.1.6-alpha.2). This reads the map's sources — a checkout path names the root
 * whose package.json carries the version; a .pnpm path encodes it.
 *
 * @returns { versions: Set<string>, roots: Set<string> } or undefined when no map exists.
 */
function artifactProvenance() {
  const mapPath = join(ROOT, 'lib', 'index.js.map')
  if (!existsSync(mapPath)) return undefined
  let map
  try { map = JSON.parse(readFileSync(mapPath, 'utf8')) } catch { return undefined }
  const versions = new Set()
  const roots = new Set()
  for (const source of Array.isArray(map.sources) ? map.sources : []) {
    if (typeof source !== 'string') continue
    // pnpm shortens long virtual-store directory names on Windows. Read the
    // package manifest instead of treating a truncated `@0.1._hash` as a version.
    const packageRoot = source.match(/^(.*[/\\]node_modules[/\\]@deepseek-ai[/\\]dsh-[^/\\]+)[/\\]/)
    if (packageRoot !== null) {
      const manifest = readJson(resolve(ROOT, 'lib', packageRoot[1], 'package.json'))
      if (typeof manifest?.version === 'string') {
        versions.add(manifest.version)
        continue
      }
    }
    // Source checkout: <root>/packages/... or <root>/vendor/... (relative to the map in lib/).
    const checkout = source.match(/^(.*?)[/\\](?:packages|vendor)[/\\]/)
    if (checkout !== null) { roots.add(resolve(ROOT, 'lib', checkout[1])); continue }
    // Registry install: .../.pnpm/@deepseek-ai+dsh-<name>@<version>[_hash]/node_modules/...
    // Only dsh-* packages name the harness release; sibling @deepseek-ai
    // packages (cordis, schemastery) are versioned independently, so counting
    // them would make every CI build look like a provenance mismatch.
    const registry = source.match(/[\\/]\.pnpm[\\/]@deepseek-ai\+dsh-[a-z0-9-]+@([^\\/]+)[\\/]node_modules/)
    if (registry !== null) {
      const version = registry[1].replace(/_.*$/, '')
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) versions.add(version)
    }
  }
  for (const root of roots) {
    const manifest = readJson(join(root, 'package.json'))
    if (typeof manifest?.version === 'string') versions.add(manifest.version)
  }
  return { versions, roots }
}

const dshVersion = dshVersionOf(scope) ?? '(unknown)'

// Every DSH package src/ imports, plus the plain `cordis` specifier that
// package.json declares as a peer.
const manifest = readJson(join(ROOT, 'package.json')) ?? {}
const declared = [...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
const wanted = new Set(declared.filter((name) => name.startsWith('@deepseek-ai/')))
wanted.add('@deepseek-ai/cordis')
wanted.add('@deepseek-ai/schemastery')

const paths = {}
const missing = []
for (const name of [...wanted].sort()) {
  const entry = typesEntry(scope, name.slice('@deepseek-ai/'.length))
  if (entry === undefined) { missing.push(name); continue }
  paths[name] = [entry]
}
// tsconfig.json maps the bare `cordis` specifier; keep that working under the
// installed layout too, where cordis is published scoped.
if (paths['@deepseek-ai/cordis'] !== undefined) paths['cordis'] = paths['@deepseek-ai/cordis']

if (missing.length > 0) {
  fail('installed DSH is missing the packages this plugin imports: ' + missing.join(', ') + '\n  (looked in ' + scope + ')')
}

// The generated config must live in the repo root: tsconfig.json's `include`
// is relative to the config that declares it, so a config placed elsewhere
// would look for src/ in the wrong directory. Every mapped path is absolute,
// so only `include`/`extends` depend on the location. Removed again below.
const configPath = join(ROOT, '.dsh-compat.tsconfig.json')
writeFileSync(configPath, JSON.stringify({ extends: './tsconfig.json', compilerOptions: { paths } }, null, 2))

// Run tsc's JS entry through the current node binary. Spawning the .bin shell
// shim instead would need a shell on Windows (npm .cmd/.bat shims cannot be
// spawned directly), and this way the exit code and output stay unambiguous.
const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) { rmSync(configPath, { force: true }); fail('local typescript not found at ' + tsc + ' (run the package manager install first)') }

console.log('check-dsh-compat: type-checking src/ against installed dsh ' + dshVersion)
console.log('check-dsh-compat: scope ' + scope)
let failure
try {
  execFileSync(process.execPath, [tsc, '-p', configPath, '--noEmit'], { cwd: ROOT, stdio: 'inherit' })
} catch (error) {
  failure = error
} finally {
  rmSync(configPath, { force: true })
}
if (failure !== undefined) {
  const status = typeof failure.status === 'number' ? ' (tsc exit ' + failure.status + ')' : ''
  fail('src/ does NOT type-check against installed dsh ' + dshVersion + status + ' — this is a real incompatibility with the running harness.')
}
console.log('check-dsh-compat: OK — src/ type-checks against installed dsh ' + dshVersion)

const provenance = artifactProvenance()
if (provenance === undefined) {
  console.log('check-dsh-compat: no lib/index.js.map — skipping bundle provenance check (run pnpm build:client to enable it)')
} else if (provenance.versions.size === 0) {
  console.log('check-dsh-compat: bundle provenance not resolvable from the source map — skipped')
} else {
  const inlined = [...provenance.versions].sort(compareVersions)
  const inlinedText = inlined.join(', ')
  console.log('check-dsh-compat: lib/index.js inlined DSH ' + inlinedText + ' (from ' + provenance.roots.size + ' checkout(s) / registry entries)')
  const floor = declaredFloor(manifest)
  if (floor !== undefined && inlined.some((version) => compareVersions(version, floor) < 0)) {
    fail('the built lib/index.js inlines DSH ' + inlinedText + ', which is OLDER than the minimum this plugin declares ('
      + floor + ') — rebuild the bundle against a supported harness (pnpm build).')
  }
  if (inlined.length === 1 && inlined[0] === dshVersion) {
    console.log('check-dsh-compat: bundle provenance matches the installed harness')
  } else if (STRICT_PROVENANCE) {
    fail('the built lib/index.js inlines DSH ' + inlinedText + ' but the installed harness is ' + dshVersion
      + ' — rebuild the bundle against the running harness (strict provenance check enabled).')
  } else {
    console.log('check-dsh-compat: note — the bundle inlines DSH ' + inlinedText + ' while the installed harness is ' + dshVersion
      + '; newer harnesses are supported by design (the declared floor is ' + String(floor) + '), so this is not a failure. '
      + 'Run `pnpm build` when convenient to refresh the inlined internals; pass --strict to fail on drift.')
  }
}
