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
| `packages/core` | The world format, the AFMG importer, the setting pack format, the city generator, the layout format, generator and path function, daily life (calendar, day plans, whereabouts), and the avatar (its state and the pure functions on it). Pure code: no disk, network, clock or unseeded randomness. |
| `packages/server` | SQLite storage, the pack loader, the import, generate and day commands, the world clock, the avatar's state, and the HTTP API. |
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
| `GET .../city/building-types` | The type of every building, by ID, for naming lots on the map |
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
| `GET .../life/trips?from=&to=` | Everyone who can be seen in a window of game time: the trips under way, and the stays out of doors with the part of each person's wander that falls in the window. Each comes with the person's name and the role that colours them. Optionally only those in a region (`minX`, `minY`, `maxX`, `maxY`) |
| `GET .../life/people/<id>/plan?day=` | A person's plan for a day, by default the clock's day |
| `GET .../life/people/<id>/now` | Where a person is and what they are doing |
| `GET .../life/buildings/<id>/occupants` | Who is at a building, inside or outside on its lot, whether it is open, and its hours that day |
| `GET .../life/households/<id>/now` | What each member of a household is doing |
| `GET /api/avatar` | The avatar's state: standing on a street, in a building, or walking (a path, a departure time, a speed and a destination). `null` until it is spawned |
| `POST /api/avatar/spawn` with `{"settlementId": "settlement-641", "point": [0, 0]}` | Places the avatar on the nearest street to a point of that town's map |
| `POST /api/avatar/walk-to-point` with `{"point": [120, -40]}` | Walks it to the nearest street point |
| `POST /api/avatar/walk-to-building` with `{"buildingId": "building-641-000224"}` | Walks it to that building's entrance and in |
| `POST /api/avatar/stop`, `/leave` | Stops a walk where it is; leaves a building for its entrance |
| `GET /api/avatar/perception` | Who the avatar perceives now, with who they are |
| WebSocket `/api/avatar/stream` | The avatar's state on connecting, then again after every change |
| `GET .../life/summary?day=` | A day hour by hour: people asleep, at home, at work, visiting, travelling, and out of doors |

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
sunrise, midday or sunset. Residents who are walking somewhere are moving
dots. Residents who are out of doors at a place, such as a market stall, a
yard or their own doorstep, are small squares that move about the open ground
of that lot. Everyone is coloured by role: their occupation's category, or
keeping house, or not working; the **Legend** lists the colours in use, and
the military is red so that the watch stands out. A lot is drawn as open
ground, faintly, with its building solid on it, so a house and its yard can be
told apart. The corner of the map counts walkers and those outside apart.
Clicking either kind of person opens
that person: who they are, what they are doing now, and today's plan as a
timeline, with **Follow on the map** to keep the map centred on them. Clicking
a lot also shows who is there now, whether the building is open and its hours
that day, and the household view shows what each member is doing now.

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
asleep, at home, at work, visiting, travelling and out of doors, the trips
begun, and the busiest street segments. `--day` defaults to 1; `--db` and `--pack` choose the
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
| `avatar.yaml` | The avatar's walking speed and how far it perceives |
| `display.yaml` | The colour each role is drawn in: one per workforce category, one each for keeping house and not working, and optionally single occupations |
| `rounds.yaml` | Rounds, for work done on foot: the share of a shift spent on them, how many stops and how long, how far they range, and whether a stop is a point on a street or a building of given types |
| `shifts.yaml` | Named shifts: start, end, whether worked on rest days and, if so, the share on duty. One is the default. Shifts also decide when each building is open |
| `visits.yaml` | Whether places keep opening hours (`openingHours`), and each kind of visit: who makes it, on which days and `weekdays`, how likely, when, for how long, to which building types or to `home`, and whether it is spent `outside` |
| `categories.yaml` | The seven workforce categories and their base shares |
| `modifiers.yaml` | Multipliers on category shares by size group and condition |
| `occupations.yaml` | Every job: category, workplace or employer, weight, status, specialty tags, minimum population, who may hold it (`minAge`, `maxAge`, `sexes`, `apprenticeUntil`), and its `shift`, which may be a list that splits the job across shifts by share |
| `specialties.yaml` | How specialty tags fill the trade category, and which tags are ignored |
| `workplaces.yaml` | Every workplace building type: capacity, whether the proprietor lives in, preferred district, and whether it is `openAir` or `alwaysOpen` |
| `dwellings.yaml` | Housing types by status tier |
| `landmarks.yaml` | The buildings and fixed posts that flags and status add, and the civic buildings a settlement has by its size (`minPopulation`, a count per so many residents, `spread` across the districts, posts or none), with the same `openAir` and `alwaysOpen` flags |
| `species.yaml` | Per species: households, ages (including `parentMinAge`), whose parent an elder is, workforce, multipliers, occupations of its own, and how it lives its day (`life`: walking speed by age, usual sleep hours, the personal and daily variations, and under `outside` the pace and pauses of someone moving about a lot) |
| `cultures.yaml` | Which species each culture belongs to |
| `districts.yaml` | District kinds, their size, naming patterns, and where the layout places each kind: centre, middle, edge or waterside |
| `layout.yaml` | Every length behind a town's layout: street widths, block dimensions, lot sizes by building type, how much of a lot its building covers (`footprints`), the river's width, density limits |

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

