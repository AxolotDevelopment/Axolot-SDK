import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'lib/cms': 'src/lib/cms.ts',
    'components/index': 'src/components/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  shims: true,
  external: ['astro', 'node:fs', 'node:path', 'node:fs/promises', './AxolotBridge.astro'],
  async onSuccess() {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    
    // Ensure dist/components directory exists
    await fs.mkdir(path.join(__dirname, 'dist', 'components'), { recursive: true })
    
    // Copy the Astro component
    await fs.copyFile(
      path.join(__dirname, 'src', 'components', 'AxolotBridge.astro'),
      path.join(__dirname, 'dist', 'components', 'AxolotBridge.astro')
    )
    console.log(' [SDK Build] AxolotBridge.astro copied successfully to dist/components 🚀')
  }
})
