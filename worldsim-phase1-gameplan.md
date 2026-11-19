# World Sim — Phase 1 Gameplan

Nov 19, 2026 · @seal

Phase 1 builds the importer that turns an AFMG export into our own world format, and a browser viewer for it. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Import the Lomia AFMG export into our own world format, store it, and show it in a browser: a world map you can pan and zoom, where clicking a settlement shows its settlement brief.

**Done when:** all acceptance tests below pass, and clicking Badanos on the map shows the brief with the values listed there.

## Context

World Sim is a persistent world you explore from a world map down to a street, where NPCs live simulated lives and can be talked to through an LLM. Worlds are authored in Azgaar's Fantasy Map Generator (AFMG) and imported. Later phases generate a city from each settlement, simulate its residents, and generate history backward from the present.

Decisions that constrain this phase:

- **Server owns the world.** A Node.js server holds the world; a browser client views it. They run on different machines.
- **Our own world format.** Only the importer reads AFMG field names. Everything else reads our format, so AFMG can be replaced later.
- **Settlement brief.** The later city generator takes one input per settlement, the brief. Producing correct briefs is the main output of this phase.
- **No economy.** AFMG's goods, prices, deals and markets are not imported. The only thing taken from them is the names of the goods a settlement produces, as specialty tags.
- **Determinism.** The same input file always produces byte-identical output.

## Scope

**Build**

- A repository with three packages and automated tests
- Types and validation for the world format
- An AFMG importer: export JSON in, world format out, plus a report of anything missing or unexpected
- Storage of one imported world in SQLite
- A command to import a file
- A server API that serves the world and settlement briefs
- A browser viewer: world map, pan and zoom, click a settlement for its brief

**Do not build**

- Any city, building or person generation
- Any history generation
- Any economy, goods or trade data
- Editing of world data through the browser
- User accounts, multiple worlds, or LLM features
- Visual polish beyond a readable map

## Repository and tooling

One repository, TypeScript throughout in strict mode, three packages:

| Package | Holds | May depend on |
| --- | --- | --- |
| `core` | World format types, validation, seed utilities, the AFMG importer. Pure code: no disk, network or drawing | Nothing in this repo |
| `server` | SQLite storage, the import command, the HTTP API | `core` |
| `client` | The browser viewer | `core` for types only |

Default tooling, to be replaced only with a stated reason:

| Need | Default |
| --- | --- |
| Packages | npm workspaces |
| Runtime | Current Node.js LTS |
| Tests | Vitest |
| Validation | Zod schemas, with types derived from them |
| Storage | better-sqlite3, one file per world |
| HTTP | Fastify |
| Client build | Vite |
| Rendering | Canvas 2D, no framework required |

The Lomia export is the test fixture, placed by the user at `fixtures/afmg/lomia.json`. It is about 6.7 MB and is committed.

## World format

The importer produces these entities. Field names are ours and must not echo AFMG's abbreviations.

| Entity | Required content |
| --- | --- |
| World | Name, seed, current year, era name, source tool and version, map width and height, distance scale |
| Cell | ID, centre position, polygon, neighbour IDs, height, land or water, biome, river ID if any, distance to coast, rural population, state, province, culture, religion |
| State | ID, name, full name, government form, capital settlement, colour, neighbours, diplomacy toward each other state, wars with name, start year, end year if ended, attacker and defender |
| Province | ID, name, full name, state, seat settlement |
| Culture | ID, name, name base used for generating names, origin cultures |
| Religion | ID, name, type, form, deity, origin religions |
| River | ID, name, type, ordered cell IDs from source to mouth, parent river |
| Route | ID, name if any, kind (road, trail or sea route), ordered points |
| Settlement | The settlement brief, defined in the next section |

IDs are strings of the form `kind-number`, built from AFMG's own number: `settlement-641`, `state-4`, `cell-2134`. They are stable across re-imports of the same file.

AFMG's placeholder entries are kept as real entities with a flag: the state "Neutrals", the culture "Wildlands" and the religion "No religion".

## Settlement brief

The brief is everything a later generator may know about a settlement. It must be complete on its own, with no need to look anything up in AFMG data.

| Field | Meaning | AFMG source |
| --- | --- | --- |
| ID, name | Identity | `burg.i`, `burg.name` |
| Position, cell | Where it is on the map | `burg.x`, `burg.y`, `burg.cell` |
| Population | Townspeople, as a whole number | `burg.population` x `settings.populationRate` x `settings.urbanization`, rounded |
| Rural population | People in the surrounding countryside | `cell.pop` x `settings.populationRate`, rounded |
| Size group | Village, town, city, fort or capital | `burg.group` |
| State, province, culture, religion | IDs and names | `burg.state`, `burg.culture`; `cell.province`, `cell.religion` |
| Flags | Capital, port, citadel, walls, plaza, temple, shanty town, each true or false | `burg.capital`, `burg.port`, `burg.citadel`, `burg.walls`, `burg.plaza`, `burg.temple`, `burg.shanty` |
| Province seat | Whether it is the seat of its province | `province.burg` equals this settlement |
| Specialty tags | Names of goods produced, largest quantity first, lower case | `burg.production` joined to `goods` by `good.i` |
| River | If one crosses: ID, name, the neighbouring cell and compass bearing it arrives from, and the same for where it leaves | `cell.r`, then position in `river.cells` |
| Routes | For each exit: route ID, name, kind, the neighbouring cell it leads to, and the bearing | `cell.routes`, a map of neighbour cell to route |
| Coast | Whether the cell is coastal, and the bearing toward open water | `cell.t` equals 1; `cell.haven` |
| Climate | Biome name, height, temperature | `cell.biome`, `cell.h`, `grid.cells[cell.g].temp` |
| Seed | Derived from the world seed and the settlement ID | Ours |

