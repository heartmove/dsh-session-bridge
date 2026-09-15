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
 *   node scripts/check-dsh-compat.mjs [--dsh <path>]
 *
 * <path> may be either the DSH package directory or the `@deepseek-ai` scope
 * directory that holds dsh-session, dsh-agent, ... . When omitted, the installed
 * location is probed (DSH_INSTALLED_MODULES, then `npm root -g`).
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
  return undefined
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