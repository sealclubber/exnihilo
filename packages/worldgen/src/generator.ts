/**
 * Loads AFMG's generator: the bundle `dist/afmg.mjs`, built from `vendor/afmg/` and `src/entry.ts` when it is
 * missing or older than the wrapper (`scripts/build.ts`). The bundle is built, never committed.
 */
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildBundle, bundlePath, root } from '../scripts/build.ts';

/** What AFMG made: its `grid`, `pack` and `options`, in its own shapes. */
export interface Generated {
  grid: any;
  pack: any;
  options: any;
  /** The world as AFMG's "Full" JSON export, the text a downloaded `.json` file holds. */
  json: string;
}

/** AFMG's options, any part of them: objects merge over the defaults key by key; anything else replaces. */
export type AfmgOptions = { [key: string]: unknown };

export type GenerateWorld = (options?: AfmgOptions) => Promise<Generated>;

export interface Generator {
  /** Makes one world. A call made while another runs waits for it: AFMG's state is global. */
  generate: GenerateWorld;
  /** The ids of AFMG's 14 procedural heightmap templates. */
  templateIds: () => Promise<string[]>;
}

let loading: Promise<Generator> | undefined;

const stale = () => {
  if (!existsSync(bundlePath)) return true;
  const built = statSync(bundlePath).mtimeMs;
  return [`${root}src/entry.ts`, `${root}src/headless/dialog.ts`, `${root}scripts/build.ts`].some((source) => statSync(source).mtimeMs > built);
};

/** AFMG's generator, loaded once. */
export function loadGenerator(): Promise<Generator> {
  return (loading ??= (async () => {
    if (stale()) await buildBundle();
    const bundle = (await import(pathToFileURL(bundlePath).href)) as { generateWorld: GenerateWorld; templateIds: () => Promise<string[]> };
    return { generate: bundle.generateWorld, templateIds: bundle.templateIds };
  })());
}
