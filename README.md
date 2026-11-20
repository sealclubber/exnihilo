# World Sim

A persistent world explored from a world map down to a street. This repository
holds the first four phases:

1. An importer that turns an Azgaar's Fantasy Map Generator (AFMG) export into
   our own world format, a server that stores and serves it, and a browser
   viewer with a map and a brief for every settlement.
2. The first half of the city generator: from a settlement brief to every
   resident, household, building and district of that settlement, as linked
   records with no geometry, browsable from the command line and the viewer.

3. A city's first geometry: a street graph, the water, and a lot for every
   building, laid out simply and shown as a town map with walking paths.

4. Daily life: every resident has a plan for every day and a position at every
   moment, shown on the town map under a clock that can be sped up, slowed,
   paused and set.

The briefs for this work are [worldsim-phase1-gameplan.md](worldsim-phase1-gameplan.md),
[worldsim-phase2-gameplan.md](worldsim-phase2-gameplan.md),
[worldsim-phase2_5-gameplan.md](worldsim-phase2_5-gameplan.md) (a patch that makes
households, working ages and workplaces hang together),
[worldsim-phase3-gameplan.md](worldsim-phase3-gameplan.md) and
[worldsim-phase4-gameplan.md](worldsim-phase4-gameplan.md).

## Layout

| Path | Holds |
| --- | --- |
| `packages/core` | The world format, the AFMG importer, the setting pack format, the city generator, the layout format, generator and path function, and daily life (calendar, day plans, whereabouts). Pure code: no disk, network, clock or unseeded randomness. |
| `packages/server` | SQLite storage, the pack loader, the import, generate and day commands, the world clock, and the HTTP API. |
| `packages/client` | The browser viewer, city inspector and living town map. Uses `core` for types only. |
| `packs/medieval` | The first setting pack: every occupation, building and number the generator uses. |
| `fixtures/afmg` | The Lomia export, used by the tests. |

Only `packages/core/src/afmg` knows AFMG's structure. The city generator takes
a settlement brief, a setting pack and a seed, and reads nothing else.

## Install

Needs Node.js 24 or newer (developed on 26 LTS). TypeScript is run directly by
Node, so there is no build step for the server.

```sh
npm install
```

## Import Lomia

```sh
npm run import -- fixtures/afmg/lomia.json
```

This writes the world to `data/world.sqlite` and prints the import report:
what was imported, any warnings, and the parts of the export that were not
read. Importing again replaces the stored world. To store it elsewhere, add
`--db path/to/world.sqlite` or set `WORLDSIM_DB`.

A world imported before phase 2 must be imported again: briefs now carry their
culture's name base. The server says so if it finds an old file.

## Start the server

```sh
npm run server
```

The API listens on port 3001 on every network interface. Set `PORT`, `HOST`,
`WORLDSIM_DB` or `WORLDSIM_PACK` (the setting pack folder) to change that.
The server starts with the world clock paused where it was last left; stop it
with Ctrl-C so the clock is stored on the way out.

| Request | Returns |
| --- | --- |
| `GET /api/world` | The world summary: name, year, era, map size, entity counts |
| `GET /api/map` | The map geometry: cells, states, rivers, routes, settlement markers |
| `GET /api/settlements` | The list of settlements |
| `GET /api/settlements/settlement-641` | One settlement's brief |
| `GET /api/pack` | Display names for the setting pack's occupations, buildings, districts and tiers |
| `GET /api/settlements/settlement-641/city` | The generated city's summary |
| `GET .../city/people` | Its people, in pages |
| `GET .../city/households` | Its households, in pages |
| `GET .../city/buildings` | Its buildings, in pages |
| `GET .../city/districts` | Its districts, in pages |
| `GET .../city/households/<id>` | One household with its members and its home |
| `GET .../city/buildings/<id>` | One building with the people who work and live there |
| `GET /api/settlements/settlement-641/layout` | The town's layout: junctions, segments, exits, water, lots, district areas and a summary |
| `GET .../layout/path?from=<lot>&to=<lot>` | The shortest walking path between two lots: the segments in order, the length in metres, and the line walked |

