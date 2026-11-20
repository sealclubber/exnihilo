# World Sim

A persistent world explored from a world map down to a street. Worlds are
authored in Azgaar's Fantasy Map Generator (AFMG) and imported. Each settlement
is turned into a city of simulated residents who will later follow daily
routines, have generated histories, and be talked to through an LLM.

Work is done in phases, one gameplan per phase. Read the gameplan for the
current phase before starting, and the README for how things run today.

## Commands

| Task | Command |
| --- | --- |
| Type-check and run every test | `npm run check` |
| Tests only | `npm test` |
| Type-check only | `npm run typecheck` |
| Import an AFMG export | `npm run import -- fixtures/afmg/lomia.json` |
| Start the API server | `npm run server` |
| Start the viewer | `npm run client` |
| Generate one city | `npm run generate -- <settlement id>` |
| Print a settlement's day | `npm run day -- <settlement id> --day <number>` |

Node.js 24 or newer runs the TypeScript directly; there is no build step for
the server. Run `npm run check` before calling any task done.

## Layout

| Path | Holds | May depend on |
| --- | --- | --- |
| `packages/core` | World format, AFMG importer, setting pack format, city generator, layout format and generator, daily life | Nothing in this repository |
| `packages/server` | SQLite storage, pack loader, commands, world clock, HTTP API | `core` |
| `packages/client` | Browser viewer, city inspector and living town map | `core`, for types only |
| `packs/medieval` | The first setting pack, as YAML | n/a |
| `fixtures/afmg/lomia.json` | The Lomia export used by every test | n/a |

## Rules that always hold

These are enforced by `packages/core/test/boundaries.test.ts` where a test can
enforce them. Do not weaken that test to make a change pass.

1. **`core` is pure.** No disk, network, clock or unseeded randomness. It
   receives parsed data and returns data.
2. **AFMG stops at the importer.** Only `packages/core/src/afmg` may know
   AFMG's structures or field names. Everything else reads our own world
   format, so that AFMG can be replaced later.
3. **The brief is the generator's only world input.** The city generator
   takes a settlement brief, a setting pack and a seed, and reads nothing else.
4. **No setting knowledge in code.** Code knows the seven workforce
   categories, the brief's flags and the shapes of records. Every occupation,
   building type and district kind lives in the pack. If code needs to know
   that a tanner exists, the design is wrong.
5. **No hard-coded numbers.** Every share, weight, capacity, age, rate and
   probability comes from the pack.
6. **Determinism.** The same inputs give byte-identical output. Each pipeline
   step draws randomness only from its own stream (`stepRng(seed, step)`).
   Lists are output in ID order.
7. **Exact totals.** A city has exactly the brief's population, and category
   and occupation counts sum exactly. Where realism and an exact total
   conflict, keep the total.
8. **Generated data is derived, not stored.** Nothing the city generator
   produces is written to the world store.
9. **No economy.** There are no goods, prices, stock or trade deals. A
   settlement's specialty tags are the only trace of AFMG's economy.
10. **Nothing invented on import.** If the export lacks a value, the field is
    absent. No guessed defaults.
11. **Layout is a separate module that reads a finished city.**
    `packages/core/src/layout` takes a city, its brief, the pack and a seed,
    and never reaches back to change the city. Its random streams are named
    apart from the city generator's (`layout-…`).
12. **Consumers read the layout format, never the generator.** The viewer,
    the API, the path function and anything built later may use only what
    `layout/records.ts` guarantees. A segment is a polyline and a lot is a
    polygon: nothing that reads a layout may assume straight streets, right
    angles, rectangles or a grid. The current generator (`layout/grid.ts`) is
    deliberately regular and will be replaced; the format will not.

13. **Nothing is stepped.** A resident's whereabouts are a pure function of
    game time: a day plan is derived from the person, the day number, the
    city, the layout, the pack and a seed, and a position is a plan plus a
    game time. There is no tick that moves people. If you find yourself
    updating a position from the previous position, stop.
14. **No day-to-day state.** Nothing about a resident accumulates. A plan's
    random stream comes from the seed, the person's ID and the day number, so
    it never depends on which other plans were computed, or in what order.
15. **`core` never reads a clock.** Game time is always an argument. The
    world clock lives in `server`, and is the only state stored besides the
    imported world.
16. **The client stays thin.** It moves dots along the trips it was sent and
    shows a clock. It does not plan, choose or decide.
17. **`life` reads the layout format and the path function**, and nothing
    from the layout generator.

## The layout format

A layout belongs to one settlement. Coordinates are metres, origin at the town
centre, x east and y south; bearings are degrees clockwise from north.

- **One lot per building**, and every building has one.
- **The graph is the truth for movement.** A lot is reached through its
  entrance point on its segment. Lots do not connect to each other directly.
- **The brief's bearings are facts.** Exits and water honour them, within
  `BEARING_TOLERANCE` as seen from the centre.
- **District areas** are one or more polygons that touch each other and enclose
  the district's lots.
- **The summary names the generator** that made the layout, so generators can
  coexist.
- Every length, width and density limit comes from `packs/medieval/layout.yaml`.

## Conventions

- **Schemas first.** Records and pack files are Zod schemas with types derived
  from them. Add the schema before the code that uses it.
- **IDs** are strings of the form `kind-number`, such as `settlement-641`.
  Generated records carry the settlement's number and are zero-padded:
  `person-641-000123`.
- **Generator version.** Raise `GENERATOR_VERSION` in
  `packages/core/src/city/generate.ts` whenever output for the same inputs
  would change, and raise the pack's `version` when the pack's data changes.
  Layouts have their own `LAYOUT_VERSION` in
  `packages/core/src/layout/records.ts`, raised whenever a layout for the same
  inputs would change.
- **Invariants.** Every rule a generated city must satisfy goes in
  `packages/core/src/city/invariants.ts`, and every rule a layout must satisfy
  in `packages/core/src/layout/invariants.ts`. Each generator runs them on its
  own output; tests run them on every settlement in Lomia. Every rule a day
  plan must satisfy goes in `packages/core/src/life/invariants.ts`.
- **Game time** is a number of game seconds since the start of day 1; day
  numbers count from 1. Times of day in pack files are written `"HH:MM"`.
- **Errors name their subject.** A failure says which settlement, field or
  pack entry caused it and what to change.
- **Tests come with the code**, in the same change.
- **Pack files are for people.** Keep the explanatory comments at the top of
  each YAML file accurate when the format changes.
- **Imports** use explicit `.ts` extensions; the client imports types only
  from `@worldsim/core`.

## Working agreement

- **Stay inside the gameplan's scope.** If something on its "Do not build"
  list seems necessary, stop and ask.
- **Ask, don't guess.** If the data, the code and the gameplan disagree,
  report the disagreement with evidence before working around it.
- **Keep names the code already uses.** Where a gameplan names something
  differently from existing code, follow the code and say so.
- **Setting content is the user's decision.** The pack describes a
  pre-modern fantasy world and may include harsh institutions. Do not remove,
  soften or ignore pack content on your own judgement; if something is unclear,
  list it for review as `specialties.yaml` does for ignored tags.
- **Update the README** when commands, endpoints or pack files change.

## Later phases, for orientation

An avatar in the town, encounters and conversation between residents, needs
and state that carry from day to day, a layout generator that makes
natural-looking towns, building footprints, history generated backward from
the present, persistence of changes, and LLM conversations. Do not build ahead for
these, but do not make choices that block them: records need stable IDs, and
anything a later generator derives must come from the brief, the pack and a
seed.

