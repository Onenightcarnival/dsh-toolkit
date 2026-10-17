import { defineConfig } from 'tsdown'

/**
 * Runtime entries: the plugin (index) and the
 * protocol module (`@onenightcarnival/dsh-bridge-browser/protocol`, imported
 * by the extension).
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/protocol.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