**The clock and daily life**

| Request | Returns |
| --- | --- |
| `GET /api/clock` | The world clock: game time, rate, whether it is running, and the rates on offer |
| `POST /api/clock/run`, `/pause` | Starts or stops the clock |
| `POST /api/clock/rate` with `{"rate": 30}` | Sets the rate, in game seconds per real second, to one of the pack's presets |
| `POST /api/clock/time` with `{"gameTime": 86400}` | Sets the game time, forward or back |
| WebSocket `/api/clock/stream` | The clock's state on connecting, then again after every change |
| `GET .../life/trips?from=&to=` | The trips under way in a window of game time, optionally only those through a region (`minX`, `minY`, `maxX`, `maxY`) |
| `GET .../life/people/<id>/plan?day=` | A person's plan for a day, by default the clock's day |
| `GET .../life/people/<id>/now` | Where a person is and what they are doing |
| `GET .../life/buildings/<id>/occupants` | Who is inside a building |
| `GET .../life/households/<id>/now` | What each member of a household is doing |
| `GET .../life/summary?day=` | A day hour by hour: people asleep, at home, at work, visiting and travelling |

"Now" is the clock's game time unless the request gives `time=`. The server
sends trips, not positions: the viewer moves each dot along its trip's line by
the clock, so motion is smooth at any rate. Viewers learn of clock changes
over the WebSocket.

Paged lists take `offset` and `limit` (50 by default, 500 at most) and answer
with `total`, `offset`, `limit` and `items`. They can be filtered:

| List | Filters |
| --- | --- |
| people | `district`, `occupation`, `category`, `household`, `workplace`, `q` (name) |
| households | `district`, `occupation`, `category`, `status`, `q` (family or member name) |
| buildings | `district`, `occupation`, `category`, `kind`, `type` |

A city is generated the first time it is asked for and the last few are kept
in memory, each with its layout and its daily life once those have been asked
for. Nothing generated is written to the world store: the clock is the only
state kept there besides the imported world.

## Open the viewer

In a second terminal on the same machine as the server:

```sh
npm run client
```

Then open `http://<that machine>:5173` in a browser, which may be on another
machine. Drag to pan, scroll to zoom, and click a settlement to see its brief.
Badanos is at `http://<that machine>:5173/#settlement-641`.

**Open city** in the settlement panel leads to the city inspector, also
reachable directly at `#settlement-641/city`. It shows the summary as counts
and bars, the districts, a searchable list of households, and one household at
a time with its members, their ages, kinship (partner of, child of, parent
of), occupations and workplaces, its home, and the people it employs there.
Clicking a category, occupation, status or district filters the households;
under a category or occupation filter each row shows the member who matched.
Clicking a workplace shows who works there, and a servant's workplace leads to
the household that employs them.

Beside the lists is the **town map**: the water, the streets drawn by kind,
and every building's lot coloured by district, with the exits labelled by
their route and a scale bar in metres. Drag to pan and scroll to zoom.
Clicking a lot shows its building; choosing a household or a building in the
lists outlines its lot. **Path** shows the shortest walking path between two
lots you pick, with its length.

**The living town.** Above the map is the world clock: the day's name, whether
it is a rest day, and the time, with the map darkened at night. **Run** and
**Pause** start and stop it; the rate buttons set how fast game time passes
(1× is real time, 30× is a game day in 48 real minutes, 3,600× a game day in
24 real seconds); **Morning**, **Midday** and **Evening** jump to the next
sunrise, midday or sunset. Residents out on the streets are moving dots, with
a count of how many there are. Clicking a dot opens that person: who they are,
what they are doing now, and today's plan as a timeline, with **Follow on the
map** to keep the map centred on them. Clicking a lot also shows who is inside
now, and the household view shows what each member is doing now.

