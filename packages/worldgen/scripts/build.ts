/**
 * Bundles AFMG's generator (`vendor/afmg/`, untouched) with the headless wrapper (`src/entry.ts`) into one
 * module, `dist/afmg.mjs`. AFMG imports through an `@/` alias without file extensions, which Node does not
 * resolve on its own. Two of its modules (`utils/i18n.ts`, `model/icon-sets.ts`) call Vite's
 * `import.meta.glob` to load translations and icons; neither is wanted here, so it is stubbed. AFMG's version
 * is read from its source and put in as `AFMG_VERSION`. AFMG's dialog module (`ui/dialog/dialog.ts`) is replaced by
 * a headless stand-in (`src/headless/dialog.ts`): the generator opens a dialog only to repeat a warning it has
 * already logged, and opening one needs a page.
 *
 * Usage: node packages/worldgen/scripts/build.ts   (or `npm run build -w @worldsim/worldgen`)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const bundlePath = `${root}dist/afmg.mjs`;

/** AFMG's version, read from its `services/versioning.ts`: importing that module brings AFMG's whole interface. */
export function afmgVersion(): string {
  const found = /export const VERSION = "([^"]+)"/.exec(readFileSync(`${root}vendor/afmg/services/versioning.ts`, 'utf8'));
  if (!found?.[1]) throw new Error('packages/worldgen: no `export const VERSION` in vendor/afmg/services/versioning.ts');
  return found[1];
}

export async function buildBundle(): Promise<string> {
  await build({
    entryPoints: [`${root}src/entry.ts`],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@': `${root}vendor/afmg` },
    loader: { '.json': 'json' },
    define: { 'import.meta.glob': 'globStub', AFMG_VERSION: JSON.stringify(afmgVersion()) },
    banner: { js: 'const globStub = () => ({});' },
    plugins: [
      {
        name: 'headless-dialog',
        setup(builder) {
          builder.onResolve({ filter: /(^@|\/vendor\/afmg)\/ui\/dialog\/dialog$/ }, () => ({ path: `${root}src/headless/dialog.ts` }));
        },
      },
    ],
    outfile: bundlePath,
    logLevel: 'warning',
  });
  return bundlePath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(`Built ${await buildBundle()}`);
