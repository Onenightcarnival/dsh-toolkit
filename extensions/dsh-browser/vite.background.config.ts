import { browserTarget, copyManifest, outDir, targetBuild } from './vite.shared.ts'

/**
 * Background: Chrome loads an ES-module service worker (`"type": "module"`);
 * Firefox loads a classic event-page script, bundled as an IIFE. Both output
 * background.js.
 */
export default targetBuild(
  'src/background/index.ts',
  browserTarget === 'firefox' ? 'iife' : 'es',
  'background.js',
  true,
)

export { copyManifest, outDir }