The viewer looks for the API on port 3001 of the host it was loaded from. If
the server is somewhere else, say where when starting the viewer:

```sh
VITE_API_URL=http://192.168.1.20:3001 npm run client
```

The viewer's development server answers requests made to `localhost` or an IP
address. To reach it by a host name, list that name in `server.allowedHosts`
in `packages/client/vite.config.ts`.

## Generate a city from the command line

```sh
npm run generate -- settlement-641
```

This generates Badanos from the stored world and the pack, prints a text
summary, and writes two files to `data/cities/settlement-641/`:

| File | Holds |
| --- | --- |
| `city.json` | Every person (with kinship, occupation, apprenticeship, workplace and employer), household, building and district, one record per line, plus the summary |
| `summary.txt` | The printed summary: totals, workforce, categories, occupations, status tiers, districts, buildings by type |

Options: `--seed <number>` replaces the settlement's own seed, `--out <folder>`
changes where the files go, `--db` and `--pack` choose the world file and the
pack. The same brief, pack and seed always give the same bytes.

## Print a settlement's day

```sh
npm run day -- settlement-641 --day 2
```

This prints the day as text: for each hour the average number of people
asleep, at home, at work, visiting and travelling, the trips begun, and the
busiest street segments. `--day` defaults to 1; `--db` and `--pack` choose the
world file and the pack. Nothing is stored.

## The setting pack

Everything setting-specific lives in `packs/medieval`, as hand-editable YAML.
The generator code names no occupation or building and holds none of the
numbers.

| File | Holds |
| --- | --- |
| `pack.yaml` | The pack's name and version, the status tiers, the apprentice age and label, and a few household settings |
| `calendar.yaml` | The days of the week and which are rest days, the days in a year, sunrise and sunset |
| `time.yaml` | The clock's rate presets and the default rate |
| `shifts.yaml` | Named shifts: start, end, whether worked on rest days and, if so, the share on duty. One is the default |
| `visits.yaml` | Each kind of visit: who makes it, on which days, how likely, when, for how long, and to which building types |
| `categories.yaml` | The seven workforce categories and their base shares |
| `modifiers.yaml` | Multipliers on category shares by size group and condition |
| `occupations.yaml` | Every job: category, workplace or employer, weight, status, specialty tags, minimum population, who may hold it (`minAge`, `maxAge`, `sexes`, `apprenticeUntil`), and its `shift` |
| `specialties.yaml` | How specialty tags fill the trade category, and which tags are ignored |
| `workplaces.yaml` | Every workplace building type: capacity, whether the proprietor lives in, preferred district |
| `dwellings.yaml` | Housing types by status tier |
| `landmarks.yaml` | The buildings and fixed posts that flags and status add |
| `species.yaml` | Per species: households, ages (including `parentMinAge`), whose parent an elder is, workforce, multipliers, occupations of its own, and how it lives its day (`life`: walking speed by age, usual sleep hours, the personal and daily variations) |
| `cultures.yaml` | Which species each culture belongs to |
| `districts.yaml` | District kinds, their size, naming patterns, and where the layout places each kind: centre, middle, edge or waterside |
| `layout.yaml` | Every length behind a town's layout: street widths, block dimensions, lot sizes by building type, the river's width, density limits |

Each file starts with a comment describing its fields. All the numbers are
placeholders meant to be tuned by eye:

1. Edit a file.
2. Run `npm run generate -- settlement-641` to see the effect at once, or
   restart the server and reload the inspector. The server reads the pack only
   when it starts.

A pack is checked when it is loaded. A mistake, such as an occupation naming a
workplace that does not exist or shares that add up to zero, stops the load
with a message naming the file and the entry; every problem found is listed.
The generator also checks its own output and fails loudly rather than return a
city that breaks a rule, for instance a workforce outside 35% to 60% of the
population.

