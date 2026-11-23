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
| The viewer in a headless browser | `npm run test:viewer` |
| Tests only | `npm test` |
| Type-check only | `npm run typecheck` |
| Import an AFMG export | `npm run import -- fixtures/afmg/lomia.json` |
| Start the API server | `npm run server` |
| Start the viewer | `npm run client` |
| Generate one city | `npm run generate -- <settlement id>` |
| Print a settlement's day | `npm run day -- <settlement id> --day <number>` |
| Draw a town's layout to SVG | `npm run render -- <settlement id> [--generator grid\|grown]` |
| Measure the shape of laid-out towns | `node scripts/measure-layout.ts --all` |

**How long things take** (measured 2026-11-23 on the development machine, phase
6D.3). Plan around these; run a single test file with `npx vitest run <file>`
while working, and the full check once at the end.

| Task | Time |
| --- | --- |
| `npm run check` (type-check and every test) | about 8 to 10 minutes |
| `packages/core/test/lomia-cities.test.ts` (lays out all 682 settlements) | about 7 to 8 minutes |
| `packages/core/test/visitors.test.ts` (lays out all 682 under an edited pack) | about 4 to 8 minutes |
| `packages/core/test/outsiders.test.ts`, `districts.test.ts` | about 2 to 3 minutes each |
| `packages/core/test/grown.test.ts` (the five test towns) | about 1 minute |
| `npm run test:viewer` | about 1.5 minutes |
| Grown layout of one town | Badanos 1 s, Cevilefon 2 s, Pombal 8 s, the slowest of Lomia about 17 s |
| All of Lomia laid out once, one core | about 7 minutes |

The two whole-Lomia tests carry a 900-second limit of their own. Commands
that run longer than two minutes are best run in the background.

Node.js 24 or newer runs the TypeScript directly; there is no build step for
the server. Run `npm run check` before calling any task done.

## Layout

| Path | Holds | May depend on |
| --- | --- | --- |
| `packages/core` | World format, AFMG importer, setting pack format, city generator, layout format and generators, daily life, outsiders, the avatar | Nothing in this repository, and `d3-delaunay` |
| `packages/server` | SQLite storage, pack loader, commands, world clock, the avatar's state, HTTP API | `core` |
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
    apart from the city generator's (`layout-…` for the grid, `grown-…` for
    the grown generator).
12. **Consumers read the layout format, never the generator.** The viewer,
    the API, the path function and anything built later may use only what
    `layout/records.ts` guarantees. A segment is a polyline and a lot is a
    polygon: nothing that reads a layout may assume straight streets, right
    angles, rectangles or a grid. Two generators make it: `layout/grid.ts`,
    deliberately regular, and `layout/grown.ts`, the pack's choice. Either may
    be replaced; the format will not.

13. **Nothing is stepped.** A resident's whereabouts are a pure function of
    game time: a day plan is derived from the person, the day number, the
    city, the layout, the pack and a seed, and a position is a plan plus a
    game time. There is no tick that moves people. If you find yourself
    updating a position from the previous position, stop.
14. **No day-to-day state.** Nothing about a resident accumulates. A plan's
    random stream comes from the seed, the person's ID and the day number, so
    it never depends on which other plans were computed, or in what order.
15. **`core` never reads a clock.** Game time is always an argument. The
    world clock lives in `server`. The clock and the avatar are the only
    state stored besides the imported world.
16. **The client stays thin.** It moves dots along the trips it was sent,
    shows the outside stays it was sent at their points, moves the avatar
    along the path it was sent, and shows a clock. It does not plan, choose,
    find paths or decide who is nearby.
17. **`life` reads the layout format and the path function**, and nothing
    from the layout generator.
18. **Openness comes from shifts, not plans.** A building is open when
    someone who works there is on shift, worked out in `life/hours.ts` from
    shifts and rest-day duty alone. One person's plan must never depend on
    another person's plan.
19. **Place flags live in the pack.** Code must not know which building
    types are open-air or always open, or which visits are spent outside. An
    outside stay's point is derived from the person, the building and the
    stay, never remembered.
20. **The avatar is never stepped.** Its state is a resting place or a trip,
    in `packages/core/src/avatar`, and its position comes from that state and
    a game time. No timer moves it. It is always on a segment or in a
    building, never at a free point.
21. **Residents are untouched by the avatar.** Nothing in `life` or `layout`
    may read it, and a resident's plan must never depend on it. The avatar
    module reads `life`; never the other way. If a change would make a plan
    depend on the avatar, stop and ask.
22. **Inspecting is not moving.** In the viewer, clicking to look at
    something never moves the avatar; only a button that says so does.
    Hovering changes nothing at all.
23. **A wander is derived, not stepped.** Someone outside moves about the
    lot's open ground along a wander drawn from the person, the building and
    the stay. The server sends the wander; the client interpolates.
24. **Footprints are format, not decoration.** They go through the layout
    format and its invariants, so that a later generator can supply better
    ones. Whatever reads them may not assume one rectangle per lot.
25. **Colours live in the pack.** Code knows categories and workforce states,
    not which one is red. Add nothing to the map that does not carry
    information.