**Civic buildings.** Besides the landmarks its flags give it, a settlement
has civic buildings by its size (generator version 3): wells, one for every
250 residents, unstaffed, open-air and always open; public ovens; and above a
minimum population a bathhouse, a granary, an infirmary, a town hall, a guild
hall and an adventurers' guild hall. Wells and ovens are spread across the
districts in proportion to their residents, so every part of town has one.
Staff are fixed posts that take slots from their own category, so population,
workforce and the seven category counts did not move in any settlement, while
occupation counts inside a category did: `badanos-counts-v3.json` lists what
moved. The adventurers arrive in a later phase; for now their hall has its
staff. One guild hall stands for all trades: which trade leads a town is not
modelled.

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
| Lot | Its building, a polygon, its district, an entrance (a segment and a point on it), and its footprints: the outlines of the buildings on it |
| District area | The polygons that enclose a district's lots, and a label point |
| Summary | Counts, the bounding box, built area, residents per hectare, the layout version, the generator's name, the pack and the seed |

Its rules are checked by `layout/invariants.ts` on every layout: one lot per
building; no lot overlapping another, a roadway or water; every entrance on a
segment that borders its lot; a connected street graph; an exit within 20
degrees of each of the brief's route bearings; the river and the sea where the
brief puts them; only bridges crossing water; a port's waterside district at
the water; each district in one piece; a plausible density; and footprints
that lie inside their lot without overlapping each other, everything else in
the lot being open ground. Shapes are
general: nothing that reads a layout may assume straight streets or
rectangular lots, and the tests bend streets and use five-sided lots to hold
the viewer, the invariants and the path function to that.

**Footprints.** The grid generator draws one rectangle across each lot's
street frontage, as deep as the pack's `coverage` for the building type, and
leaves the rest as a yard. An open-air type has no footprint unless the pack
gives it one, such as a stable at the front of a stockyard. `LAYOUT_VERSION`
is 2; junctions, segments, lots and entrances are those of version 1, which a
fingerprint of all 682 settlements holds.

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

- **Work.** Everyone in the workforce works their shift on work days,
  arriving at its start give or take a personal habit (the same every day)
  and a smaller daily variation. On rest days only shifts marked as worked on
  rest days are worked, by the share the shift gives, taking turns. Someone
  whose workplace is their own home has no commute.
- **Split shifts.** An occupation can be split across several shifts by
  share, as the watch is between day and night. Within a settlement the
  shares are met exactly by the largest-remainder method; who gets which
  shift is drawn from the seed, and a worker keeps theirs every day. Those
  who share an occupation and a shift take their rest-day turns together.
- **Opening hours.** A building is open at a moment when at least one of the
  people who work there is on shift then, by the shift's own hours and
  rest-day duty. Openness never looks at anyone's plan, so it too is a pure
  function of game time and no plan depends on another. A building type
  marked `alwaysOpen` never closes. With `openingHours: true` in
  `visits.yaml`, a visit goes only to a place that is open when the visitor
  arrives and ends by closing time; if closing would cut it below its
  shortest duration the visitor tries elsewhere, and failing that stays home.
- **Visits** come from the pack: a market stop for those keeping house, a
  drink after work or in the evening, worship and the square on rest days,
  errands, the Marketday market. A destination is chosen among buildings of
  an allowed type, favouring nearer ones; with none in the settlement, the
  visit does not happen. A visit can be limited to named `weekdays`. The
  destination `home` is the person's own dwelling, reached without a walk.
- **Being outside.** A stay at work or on a visit is either inside or
  outside. It is outside when the building's type is marked `openAir` or the
  visit is marked `outside`: stallholders and yard workers, people at the
  market, children playing by their home, elders on the doorstep. An outside
  stay has a **wander**: a sequence of points on the open ground of the
  building's lot, with the game time at which the person is at each, covering
  the whole stay. Between points they move in a straight line at the pack's
  slow pace; where two times share a point they pause. Position at a time is
  interpolation, so it is still a pure function of game time. A wander is
  drawn from the person, the building and when the stay begins, by a stream
  of its own, never passes through a footprint or off the lot, and on a lot
  with no open ground is one fixed point at the frontage. A pace of zero means
  standing still. Sleep and time at home are always indoors.
