/**
 * Build for dsh-session-bridge with tsdown (rolldown): one self-contained
 * host ESM bundle (every non-node: dependency — including all
 * @deepseek-ai/dsh-* imports — is inlined), so the plugin loads from any
 * assembly path without runtime resolution.
 */
import type { UserConfig } from 'tsdown'

const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [],
    alwaysBundle: (id: string) => !id.startsWith('node:'),
  },
  outputOptions: { entryFileNames: 'index.js' },
}

export default [hostBundle] satisfies UserConfig[]
