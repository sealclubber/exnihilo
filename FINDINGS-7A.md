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

## Step 2: the export built in memory (stopped, then accepted)

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

**Decision (Nov 27, 2026).** Wars, campaigns and coats of arms are not wanted; what matters is the terrain. The
differences above are accepted. `packages/worldgen/test/world.test.ts` allows exactly those paths and fails on any
other difference; it also checks that the grid, the cells, vertices, features, rivers, routes and name bases are
equal.

## Step 3: through the importer (done)

- **The importer had to change by one line.** It required each state's `campaigns`, and threw on the generated
  export (`state 1: field "campaigns" is missing`). A state without `campaigns` now has no wars, as the project's
  rule has an absent value stay absent (`packages/core/src/afmg/importer.ts`; a test in `importer.test.ts`). The
  world format is unchanged. The importer still reads no `pack.events`.
- `createWorld(lomiaOptions)` equals `importAfmg(fixture).world` in everything but two things:
  - `info.source.version`: `1.159.0`, against `1.158.0`.
  - every state's `wars`: none, against the fixture's (23 states).
- The import report differs as expected: an `unverified-version` warning (the importer was verified against
  1.158), and `pack.events` among the sections not read.

**The wrapper, beyond the reference.**
- **Template and seed.** AFMG's defaults leave `generation.template` and `map.seed` empty; its interface fills
  them in. Headless, an empty or unknown template is taken for an image heightmap and fails for want of a canvas
  (`document.createElement is not a function`). The wrapper now requires one of the 14 procedural templates
  (read from AFMG's `data/heightmap-templates.ts`) and a seed, and refuses with a message naming the choices.
- **Points.** With `map.graph.points` at 0, AFMG never returns. The wrapper refuses 0 and below.
- **Dialogs.** A small or cold world has too few populated cells for the cultures asked for. AFMG then logs a
  warning and opens a dialog saying the same ("Extreme climate warning", `model/society/cultures-generator.ts`),
  which fails without a page and stops the whole run. The bundle replaces AFMG's `ui/dialog/dialog.ts`
  with a stand-in whose every call does nothing (`src/headless/dialog.ts`, an esbuild plugin in
  `scripts/build.ts`). Nothing under `vendor/afmg/` is changed, and nothing a dialog does feeds the world; Lomia
  is reproduced the same with it.

The tests of the gameplan's table that this covers all pass: same input, same world; no leak (Lomia after a
small archipelago equals Lomia first); `Math.random` restored after a run and after one AFMG fails inside
(`climate: null` fails at the temperatures step); overlapping calls each correct.

## Step 4: a second and third world (done)

**A new world needs AFMG's new-map rolls.** With only a seed, a template and points merged over AFMG's defaults,
the world has no name and the importer refuses it (`info.mapName must not be empty`). In AFMG, a new map first
rolls its settings from the seed (`Options.randomize`: the map's name, culture set and count, states, provinces,
religions, the climate, the distance scale, the year and era; `app/lifecycle.ts`, `generate`). Reproducing an
export does not need that, because the export's options hold what was rolled. So the wrapper has two ways:
- **Saved settings** (the default): the caller's options over AFMG's bare defaults. Lomia is made this way.
- **`roll`**: as AFMG's `generate` does for a given seed: the graph size, the seed (`Math.random = Alea(seed)`,
  the two lines of `app/seed.ts`'s `setSeed` for a given seed, copied because importing it brings the whole app),
  `Options.randomize()`, then the caller's options over that. `newWorldOptions({ seed, template, points })` builds
  this call.
- The page address is stubbed as `?options=default`, AFMG's own way of asking for a fresh browser's map: pins a
  user saved in `localStorage` are ignored, so nothing outside the call shapes the world.

| World | Seed | Grid cells | Refined cells | Rivers | Burgs | Time |
| --- | --- | --- | --- | --- | --- | --- |
| `continents`, 20,000 points | `1127` | 20,048 | 13,665 | 187 | 1,080 | 1.5 to 1.7 s |
| `archipelago`, 5,000 points | `5005` | 4,984 | 2,545 | 96 | 469 | 0.3 s |

Each gave the same fingerprint on two runs and imports without error (warnings: the unverified version, and
provinces without a seat, 11 and 8, as Lomia has some). Saved in `fixtures/worlds/` as the options and the
fingerprint; `packages/worldgen/test/new-worlds.test.ts` holds them.

## A note on the project's rules

CLAUDE.md rule 2 has only `packages/core/src/afmg` know AFMG's structures. `packages/worldgen` is AFMG, and its
export builder knows AFMG's shapes by necessity. The boundaries test checks `core`, `server` and `client` only,
so it is not affected; `core` does not depend on `worldgen`.