- **Sleep** is at home, at the species' usual hours, moved but not shortened
  to fit the shift: the night watch sleeps by day.
- **Trips** follow the path function between two lots' entrances and take the
  path's length divided by the person's walking speed, however long that is.

The queries, all on the object `createLife({ city, layout, pack })` returns:
`plan(personId, day)`, `whereabouts(personId, time)`, `occupants(buildingId,
time)`, `trips(from, to, region?)`, `outsideStays(from, to, region?)`,
`isOpen(buildingId, time)`, `openingHours(buildingId, day)`,
`shiftOf(personId)`, `daySummary(day)` and `segmentLoads(day)`. Every rule a
plan must satisfy is in `life/invariants.ts`. Shifts, rest-day duty and
opening hours are in `life/hours.ts`.

- **Rounds.** Some work is done on foot. An occupation may name a round, and
  then part of each shift is spent on circuits that start and end at the
  workplace: out, from stop to stop, and back, with spells at the workplace
  between. A stop is a building of the round's types, or a point on a street.
  The watch patrols the whole town in three turns round the clock; carters,
  porters, pedlars, water carriers, street sweepers and servants have rounds
  too. A worker on a round is at work, and reacts to nothing. A round has a
  random stream of its own, by person and day, so it differs from day to day
  and never disturbs the rest of the plan.
- **Stops on a street.** A person may be at a point on a street with no
  building: a stop on a round, or a pause on a stroll. It is a kind of
  activity of its own, `street`, with a segment and a wander along a short
  stretch of it. A walk may begin or end at a building or at such a point.
- **Errands that chain and repeat.** A visit may list several `stops`, each
  walked to from the last before going home; a stop left out by chance or
  with nowhere open is skipped. A visit may happen several times a day
  (`timesPerDay`), each at a time of its own, dropping any that would collide
  with something else. `nearest: true` always takes the nearest place that
  will do, as for a well.
- **Strolls.** A visit may be a walk with no destination: out from home, by
  way of a public place the stroll favours if one is near enough and open,
  otherwise a point on a street about as far off as the walk allows; a pause;
  and home.
- **Out on the street.** An outside visit may be spent on the street in front
  of the building (`where: street`) instead of on its lot. Children playing
  and elders sitting out are in front of their homes, where they can be seen.

Daily life has its own `LIFE_VERSION`, now 4, in `life/records.ts`. Version 4
added rounds, chains, repeats, strolls and stops on a street; a pack with none
of those fields gives exactly the plans of version 3, which a fingerprint of
Badanos's plans holds. Version 3
added the wander and changed nothing else: a test holds a fingerprint of every
activity, building, time and trip of Badanos over eight days at version 2. A pack
with none of the phase 4.5 fields (`openingHours`, `openAir`, `alwaysOpen`,
`outside`, `weekdays`, `home`, split shifts) gives exactly the plans of
version 1; a test holds a fingerprint of Badanos's phase 4 plans to prove it.

**What phase 4.5 changed in Badanos** (default seed; day 1 is a work day, day 7
the rest day):

| Measure | Phase 4 | Phase 4.5 |
| --- | --- | --- |
| Visits arriving at a closed place, over a week | Present | 0 |
| Watchmen at work at 12:30 on a work day | 0 of 97 | 49 |
| Watchmen at work at 03:00 after a work day | 97 of 97 | 48 |
| People on a visit at 20:30 on a work day | 0 | 483, all in open taverns |
| Children outside at 15:00 on a work day | 0 | 460 |
| Anyone outside at 00:00 to 04:00 | n/a | 0 |
| People to be seen at 12:30 on a work day | 31 walking | 31 walking and 1,000 outside |
| Market visits on the rest day | 872, to closed stalls | 0: Badanos has no market square, and its stalls and shops rest |
| Trips begun on day 1 | 10,166 | 11,620 |

Most of the 1,000 outside at 12:30 are at work in the open-air yards and at
the 38 market stalls (938); the rest are at market, on errands or playing.

One thing the opening-hours rule does that may surprise: a tavern whose
keeper's household employs a day servant is open from 08:00, because the
servant works in that building and is on shift. The watch is kept in three
turns since phase 6B (06:00, 14:00 and 22:00), so a watch house with all
three is never shut.

**What phase 6B changed in Badanos** (default seed, day 1, a work day). Crowds
are consequences: nothing places anyone to make a street look busy, and no
plan reads another plan.

