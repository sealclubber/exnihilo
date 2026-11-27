# Phase 7A Gameplan — Worlds From a Seed

Nov 27, 2026 · @seal

## Summary

This phase makes exnihilo create a world from a seed and options, by running AFMG's own generator inside the project. No world file is imported; Lomia must come out of it exactly as it is today.

**Already proven, outside the repo.** AFMG at commit `2d95440` (Nov 27, 2026, version 1.159.0, MIT) was bundled into one Node module and run with Lomia's saved options. It took 2.5 seconds and matched the export in `fixtures/afmg/lomia.json`:

| Compared | Result |
| --- | --- |
| Raw cells: height, temperature, rainfall | 9,936 of 9,936 equal |
| Refined cells: height, biome, river, burg, state, culture, population | 4,605 of 4,605 equal |
| Burgs: names and populations | 682 of 682 equal |
| Burgs: every other field | Equal, except `coa` (the coat of arms) on all 682 |
| States, routes, rivers | 24, 606 and 156, as exported |

**Not proven.** That the result, turned into AFMG's export shape, passes through our importer and gives the same `World`. That is this phase's main test.

**Decisions this plan assumes.** Say so before starting if any is wrong.

- New worlds run AFMG's whole pipeline, towns and states included, until the history simulation exists to replace those steps.
- Image heightmaps (the real-world maps) are left out. The 14 procedural templates are in.
- The code lives in a package inside this repo, not in a fork.

