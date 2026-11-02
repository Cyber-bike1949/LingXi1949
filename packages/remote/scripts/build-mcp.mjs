import { build } from 'esbuild';
await build({ entryPoints: ['packages/remote-sdk/index.mjs'], outfile: 'packages/remote-sdk/dist/index.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24' });
