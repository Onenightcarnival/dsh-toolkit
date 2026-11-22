import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig, type Plugin } from 'vite'

/**
 * Shared build plumbing for the extension's three targets (background ES
 * service worker, iife content script, React panel). Each target has its own
 * config file; scripts/build.mjs runs them sequentially into one dist/.
 */

/**
 * Build target: `chrome` (default) or `firefox` (set EXT_TARGET=firefox or
 * pass --firefox to scripts/build.mjs). Each target has its own manifest and
 * output directory.
 */
export const browserTarget = process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'
export const targetManifest = browserTarget === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

export const outDir = resolve(import.meta.dirname, browserTarget === 'firefox' ? 'dist-firefox' : 'dist')

/** Copy manifest, locale catalogs, icons and license into the target's outDir. */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    copyFileSync(resolve(import.meta.dirname, targetManifest), resolve(outDir, 'manifest.json'))
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
    copyFileSync(resolve(import.meta.dirname, 'LICENSE'), resolve(outDir, 'LICENSE'))
  },
}

/** Module lists of the target's builds; scripts/build.mjs turns them into the third-party notices. */
export const bundledModulesDir = resolve(import.meta.dirname, 'node_modules/.bundled-modules', browserTarget)

/** Record the modules with code in each output chunk. */
export const recordBundledModules: Plugin = {
  name: 'record-bundled-modules',
  generateBundle(_options, bundle): void {
    mkdirSync(bundledModulesDir, { recursive: true })
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      const files = Object.entries(chunk.modules)
        .filter(([id, module]) => module.renderedLength > 0 && !id.startsWith('\0'))
        .map(([id]) => id.replace(/\?.*$/, ''))
      writeFileSync(resolve(bundledModulesDir, `${chunk.fileName.replaceAll('/', '_')}.json`), JSON.stringify(files))
    }
  },
}

/** Shared plugins for every target: tsconfig paths (plugin protocol source,
 * SDK-like source consumption), the manifest copy and the module record. */
export const sharedPlugins = [tsconfigPaths({ projects: ['./tsconfig.json'] }), copyManifest, recordBundledModules]

/** Shared build options for the non-panel targets. */
export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    define: {
      'import.meta.env.EXT_TARGET': JSON.stringify(browserTarget),
    },
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: sharedPlugins,
  })
}