Who may hold which job is the pack's decision. An occupation's `minAge`,
`maxAge` and `sexes` limit who can hold it, and `apprenticeUntil` says below
what age a holder is an apprentice; the code supplies no age of its own. The
limits change who gets a job, never how many of it there are. If they cannot
all be met, generation stops with a message naming the settlement, the
occupations and the shortfall. In the `medieval` pack the ages are placeholders
listed for review at the top of `occupations.yaml`, and no occupation sets
`sexes`.

An occupation has either a `workplace` or an `employer`. With `employer`, the
worker is attached to a household of one of the listed status tiers and works
in its home; `servant` is the one such occupation in the `medieval` pack.

One tag is ignored by the `medieval` pack and listed for review at the top of
`specialties.yaml`: `slaves`.

## The layout

A layout gives a generated city its geometry. It is made by a pure function in
`packages/core/src/layout` from the city, its brief, the pack and a seed, and
never changes the city.

**The format** (`layout/records.ts`) is what everything else depends on, and
is meant to outlive the generator. Coordinates are metres from the town
centre, x east and y south.

| Record | Holds |
| --- | --- |
| Junction | A position and a kind: crossing, dead end, bridge end or exit |
| Segment | The two junctions it joins, a polyline, a kind (arterial, street, lane or bridge), a width, and the route it carries if any |
| Exit | The junction where one of the brief's routes leaves town, with the route's ID, name, kind and bearing |
| Water | A river as a centre line with a width, or the sea as a polygon |
| Lot | Its building, a polygon, its district, and an entrance: a segment and a point on it |
| District area | The polygons that enclose a district's lots, and a label point |
| Summary | Counts, the bounding box, built area, residents per hectare, the layout version, the generator's name, the pack and the seed |

Its rules are checked by `layout/invariants.ts` on every layout: one lot per
building; no lot overlapping another, a roadway or water; every entrance on a
segment that borders its lot; a connected street graph; an exit within 20
degrees of each of the brief's route bearings; the river and the sea where the
brief puts them; only bridges crossing water; a port's waterside district at
the water; each district in one piece; and a plausible density. Shapes are
general: nothing that reads a layout may assume straight streets or
rectangular lots, and the tests bend streets and use five-sided lots to hold
the viewer, the invariants and the path function to that.