Bearings are whole degrees clockwise from north, measured between cell centres. The map's y axis points down, so north is negative y.

A missing optional value is recorded as absent, never as zero or an empty string.

## AFMG export notes

These were verified against the Lomia file, exported from AFMG 1.158.0. World data is under `pack`; climate is under `grid`.

- **Placeholder first entries.** `pack.burgs[0]`, `pack.provinces[0]` and `pack.features[0]` are the number 0, not objects. Skip them.
- **Look up by `i`, not by array index.** `pack.goods`, `pack.rivers` and `pack.markets` start at `i` = 1, so index and `i` differ.
- **Zero means none.** `cell.r` = 0 means no river; `cell.burg` = 0 means no settlement; `burg.capital` = 0 means not a capital.
- **Optional keys.** `burg.port` and `burg.plaza` are absent when false. `cell.routes` is absent when no route crosses the cell. `route.name` is often absent. A war's `end` is absent while it is ongoing.
- **Population units.** `burg.population` and `cell.pop` are in thousands at Lomia's settings; always multiply by `settings.populationRate`.
- **Cell geometry.** `cell.v` lists indices into `pack.vertices`; each vertex has a position `p`. `cell.c` lists neighbouring cell IDs. `cell.p` is the centre.
- **Land and water.** `cell.h` runs 0 to 100, and below 20 is water.
- **Rivers.** `river.cells` is ordered from source to mouth, so the cell before a settlement's cell is upstream and the cell after is downstream.
- **Routes.** `cell.routes` maps a neighbouring cell ID, as a string key, to a route ID. `route.group` is `roads`, `trails` or `searoutes`.
- **Calendar.** The current year and era are at `settings.options.map.lore.calendar`.
- **Ignore entirely.** `pack.markets`, `pack.deals`, goods other than their names, and the economy fields on settlements and states.

The importer checks the export's version and every field it relies on. A missing or mistyped field stops the import with a message naming the field and the entity.

## Tasks

Work in this order. Each task ends with its tests passing before the next begins.

1. **Scaffold.** Create the repository, the three packages, strict TypeScript, the test runner and one command that runs every test.
2. **World format.** Write the schemas and derived types in `core`, with tests that valid and invalid samples are accepted and rejected.
3. **Seed utility.** Write a function in `core` that derives a seed from the world seed, a kind and an ID. It must be stable across machines and runs.
4. **Importer.** Write a pure function in `core`: parsed AFMG JSON in, a world in our format plus an import report out. Build settlement briefs here.
5. **Storage and import command.** In `server`, store a world in a SQLite file and add a command that imports an AFMG file into it. Importing the same file twice leaves identical data.
6. **API.** Serve the world summary, the map geometry, the list of settlements, and one settlement's brief by ID.
7. **Viewer.** Draw land cells coloured by state, water, rivers, routes and settlement markers. Add pan, zoom and a panel that shows the brief of the clicked settlement in readable form.
8. **Review.** Run the full test suite, then write a short README: how to install, import Lomia, start the server and open the viewer.

## Acceptance tests

All of these are automated and run against the Lomia fixture.

**World totals**

| Entity | Expected count |
| --- | --- |
| Settlements | 682 |
| Cells | 4,605 |
| States, excluding Neutrals | 23 |
| Provinces | 168 |
| Cultures, including Wildlands | 13 |
| Religions, including No religion | 18 |
| Rivers | 156 |
| Routes | 606 |

The current year is 848 and the era is "Thatcking Era".

**The Badanos brief** (`settlement-641`)

| Field | Expected value |
| --- | --- |
| Name | Badanos |
| Cell | `cell-2134` |
| Population | 9,607 |
| Rural population | 4,495 |
| Size group | city |
| State | Monzian Empire (`state-4`) |
| Province | Badanos County (`province-24`), and Badanos is its seat |
| Culture | Vengrian (`culture-8`) |
| Religion | Klakkrova Pantheon (`religion-14`) |
| Flags | All seven false |
| Specialty tags | leather, arms, in that order |
| River | Hegyes (`river-85`), arriving from `cell-2237` at bearing 152, leaving toward `cell-2029` at bearing 61 |
| Routes | Two exits, both on the Pusztaszian trail (`route-34`, a trail): toward `cell-2236` at bearing 227 and toward `cell-2029` at bearing 61 |
| Coast | Not coastal |
| Climate | Tropical seasonal forest, height 25, temperature 33 |

**Whole-world checks**

- Every one of the 682 briefs passes schema validation.
- Every ID referenced by a brief exists in the world.
- 178 settlements are ports and 210 have a river.
- Every settlement has at least one route exit.
- Importing the fixture twice produces byte-identical output.
- An export with a required field removed fails with a message naming that field.
- No file outside the importer reads an AFMG structure such as `burgs` or `pack`.

## Rules

- **`core` stays pure.** No file, network, clock or random-number access. The importer receives parsed JSON and returns data.
- **AFMG stops at the importer.** No other module reads AFMG structures or names.
- **No unseeded randomness anywhere.** Nothing in this phase needs randomness at all; the seed utility exists for later phases.
- **Stable ordering.** Lists are output in ID order so results can be compared byte for byte.
- **Nothing invented.** If the export lacks a value, the field is absent. Do not fill gaps with guesses or defaults.
- **Tests come with the code.** Each task's tests are written in the same change as the task.
- **Stay inside the scope.** If something in the "Do not build" list seems necessary, stop and ask.
- **Ask, don't guess.** If the export contradicts this document, report the contradiction with the evidence before working around it.
