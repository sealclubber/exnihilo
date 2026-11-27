/**
 * Bundles AFMG's generator (`vendor/afmg/`, untouched) with the headless wrapper (`src/entry.ts`) into one
 * module, `dist/afmg.mjs`. AFMG imports through an `@/` alias without file extensions, which Node does not
 * resolve on its own. Two of its modules (`utils/i18n.ts`, `model/icon-sets.ts`) call Vite's
 * `import.meta.glob` to load translations and icons; neither is wanted here, so it is stubbed.
 *
 * Usage: node packages/worldgen/scripts/build.ts   (or `npm run build -w @worldsim/worldgen`)
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const bundlePath = `${root}dist/afmg.mjs`;

export async function buildBundle(): Promise<string> {
  await build({
    entryPoints: [`${root}src/entry.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': `${root}vendor/afmg` },
    loader: { '.json': 'json' },
    define: { 'import.meta.glob': 'globStub' },
    banner: { js: 'const globStub = () => ({});' },
    outfile: bundlePath,
    logLevel: 'warning',
  });
  return bundlePath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(`Built ${await buildBundle()}`);