**The generator** (`layout/grid.ts`, named `grid` in a layout's summary) is
deliberately regular: a street grid around the centre, a river bending beside
it, districts grown block by block from the centre outward, an arterial from
the centre to each exit, and bridges where streets meet the river. A later
generator can replace it without touching anything that reads a layout.

**Paths.** `shortestPath(layout, fromLotId, toLotId)` returns the segments
walked in order, the length in metres from entrance to entrance, and the line
walked. `createPathFinder(layout)` does the same for many queries.

## Daily life

`packages/core/src/life` gives every resident a plan for every day and a
position at every moment. It rests on one idea: **a resident's whereabouts
are a pure function of game time. Nothing is stepped forward tick by tick.**

- **Game time** is a number of game seconds since the start of day 1. A day is
  24 hours. `core` never reads a clock; game time is always an argument.
- **A day plan** is an ordered list of activities that covers one person's day
  from midnight to midnight: sleep, at home, work, visit and travel. It is
  derived from the person, the day number, the city, the layout, the pack and
  a seed, with a random stream of its own per person and day, so it never
  depends on which other plans were computed or in what order.
- **A trip** is a path, a departure time and a walking speed, so the position
  at any moment during it is arithmetic.

So `where is this person at time t` has one answer, computed on demand, for
any `t`. The clock's rate does not matter to the simulation: a game day can
take 24 real hours or a few seconds, and the clock can be paused or set to any
time, forward or back, without anything going wrong.

**How a plan is made.** Each person has a *personal day* that runs from the
middle of one sleep to the middle of the next, placed so that it holds their
whole shift even when the shift crosses midnight. Within it they sleep, wake,
perhaps go to work, perhaps make a visit or two, come home and sleep. A
personal day depends only on the person and its number and always begins and
ends asleep at home, so days join without a seam; a calendar day's plan is the
midnight-to-midnight slice across the personal days that overlap it.

- **Work.** Everyone in the workforce works their occupation's shift on work
  days, arriving at its start give or take a personal habit (the same every
  day) and a smaller daily variation. On rest days only shifts marked as
  worked on rest days are worked, by the share of each occupation the shift
  gives, taking turns. Someone whose workplace is their own home has no
  commute.
- **Visits** come from the pack: a market stop for those keeping house, a
  drink after work, worship on rest days, errands. A destination is chosen
  among buildings of an allowed type, favouring nearer ones; with none in the
  settlement, the visit does not happen.
- **Sleep** is at home, at the species' usual hours, moved but not shortened
  to fit the shift: the night watch sleeps by day.
- **Trips** follow the path function between two lots' entrances and take the
  path's length divided by the person's walking speed, however long that is.

The queries, all on the object `createLife({ city, layout, pack })` returns:
`plan(personId, day)`, `whereabouts(personId, time)`, `occupants(buildingId,
time)`, `trips(from, to, region?)`, `daySummary(day)` and `segmentLoads(day)`.
Every rule a plan must satisfy is in `life/invariants.ts`.

The module reads the layout format and uses the path function, and nothing
from the layout generator.

**The clock** lives in the server (`packages/server/src/clock.ts`). Its state
is a game time, a rate and whether it is running; the current game time is
computed from an anchor and the rate, and every change re-anchors, so game
time never jumps unless it is set. It is stored in the world store whenever it
is paused, re-anchored or set and on shutdown, and restored paused.

To use another pack, copy the folder, edit it, and point `WORLDSIM_PACK` or
`--pack` at the copy.

## Tests

```sh
npm test            # every test in every package
npm run typecheck   # strict TypeScript across packages and tests
npm run check       # both
```

The acceptance tests of every gameplan run against the Lomia fixture. Phase 1's
are in `packages/core/test/importer.test.ts`; phase 2's are in
`packages/core/test/city.test.ts` (single settlements, determinism, species,
pack edits), `pack.test.ts` (the pack and its validation) and
`lomia-cities.test.ts` (every settlement); phase 2.5's are in
`coherence.test.ts` (parent ages, kinship, eligibility, shared workplaces,
employer households) and `baseline.test.ts` (counts that must not move);
phase 3's are in `layout-invariants.test.ts` (the format's rules, on layouts
built by hand), `layout-geometry.test.ts`, `layout.test.ts` (the generator and
the path function on single settlements) and `lomia-cities.test.ts`; phase 4's
are in `calendar.test.ts`, `life.test.ts` (plans, whereabouts, behaviour,
determinism, pack edits and cost) and, in the server and client packages,
`clock.test.ts` and `life-api.test.ts`.

The whole-world run generates all 682 settlements of Lomia, 2,935,089 people,
and checks every invariant on each. With generator version 2 it takes about 9
seconds on one core of an Intel Core Ultra 7 265K; generation alone, which
includes the generator's own check, is about 7.5 seconds, and Pombal, the
largest settlement at 47,603 people, takes about 0.13 seconds.

Laying out all 682 settlements, 526,006 lots, takes about 5 seconds more,
again including the generator's own check of every layout invariant. No
settlement takes longer than 0.1 seconds; Pombal's 8,413 lots take about that.

Planning one day for all 9,607 residents of Badanos takes about 0.12 seconds,
against a target of 3. Pombal's 47,603 residents take about 1.1 seconds for
the first day, which includes preparing the path tables for its layout, and
about 0.3 seconds for each day after. Planning one day for every one of
Lomia's 2,935,089 residents takes about 28 seconds.

One of the gameplan's behaviour thresholds does not hold everywhere. At 03:00
at least 95% of residents are asleep at home in 666 of the 682 settlements,
Badanos and Vereceldo among them; in the 16 forts the figure is about 90%,
because the night watch, which is at work then, is a tenth of a fort's
people. The test checks Badanos and Vereceldo.