| Measure | Before | Target | Now |
| --- | --- | --- | --- |
| People walking at 12:30 | 31 (0.3%) | At least 2% of residents | 203 (2.1%) |
| People walking at 07:50 | 867 | Not lower | 925 |
| Median perceived from 100 seeded street points at 12:30, within 30 m | 0 | At least 1 | 1 |
| Watchmen on the streets, on the hour through 24 hours | 0 at most hours | At least 1 at each | Between 7 and 37 |
| Trips per resident per day | 1.21 | At least double | 3.71 |
| Trips begun in the day | 11,620 | n/a | 35,655 |

On the rest day there is less walking at the shift hours (26 people on average
between 07:00 and 08:00, against 343) and more in the afternoon. The busiest
well has six people at it at one moment of the morning, each of whom went to
their own nearest well. Over the hour around midday, one of the ten busiest
streets is one the market stalls open onto.

Across Lomia the midday figure follows size: on average 2.0% of residents are
walking at 12:30 in capitals and cities, 1.7% in towns and 0.9% in villages,
which have few carters, porters or watchmen. Trips per resident are 3.9.

The module reads the layout format and uses the path function, and nothing
from the layout generator.

**Who is nearby.** `nearby(point, radius, time)` returns every resident who
can be seen within a distance of a point at a moment, nearest first: those
walking between two buildings and those outside at one, never anyone indoors.
It keeps an index per day of who is walking or outside in each stretch of the
day, so a question looks only at the people who are out around then and not
at every resident. Once a day's index is built, a query takes about 0.08
milliseconds in Badanos and 0.8 to 1 in Pombal, against a target of 10;
building it means planning the day, about 0.3 seconds for Badanos and 2.7
for Pombal.

**The clock** lives in the server (`packages/server/src/clock.ts`). Its state
is a game time, a rate and whether it is running; the current game time is
computed from an anchor and the rate, and every change re-anchors, so game
time never jumps unless it is set. It is stored in the world store whenever it
is paused, re-anchored or set and on shutdown, and restored paused.

To use another pack, copy the folder, edit it, and point `WORLDSIM_PACK` or
`--pack` at the copy.

## The avatar

`packages/core/src/avatar` is the user's presence in a town. **The avatar is
never stepped**, like everyone else: its state is a resting place or a trip,
and its position at any game time is arithmetic on that state. So pausing,
changing the rate and jumping the clock, forward or back, work for it as they
do for residents.

| Condition | What is recorded |
| --- | --- |
| Standing on a street | The segment and the point on it |
| In a building | The building |
| Walking | The path, the game time of departure, the speed, and what it is heading for: a street point, or a building |

- **One avatar per world**, absent until first spawned, and in one settlement.
  Moving to another town is a fresh spawn.
- **It walks the graph.** It is always on a segment or in a building. The path
  function joins any two positions on the street graph, a segment and a point
  each, with a lot as the special case of its entrance; the two may be on the
  same segment. Spawning and walking to a point take the nearest point of the
  nearest segment.
- **Actions** each take the game time and return a new state: spawn, walk to a
  street point, walk to a building, stop, leave. A walk ordered during a walk,
  or a stop, starts from the position at that moment. A walk from inside a
  building begins at its door. An action that makes no sense, such as leaving
  while on a street, is refused with the reason (HTTP 409).
- **A walk that has reached its arrival time counts as arrived**: standing at
  the street point, or in the building. Nothing rewrites the state when that
  happens; the stored walk simply reads as arrived from then on.
- **Perception.** On a street the avatar perceives the residents walking or
  outside within the pack's radius, by the nearby query. In a building it
  perceives everyone at that building, inside or outside on its lot. People
  indoors are not perceived from the street, nor the street from indoors.
- **Residents do not react.** Nothing in `life` reads the avatar, and a test
  holds that plans are byte-identical with and without one.
- **It is stored.** The avatar is the first thing in the world the user
  decides, so it cannot be derived from a seed. With the clock it is the only
  stored state that is not imported. It is written whenever it changes,
  restored on start, and cleared when a world is imported again.

**Reading the map.** Moving the cursor onto a person draws a box round them
with their name and occupation; onto a lot, its outline and its building's
name; onto the avatar, "You". The nearest person within a generous reach
wins. Hovering an entry in the around-you panel or a household row marks that
person on the map if they can be seen, and hovering someone on the map lights
their entry. Hovering never selects or moves anything. Every pane folds away
to one line from its header (the summary, the household list, the details,
the legend, around you, the clock, and the settlement panel beside the world
map), the map takes the room, each pane's state is remembered across reloads,
and **Fold all** folds or unfolds them all.

