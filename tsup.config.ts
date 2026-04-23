import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/types/index.ts'],
  format: ['esm', 'cjs'],
  splitting: false,
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
  treeshake: true,
  outDir: 'dist',
  external: ['exsorted', 'ex-flow'],
  outExtension({ format }) {
    return {
      js: format === 'cjs' ? '.cjs' : '.mjs',
    };
  },
});
