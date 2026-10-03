import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Build and check tests run the real esbuild, Vue/Svelte compilers and
    // TypeScript (parsing lib.dom.d.ts); a cold first load exceeds the 5s default
    // on a busy machine.
    testTimeout: 30_000,
  },
});