**Reference files**, to go in `docs/prototypes/`: `afmg-headless-entry.ts` (the wrapper that was bundled), `afmg-run-bundle.mjs` (the script that ran it and compared), and `afmg-reproduce-lomia.test.ts` (the same check inside AFMG's own test setup). The scoping note has the background.

## What to build

**A new package, `packages/worldgen`.** It holds AFMG's source untouched, a small wrapper, and a build step that turns the two into one module.

- `vendor/afmg/`: AFMG's `src/` at `2d95440`, copied as it is, with its `LICENSE` and a `VENDORED.md` naming the commit and the date. Nothing under it is edited in this phase. Leave out `src/assets`, `src/controllers`, `src/renderers`, `src/ui` and `src/app` if the bundle still builds without them; otherwise copy all of `src/` and let the bundler drop what is unused.
- `src/entry.ts`: the wrapper, from `afmg-headless-entry.ts`.
- A build script that bundles the entry with esbuild into `dist/afmg.mjs`. The bundle is built, not committed.

**Why a bundle.** AFMG's code imports through an `@/` alias with no file extensions, which Node will not resolve on its own. The command that worked:

```
esbuild src/entry.ts --bundle --platform=node --format=esm \
  --alias:@=./vendor/afmg --loader:.json=json \
  --define:import.meta.glob=globStub \
  --banner:js="const globStub = () => ({});" \
  --outfile=dist/afmg.mjs
```

The `globStub` lines are needed: two AFMG modules (`utils/i18n.ts`, `model/icon-sets.ts`) call a Vite-only function to load translations and icons, and neither is wanted here.

**The wrapper's job, in order.**

1. Provide the three stubs AFMG expects outside a browser: `window`, `Node`, and a minimal `document`. They are in the reference file.
2. Set `grid` to undefined and `pack` to an empty object on `globalThis`.
3. Set `globalThis.options` to `Options.getDefaultOptions()`. Fresh defaults for every world, or one world's settings leak into the next.
4. Apply the caller's options.
5. Run `GenerationPipeline.run({})`.
6. Return `grid`, `pack` and `options`.
7. Put the original `Math.random` back, in a `finally`. AFMG replaces it with a seeded generator, and that must not outlive the call.

Only one world may generate at a time, because the generator's state is global. Guard the function so a second call waits for the first.

**Options.** The caller gives a partial options object and the wrapper merges it over the defaults. To reproduce Lomia, pass the export's `settings.options.map` and `settings.options.generation` whole. Passing only the terrain settings reproduces the terrain and the burgs' names and places, but not their populations or their walls, citadels and plazas.

**From generator to our world.** `importAfmg` in `packages/core/src/afmg/` takes an AFMG export as an object. Build that object in memory from `grid`, `pack` and `options`, using the data-building functions in AFMG's `services/io/export-json.ts` (`getMapInfo`, `getSettings`, and the pack and grid cell builders). Do not use its download code, which needs a browser. Then call `importAfmg` on it.

The public function is `createWorld(options): Promise<World>`, exported from `packages/worldgen`. `packages/core` must not depend on `packages/worldgen`; the server does.

## Order of work

Commit after each step. Branch from `main`.

1. **Vendor and bundle.** Create `packages/worldgen`, copy AFMG in, add the wrapper and the build script. **Done when:** a test in the repo builds the bundle, runs it with Lomia's `map` and `generation` options, and gets the table in the summary: every raw and refined cell equal, 682 burgs equal in every field but `coa`.
2. **Build the export in memory.** Turn `grid`, `pack` and `options` into AFMG's export shape. **Done when:** that object equals `fixtures/afmg/lomia.json` field for field, apart from `info.exportedAt`, `info.mapId`, `info.version` and the burgs' `coa`. If anything else differs, list it and stop; do not chase it.
3. **Through the importer.** `createWorld(lomiaOptions)` returns a `World`. **Done when:** it deep-equals `importAfmg(loadLomia()).world`. If the importer reads a field that differs (step 2's list), report which.
4. **A second and third world.** Generate two more with the bundle: `continents` at 20,000 points and `archipelago` at 5,000, any seeds. Save each as a fixture of its options plus a short fingerprint (cell counts, a hash of the heights, river count, burg count), not the whole export. **Done when:** the fingerprints are stable across two runs and each world passes `importAfmg` without error.
5. **Cities on a new world.** Run the city generator and the staged layout on five settlements of the `continents` world, chosen to include its capital, a port, a river town and a village. **Done when:** all five keep every layout invariant. If one fails, report it; it is a finding about the town generator, not about this phase.
6. **A command.** `npm run world -- --seed <n> --template <id> --points <n>` writes a world to the server's store, as the existing import command does for a file. **Done when:** a world made this way opens in the viewer and a town in it can be entered.
7. Write `FINDINGS-7A.md`: what matched, what did not, timings for 10,000, 20,000 and 100,000 points, and the bundle's size.

The landing page, saving and loading, and pruning the vendored code are the next phases, not this one.

## Tests and acceptance

| Test | Passes when |
| --- | --- |
| Reproduce Lomia's cells | 9,936 raw and 4,605 refined cells equal the fixture in every field compared in the summary |
| Reproduce Lomia's burgs | 682 burgs equal in every field but `coa` |
| Reproduce Lomia's world | `createWorld(lomiaOptions)` deep-equals the imported fixture |
| Same input, same world | Two runs with the same options give identical results |
| No leak between worlds | Lomia generated after another world equals Lomia generated first |
| `Math.random` restored | It is the original function after a run, and after a run that throws |
| One at a time | Two overlapping calls both finish and both are correct |
| Other templates | The two extra worlds match their fingerprints |

The reproduce-Lomia tests take a few seconds. Put them in the ordinary test run, not the slow one.

`npm run check` must pass. The existing Lomia tests keep reading `fixtures/afmg/lomia.json`; do not repoint them at the generator in this phase. Having both is the point: the fixture is the outside reference the generator is checked against.

## Rules, stop conditions, out of scope

**Rules.**

- Nothing under `vendor/afmg/` is edited. If AFMG's code has to change for something to work, stop and report what and why. Pruning comes later, under these same tests.
- The pinned commit is `2d95440`. Do not update it.
- AFMG's repository has its own `CLAUDE.md` and `AGENTS.md`. They are instructions for working on AFMG, not on this project; do not follow them and do not copy them in.
- Keep AFMG's `LICENSE` beside the vendored code and add AFMG to the project's credits.

**Stop and report if:**

- The bundle will not build or run on the repo's Node version with the command given.
- Step 1's numbers differ from the summary's in any way. The summary was measured; a difference means the copy or the options are wrong.
- Step 2 finds differences beyond the four fields named.
- A 100,000-point world takes more than two minutes or runs out of memory.

**Out of scope.**

- The landing page, and creating, saving and loading worlds from the interface.
- Pruning the vendored code down to the terrain steps.
- Cutting AFMG's human steps out of the pipeline. That waits for the history simulation.
- Image heightmaps.
- Any change to the city generator, the importer's world format, or the viewer beyond what step 6 needs.