26. **Crowds are consequences.** Never place, spawn or steer people to make
    somewhere look busy. If a place is busy, it is because many plans led
    there, each sensible on its own. Probabilities must be ones you would
    defend for a town like this; a target is a check on the design, not a
    quota.
27. **No plan reads another plan.** Rounds, errands and strolls are derived
    from the person, the day and the town, never from where others are. A
    round has a random stream of its own.
28. **Rounds, chains and strolls are code; who does them is pack.** Code
    knows that rounds exist. Which occupations patrol, and who fetches
    water, are pack entries. The watch leaves everyone alone.

29. **Move, never make.** How a town is divided into districts, and which
    building holds which lot, may be rearranged without adding, removing or
    changing any person, household, job or building. Where a tier lives,
    which types are everyday buildings and how much housing stands near work
    are pack data: code must not know that the wealthy like the centre.

30. **Outsiders are never residents.** Travellers and vagrants are not in
    the city's people, households or counts, and a town holds exactly the
    brief's population whatever else is in it. A resident's plan must never
    read an outsider: plans are identical with outsiders computed and
    without. Outsiders live in `packages/core/src/outsiders`; of that folder
    the city generator may read only `draw.ts`, and the layout nothing.
31. **A visit is derived from its arrival day.** Who arrives on a day, and
    each party's whole visit, is a pure function of the settlement, the day
    and a seed. No list of who is in town is kept anywhere: asking about day
    40 must not need days 1 to 39. A traveller's ID says when they came. A
    party walking in from an exit is a trip like any other, and its members
    share one plan.
32. **Only the importer learns where routes lead.** A brief says for each
    route exit which settlement is next along it; the generators still read
    nothing but the brief.
33. **Vagrants are never indoors, and the watch leaves them alone.** Where
    they may sleep, and everything they do, is pack data.

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
- **Footprints** are the outlines of a lot's buildings: they lie inside the
  lot and do not overlap each other, and the rest of the lot is open ground.
- **Walls and places.** A wall is a line with gates on it, each a junction
  kept by a gatehouse; no segment crosses a wall but at a gate. A plaza is a
  place: open ground that is also the lot of its building. Only a brief
  flagged for either has one.
- **Water has its real shape.** A river may vary in width along its line
  (`widths`, with `width` the mean), and nothing may assume a bank or a
  shore is straight.
- **The summary names the generator** that made the layout, so generators can
  coexist, and carries `ringShare`: the share of street length that runs
  around or toward the centre. An undirected town scores 44%; a town of rings
  and spokes nearly 100%.
- Every length, width and density limit comes from `packs/medieval/layout.yaml`;
  the grown generator's numbers are in its `grown` block.
- **Roads, wards, buildings.** The grown generator lays the brief's routes as
  highways first and branches arterials off them; the roads cut the town's
  ground into wards, and each ward is cut in two again and again until the
  pieces are buildings. A lot is its piece. Do not derive a street's
  direction from the centre: that is what made rings.
- **Blocks are wards.** A grown layout lists its wards as blocks, each with a
  district and a `growthRank` from 0 (first built on) to 1 (last).

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
  inputs would change. Daily life has its own `LIFE_VERSION` in
  `packages/core/src/life/records.ts`, raised whenever the plans for the same
  inputs would change. Today they are 6, 8 and 5.
- **New pack fields are optional.** A pack without a field behaves as it did
  before the field existed; `packages/core/test/baselines` holds the
  fingerprints that prove it. A whole pack file may be optional too
  (`OPTIONAL_PACK_FILES`): without `travellers.yaml` a pack has no outsiders.
  `packages/core/test/pack.ts` has a function per phase that takes out of
  the pack what the phase added; tests that hold exact figures from an
  earlier phase run on the pack as it was then.
- **Invariants.** Every rule a generated city must satisfy goes in
  `packages/core/src/city/invariants.ts`, and every rule a layout must satisfy
  in `packages/core/src/layout/invariants.ts`. Each generator runs them on its
  own output; tests run them on every settlement in Lomia. Every rule a day
  plan must satisfy goes in `packages/core/src/life/invariants.ts`.
- **Game time** is a number of game seconds since the start of day 1; day
  numbers count from 1. Times of day in pack files are written `"HH:MM"`.
- **Errors name their subject.** A failure says which settlement, field or
  pack entry caused it and what to change.
- **Tests come with the code**, in the same change. The default limit for a
  test is generous and set once, in `vitest.config.ts`; a test that measures
  cost compares against the yardstick in `packages/core/test/cost.ts`, not
  against a number of seconds.
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
  list it for review as `specialties.yaml` does for ignored tags. The kinds
  of traveller and the visitors' quarter ship with neutral placeholders that
  the user will replace: do not add, name or omit entertainment types.
- **Update the README** when commands, endpoints or pack files change.

## Later phases, for orientation

Residents reacting to the avatar or to outsiders, travel between settlements, goods and
trade, lodging that fills up, encounters and conversation between residents, needs
and state that carry from day to day, a layout generator that makes
natural-looking towns, building footprints, history generated backward from
the present, persistence of changes, and LLM conversations. Do not build ahead for
these, but do not make choices that block them: records need stable IDs, and
anything a later generator derives must come from the brief, the pack and a
seed.