**In the viewer.** **Spawn** in the map's tools, then a click, places the
avatar on the nearest street; so does **Spawn here** after clicking open
ground or a street. The avatar is a blue dot with a circle showing how far it
perceives, or a white dot on a lot when it is indoors. Clicking a lot inspects
it as before and, with the avatar in town, offers **Walk into this building**
beside the click; clicking a street or open ground offers **Walk here**.
Nothing but those buttons moves the avatar. The **Around you** panel says what
the avatar is doing, offers **Stop** or **Leave**, and lists who it perceives,
nearest first, with age, occupation and what they are doing; each name opens
the person panel, and the people listed are ringed on the map. **Follow on the
map** keeps the map centred on the avatar at a zoom where a street fills the
view. A person's panel offers **Walk to them**, **Walk to their home** and
**Walk to their workplace**, and a building's panel **Walk here**.

## Tests

```sh
npm test            # every test in every package
npm run typecheck   # strict TypeScript across packages and tests
npm run check       # both
npm run test:viewer # the viewer in a headless browser
```

`npm run test:viewer` starts a server and the viewer on ports of their own,
imports Lomia into a temporary world file, and drives the real viewer in
headless Chromium: panes, the hover marker, colour by role, the legend, people
moving about outside, and the frame rate. It needs a browser, which
`npx playwright install chromium` fetches once, so it is not part of
`npm run check`. The town map reports what it last drew through
`window.worldsim.map()`, which is what these tests read.

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
`clock.test.ts` and `life-api.test.ts`; phase 4.5's are in
`life-places.test.ts` (split shifts, opening hours, being outside, home
visits, weekdays and pack behaviour) and `baselines/badanos-phase4-plans.json`;
phase 5's are in `avatar.test.ts` in each package (paths between street
positions, the avatar's actions, perception and its cost; the client's
arithmetic and wording), `avatar-api.test.ts` (storage, endpoints, notices) and
`baselines/badanos-lot-paths.json`; phase 6B's are in `civic.test.ts` (civic
buildings in every settlement), `rounds.test.ts` (rounds, chains, repeats,
strolls, the targets, emergence and pack behaviour), `baseline.test.ts` with
`baselines/badanos-counts-v3.json` (the new baseline and what moved) and
`baselines/badanos-life-v3.json`; phase 6A's are in `wander.test.ts`
(moving about outside), `layout.test.ts` and `lomia-cities.test.ts`
(footprints), `baselines/layout-v1.json` and `baselines/badanos-life-v2.json`
(what must not have moved), and `packages/client/e2e/viewer.e2e.ts` (the
viewer).

The whole-world run generates all 682 settlements of Lomia, 2,935,089 people,
and checks every invariant on each. With generator version 3 it takes about 9
seconds on one core of an Intel Core Ultra 7 265K; generation alone, which
includes the generator's own check, is about 7.5 seconds, and Pombal, the
largest settlement at 47,603 people, takes about 0.13 seconds.

Laying out all 682 settlements, now 541,392 lots with the civic buildings, takes about 5 seconds more,
again including the generator's own check of every layout invariant, which
now includes the footprints. No settlement takes longer than 0.1 seconds;
Pombal's 8,413 lots take about that.

Planning one day for all 9,607 residents of Badanos takes about 0.5 seconds.
It was 0.12 before phase 4.5 added some 4,800 visits a day and the
opening-hours checks, 0.2 before phase 6A added the wanders, and 0.3 before
phase 6B tripled the trips: 1.7 times slower for three times the walking.
Pombal's 47,603 residents take about 4 seconds for the first day (it was
2.7), which includes preparing the path tables for its layout, and about 1.6
seconds for each day after (it was 0.9). Planning one day for every one of
Lomia's 2,935,089 residents takes about 115 seconds (it was 69), and every
plan in all 682 settlements passes every plan rule.

Cost tests do not hold the planner to a number of seconds, which fails on a
slow or busy machine: they time a fixed piece of arithmetic alongside the
work (`packages/core/test/cost.ts`) and limit the work to a few times that.
Badanos's day is about 1.7 of these yardsticks, and the limit is 6.

The town map draws about 60 frames a second in headless Chromium for both
Badanos at midday (1,044 people, about 0.4 milliseconds a frame) and Pombal
(5,360 people, about 1.5 milliseconds a frame), against a target of 30.
Headless Chromium draws no faster than 60.

At 03:00 at least 95% of residents are asleep at home in every one of the 682
settlements, the forts included, now that the night watch is a third of the
watch and not half. The test checks Badanos and Vereceldo.
