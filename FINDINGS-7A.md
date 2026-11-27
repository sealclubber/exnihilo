# Phase 7A findings: worlds from a seed

Branch `7a-worldgen`. AFMG vendored at `2d95440` (Nov 27, 2026, version 1.159.0).

## Step 1: vendor and bundle (done)

- `packages/worldgen/vendor/afmg/` is AFMG's whole `src/` at `2d95440`, byte for byte, with its `LICENSE`.
  Leaving out `assets`, `controllers`, `renderers`, `ui` and `app` does not build: the generator imports
  `@/ui/dialog/dialog` (from `model/society/cultures-generator.ts`), so all of `src/` is copied and the bundler
  drops what is unused.
- `VENDORED.md` (commit, date, why everything is kept) is at `packages/worldgen/vendor/VENDORED.md`, beside
  `afmg/` and not in it as the gameplan has it, because nothing under `vendor/afmg/` may be added to or edited.
- AFMG's runtime dependencies used by the generator (`alea`, `d3`, `delaunator`, `lineclip`, `polylabel`, `zod`)
  are pinned at the versions in AFMG's own lockfile.
- `scripts/build.ts` runs esbuild through its API with the gameplan's options; `dist/afmg.mjs` is 2.78 MB, built,
  not committed (`dist/` is ignored). `src/generator.ts` builds it when it is missing or older than the wrapper.
- The wrapper switches off AFMG's per-step timing and info logs through AFMG's own logger (`log.enabled`);
  warnings and errors still show.

With Lomia's saved `map` and `generation` options, in 0.7 s
(`packages/worldgen/test/reproduce-lomia.test.ts`):

| Compared | Result |
| --- | --- |
| Raw cells: height, temperature, rainfall | 9,936 of 9,936 equal |
| Refined cells: height, biome, river, burg, state, culture, population | 4,605 of 4,605 equal |
| Burgs | 682; every field equal but `coa` (682) |
| States, routes, rivers | 24, 606 and 156, as exported |
| `Math.random` afterwards | the original |

The same as the gameplan's summary in every figure.

## Step 2: the export built in memory (stopped)

**How it is built.** The builders in AFMG's `services/io/export-json.ts` (`getMapInfo`, `getSettings`,
`getPackCellsData`, `getGridCellsData`) are not exported; the module exports only `exportToJson`, which needs a
browser to download a file. They are copied word for word into the wrapper, with types added, and run while the
generator's globals still hold the world. `VERSION` comes from `services/versioning.ts`, which imports AFMG's
whole interface (`@/services`, dialogs, three.js, quill, dropbox, ...); the build reads the constant from the
file instead.

**Stop: differences beyond the four fields named.** `node packages/worldgen/scripts/compare-export.ts`, each
path with list positions folded, and how many values differ:

| Path | Count | Example (generated, fixture) |
| --- | --- | --- |
| `info.exportedAt`, `info.mapId` | 1, 1 | expected |
| `info.version` | 1 | `1.159.0`, `1.158.0` (expected) |
| `pack.burgs[].coa.shield` | 682 | `pavise`, `roman` (expected) |
| `pack.provinces[].coa.shield` | 168 | `pavise`, `roman` |
| `pack.states[].coa.shield` | 23 | `pavise`, `roman` |
| `pack.states[].campaigns` | 23 | only in the fixture: each state's wars |
| `pack.events` | whole list | only in the generated: 24 events, the wars (`type: "war"`, attackers, defenders) |
| `pack.states[0].diplomacy` | 1 | only in the fixture: the placeholder state's war log |
| `pack.states[].military[]`: `note`, `icon`, `x`, `y` | 77, 18, 20, 20 | regiment notes name other wars and years; other places |
| `pack.markers[].note` | 2 | battle markers name other wars |
| `pack.zones` | 10 zones, 12 in the fixture | other invasions, rebels, proselytism |
| `pack.journeys[]` | 1 journey, every segment | "The Quest of Captain Cale", fixture "The Helanian Campaign" |
| `settings.options.app.*`: `battle`, `emblems.shape`, `export.pngResolution`, `performance.viewportRedraw` | 1 each | interface preferences: AFMG's defaults, fixture the exporter's own |

Everything else, the cells, vertices, features, biomes, cultures, burgs but `coa`, states but the fields above,
provinces but `coa`, religions, rivers, routes, the rest of `settings`, `grid` and `nameBases`, is equal.

**What the differences have in common.** The fixture was exported from AFMG 1.158.0; the pin is 1.159.0. All of
it is AFMG's history layer (wars, campaigns, regiments, battles, zones, journeys), the coats of arms, and the
interface preferences of whoever exported the file. The terrain, the towns and the states themselves are equal.
I have not traced which change between 1.158.0 and 1.159.0 did it.

**What it means for step 3.** The importer reads each state's `campaigns` into its wars
(`packages/core/src/afmg/importer.ts`, around line 274) and its `diplomacy`. The generated export has no
`campaigns`, so `createWorld(lomiaOptions)` would give every state no wars and could not deep-equal the imported
fixture. The importer reads none of `coa`, `events`, `military`, `markers`, `zones`, `journeys` or
`settings.options.app`. Step 3 has not been started.

**Decisions needed.** Some ways forward, none taken:
- Accept `events` in place of `campaigns` and teach the importer to read wars from either; the step 3 test then
  compares everything but the states' wars.
- Compare step 3 without the states' wars, and leave reading `events` to a later phase.
- Re-export `fixtures/afmg/lomia.json` from AFMG 1.159.0, so that the outside reference and the pin agree. The
  existing Lomia tests would then run on the new export.

## A note on the project's rules

CLAUDE.md rule 2 has only `packages/core/src/afmg` know AFMG's structures. `packages/worldgen` is AFMG, and its
export builder knows AFMG's shapes by necessity. The boundaries test checks `core`, `server` and `client` only,
so it is not affected; `core` does not depend on `worldgen`.
