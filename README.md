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
[worldsim-phase4-gameplan.md](worldsim-phase4-gameplan.md). Later phases each
have a gameplan of their own beside these; the latest is
[worldsim-phase6c-gameplan.md](worldsim-phase6c-gameplan.md), which brings to
town people who do not live there.

## Layout

| Path | Holds |
| --- | --- |
| `packages/core` | The world format, the AFMG importer, the setting pack format, the city generator, the layout format, generator and path function, daily life (calendar, day plans, whereabouts), outsiders (a town's draw, travellers and vagrants), and the avatar (its state and the pure functions on it). Pure code: no disk, network, clock or unseeded randomness. |
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

A world imported before phase 6C must be imported again: briefs now say where
each of their routes leads, and travellers are told apart by where they came
from. The server says so if it finds an old file.

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
| `GET /api/settlements/settlement-641` | One settlement's brief, which says for each route exit the settlement it leads to |
| `GET /api/settlements/settlement-641/draw` | The settlement's draw with its breakdown by term, the travellers its rules expect in a day, and whether it has a visitors' quarter |
| `GET /api/pack` | Display names for the setting pack's occupations, buildings, districts and tiers |
| `GET /api/settlements/settlement-641/city` | The generated city's summary |
| `GET .../city/people` | Its people, in pages |
| `GET .../city/households` | Its households, in pages |
| `GET .../city/buildings` | Its buildings, in pages |
| `GET .../city/districts` | Its districts, in pages |
| `GET .../city/households/<id>` | One household with its members and its home |
| `GET .../city/buildings/<id>` | One building with the people who work and live there |
| `GET .../city/building-types` | The type of every building, by ID, for naming lots on the map |
| `GET /api/settlements/settlement-641/layout` | The town's layout: junctions, segments, exits, water, lots, district areas, walls, places and a summary. `?generator=grid` or `?generator=staged` gives the named generator's layout of the same town, made for the request, kept nowhere and sent unchecked against the invariants |
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
| `GET .../life/buildings/<id>/occupants` | Who is at a building, inside or outside on its lot, whether it is open, and its hours that day; and its `guests`, the travellers who lodge there that day |
| `GET .../life/outsiders?day=` | The outsiders in town on a day, by default the clock's: the travellers, with counts by kind, and the vagrants |
| `GET .../life/outsiders/<id>` | One outsider: who they are, their party, where they are now, and the day's plan |
| `GET .../life/households/<id>/now` | What each member of a household is doing |
| `GET /api/avatar` | The avatar's state: standing on a street, in a building, or walking (a path, a departure time, a speed and a destination). `null` until it is spawned |
| `POST /api/avatar/spawn` with `{"settlementId": "settlement-641", "point": [0, 0]}` | Places the avatar on the nearest street to a point of that town's map |
| `POST /api/avatar/walk-to-point` with `{"point": [120, -40]}` | Walks it to the nearest street point |
| `POST /api/avatar/walk-to-building` with `{"buildingId": "building-641-000224"}` | Walks it to that building's entrance and in |
| `POST /api/avatar/stop`, `/leave` | Stops a walk where it is; leaves a building for its entrance |
| `GET /api/avatar/perception` | Who the avatar perceives now, with who they are |
| WebSocket `/api/avatar/stream` | The avatar's state on connecting, then again after every change |
| `GET .../life/summary?day=` | A day hour by hour: people asleep, at home, at work, visiting, travelling, and out of doors; and the outsiders in town, counted apart |

Every answer about daily life includes outsiders beside residents, each
marked `outsider`; a person's plan and whereabouts can be asked for by an
outsider's ID as by a resident's.

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
their route and a scale bar in metres. A river is drawn at its true width
from place to place, a wall as a dark line open at each gate with a ring on
the gate, and a plaza as pale paved ground. The summary's **Town** section
names the generator that laid the town out, the wall's gates and the plaza's
area. Adding `?generator=staged` (or `grid`) before the `#` shows that
generator's layout of the same town for comparison, without people: they walk the pack's layout, which
is not the one on screen. Drag to pan and scroll to zoom.
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
begun, and the busiest street segments; then the outsiders in town, by kind
and hour by hour. `--day` defaults to 1; `--db` and `--pack` choose the
world file and the pack. Nothing is stored.

## The setting pack

Everything setting-specific lives in `packs/medieval`, as hand-editable YAML.
The generator code names no occupation or building and holds none of the
numbers.

| File | Holds |
| --- | --- |
| `pack.yaml` | The pack's name and version, the status tiers, the apprentice age and label, and a few household settings; and the name for a building that is both a home and a workplace (`homeAndWorkLabel`) |
| `calendar.yaml` | The days of the week and which are rest days, the days in a year, sunrise and sunset |
| `time.yaml` | The clock's rate presets and the default rate |
| `avatar.yaml` | The avatar's walking speed and how far it perceives |
| `display.yaml` | The colour each role is drawn in: one per workforce category, one each for keeping house and not working, and optionally single occupations; and one for each kind of traveller and one for vagrants |
| `travellers.yaml` | Optional. A settlement's draw (a weight per flag and status, a term for population, a term for specialties, a floor); what outsiders do in town (`visits`); the kinds of traveller (how many arrive and what that depends on, party size, nights, hours, lodging, how they leave, their visits); and vagrants (their share, where they sleep, what they do). Without the file a pack has no outsiders |
| `rounds.yaml` | Rounds, for work done on foot: the share of a shift spent on them, how many stops and how long, how far they range, and whether a stop is a point on a street or a building of given types |
| `shifts.yaml` | Named shifts: start, end, whether worked on rest days and, if so, the share on duty. One is the default. Shifts also decide when each building is open |
| `visits.yaml` | Whether places keep opening hours (`openingHours`), and each kind of visit: who makes it, on which days and `weekdays`, how likely, when, for how long, to which building types or to `home`, and whether it is spent `outside` |
| `categories.yaml` | The seven workforce categories and their base shares |
| `modifiers.yaml` | Multipliers on category shares by size group and condition |
| `occupations.yaml` | Every job: category, workplace or employer, weight, status, specialty tags, minimum population, who may hold it (`minAge`, `maxAge`, `sexes`, `apprenticeUntil`), and its `shift`, which may be a list that splits the job across shifts by share |
| `specialties.yaml` | How specialty tags fill the trade category, and which tags are ignored |
| `workplaces.yaml` | Every workplace building type: capacity, whether the proprietor lives in, preferred district, and whether it is `openAir` or `alwaysOpen`, and whether it is `spread` across the districts as an everyday building |
| `dwellings.yaml` | Housing types by status tier |
| `landmarks.yaml` | The buildings and fixed posts that flags and status add, and the civic buildings a settlement has by its size (`minPopulation`, a count per so many residents, `spread` across the districts, posts or none), with the same `openAir` and `alwaysOpen` flags; inns, counted by the travellers expected in a day (`perTravellers`), whose keeper's household lives in (`proprietorLivesIn`) |
| `species.yaml` | Per species: households, ages (including `parentMinAge`), whose parent an elder is, workforce, multipliers, occupations of its own, and how it lives its day (`life`: walking speed by age, usual sleep hours, the personal and daily variations, and under `outside` the pace and pauses of someone moving about a lot) |
| `cultures.yaml` | Which species each culture belongs to |
| `districts.yaml` | District kinds, their size, naming patterns, and where the layout places each kind: centre, middle, edge or waterside; where each status tier prefers to live (`tierDistricts`); and the share of housing that stands near work (`housingNearWork`); a kind may be created by a settlement's draw (`whenDraw`) and lists the building `types` that belong to it |
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

**How a town is divided.** Since generator version 4 a town's districts are
mixed. Nothing is created or removed by any of this: only the district a
building stands in changes, and every household keeps its building.

- **Everyday buildings in every district.** A workplace type marked `spread`
  (tavern, bakery, butchery, shop, chapel, healer's house) is shared out
  among the districts in proportion to their residents, as wells are. A
  household that lives in one moves with it; within a type the better-off
  households' buildings go to the better-off districts. A type that is not
  spread keeps the kind of district it prefers: tanneries stay on the
  outskirts, and the craft quarter is still the craft quarter.
- **Where each tier lives.** `tierDistricts` gives each status tier the kinds
  of district it prefers, in order; a dwelling goes to the first entry the
  settlement has, and an entry may be several kinds ranked alike. The wealthy
  and the noble prefer an upper quarter and then the centre, and are never
  put in a lower quarter or the outskirts.
- **Housing near work.** A share of dwellings (`housingNearWork`) stands in
  the district where the head of the household works, instead of where the
  tier prefers. A kind of district may have a share of its own, and 0 closes
  it. A household is never moved to a kind its tier does not list.

**Badanos, before and after** (default seed):

| District | Residents | People working there | Taverns | Bakeries | Shops | Chapels | Mansions and noble houses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bank Market (centre) | 1,825 → 1,751 | 717 → 567 | 13 → 5 | 0 → 4 | 30 → 10 | 13 → 4 | 0 → 5 |
| Old Market (centre) | 1,809 → 1,747 | 736 → 567 | 15 → 5 | 0 → 4 | 29 → 11 | 13 → 5 | 0 → 5 |
| Mill Row (craft) | 1,245 → 1,621 | 1,160 → 1,178 | 0 → 5 | 24 → 4 | 0 → 10 | 0 → 4 | 0 |
| Ford Street (common) | 2,164 → 1,863 | 58 → 188 | 0 → 5 | 0 → 5 | 0 → 11 | 0 → 5 | 0 |
| Ford Bottoms (lower) | 1,941 → 1,732 | 151 → 250 | 0 → 5 | 0 → 4 | 0 → 11 | 0 → 5 | 10 → 0 |
| Upper Fields (outskirts) | 623 → 893 | 1,597 → 1,669 | 0 → 3 | 0 → 3 | 0 → 6 | 0 → 3 | 0 |

| Measure | Before | Required | Now |
| --- | --- | --- | --- |
| Districts lacking a tavern, bakery, shop or chapel | 6 of 6 lack at least one | 0 | 0 |
| Mansions and noble houses in Ford Bottoms | 10 | 0 | 0 |
| Jobs in Ford Street | 58 | Higher | 188 |
| Workers living in the district they work in | 30.3% | Higher | 35.4% |
| Average walk to work | 670 m | Report | 664 m |
| Forges and leather shops in the craft quarter | 221 of 221 | The large majority | 221 of 221 |
| Tanneries outside the outskirts | 0 | 0 | 0 |
| Working buildings beside one of their own type | 28% | At least 70% (an estimate) | 65% |
| Buildings that changed district | n/a | n/a | 909 of 1,829 |

Two of phase 6B's five targets sit on their line after this change, as mixed
districts make walks shorter and gathered trades put people closer together.
Walking at 12:30 is 207 on day 1 and between 199 and 207 across the six work
days (2.1%), where it was 203. From 100 seeded street points at 12:30, 46%
perceive someone and the median is 0, where it was about half and a median of
1; the mean is unchanged at 1.9. The morning peak (910 at 07:50), the watch
(at least 11 on the streets at every hour) and trips per resident (3.65) are
met as before.

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
| Junction | A position and a kind: crossing, dead end, bridge end, exit or gate |
| Segment | The two junctions it joins, a polyline, a kind (arterial, street, lane or bridge), a width, and the route it carries if any |
| Exit | The junction where one of the brief's routes leaves town, with the route's ID, name, kind and bearing |
| Water | A river as a centre line with its mean width and, where the width varies, one width for each point of the line; or the sea as a polygon |
| Lot | Its building, a polygon, its district, an entrance (a segment and a point on it), and its footprints: the outlines of the buildings on it |
| District area | The polygons that enclose a district's lots, and a label point |
| Wall | One per walled town: its lines, one closed line or open lines ending at the banks where water parts it, with a width, and its gates: each a junction on a line and the gatehouse that keeps it |
| Place | Open ground: a `plaza`, the lot of its building, or a `green`, ground inside the town that belongs to no building |
| Block | The ground between streets that lots are cut from, its district, and its `growthRank`: 0 for the first ground built on, 1 for the last |
| Courtyard | Open ground inside a block that belongs to no one lot: its block, a polygon, the lots that back onto it, and the passage segment that reaches it from the street, if any |
| Summary | Counts, the bounding box, the outline's area, built area, residents per hectare, `ringShare`, the roads out of the centre, the layout version, the generator's name, the pack and the seed |

Its rules are checked by `layout/invariants.ts` on every layout: one lot per
building; no lot overlapping another, a roadway or water; every entrance on a
segment that borders its lot; a connected street graph; an exit within 20
degrees of each of the brief's route bearings; the river and the sea where the
brief puts them; only bridges crossing water; a port's waterside district at
the water; each district in one piece; a plausible density; and footprints
that lie inside their lot without overlapping each other, everything else in
the lot being open ground; and courtyards inside their block, clear of every
lot and roadway, each lot backing onto one at most. Shapes are
general: nothing that reads a layout may assume straight streets or
rectangular lots, and the tests bend streets and use five-sided lots to hold
the viewer, the invariants and the path function to that.

**Footprints.** The grid generator draws one rectangle across each lot's
street frontage, as deep as the pack's `coverage` for the building type, and
leaves the rest as a yard. An open-air type has no footprint unless the pack
gives it one, such as a stable at the front of a stockyard. Footprints came
with `LAYOUT_VERSION` 2; junctions, segments, lots and entrances stayed those
of version 1, which a fingerprint of all 682 settlements holds.

**Streets of one trade.** `LAYOUT_VERSION` 3 settles last which building
holds which lot, and changes no lot. Within a district, buildings whose lots
are alike (the same size, covered by the same share of building) change
places, so that buildings of one type stand on neighbouring lots along a
street: a row of forges, then a row of leather shops. Types the pack spreads
are the exception and stand apart from their own kind. The street graph, the
lots and their footprints are exactly those of version 2, which a test holds
for every settlement; `generateLayout(city, brief, pack, { arrange: false })`
gives the version 2 arrangement, for comparing.

Because lots are held as they were, a building can only change places with
one whose lot is alike. That caps how far trades can gather: in Badanos 65%
of working buildings now stand beside one of their own type, up from 28%,
and 67.5% is the most this method can reach. Forges and leather shops, whose
lots are the common size, are nearly all in rows; tanneries, yards and market
stalls have lot sizes of their own and stay scattered among other lots.
Reaching the 70% that was hoped for needs the generator to hand out lots type
by type, which moves lots.

The same limit left one thing wrong, which `LAYOUT_VERSION` 4 (phase 6C)
mended: **a district's wells stood in a row.** The generator gave landmarks
their lots first, so the wells of a district were packed side by side, and
only a well has a lot of a well's size: across Lomia 11,308 of 11,740 wells
had another well beside them, and in Badanos four of Mill Row's six wells
opened onto one stretch of street. Now the civic buildings a pack spreads
(wells and public ovens) take their turns at even steps as a district grows,
each on a frontage whose street has none of its type yet. This moves lots, so
it is a new layout version. In all 682 settlements no district has two wells,
or two ovens, opening onto one segment, and no well stands beside another.

**Walls, gates and the plaza.** A settlement flagged `walls` has a wall, and
one flagged `plaza` a plaza; no other has either. No segment crosses a wall
except at a gate, every gate has a gatehouse within 30 m, and the city
generator makes at least one gatehouse for each of the brief's route exits.
A plaza is the open lot of its building, with a street all the way round.

**Two generators** make layouts in this format, and a layout's summary names
the one that made it. The pack's `layout.yaml` chooses with `generator`: the
medieval pack names `staged`, and a pack that says nothing gets the grid.

- **`grid`** (`layout/grid.ts`) is deliberately regular: a street grid around
  the centre, a river bending beside it, districts grown block by block from
  the centre outward, an arterial from the centre to each exit, and bridges
  where streets meet the river. It has no walls and no plaza, and its water
  has straight edges.

The `grown` generator of phase 6D has been removed. Its renders are kept in
`docs/renders/` as `-grown-6d3` and `-grown-6d4`, for comparison.

**The staged generator (phases 6E and 6F).** `layout/staged/` holds the
generator that lays every town out, built stage by stage after the approved
prototype in `docs/prototypes/proto_wards9.py` (pictures `w9_*.png`); the
gameplan is `sim-6e.md`. The town is made in a fixed order on one shared
mesh, and a later stage never moves what an earlier one placed. The pack
names it (phase 6F), so it lays every town out; the grid is still there by
name. Its numbers are in the `staged` block of `layout.yaml`,
and each stage draws on streams named `staged-…`. The stages:

1. **Water** (`staged/water.ts`). A river enters and leaves on the brief's
   bearings with two broad bends and a constant width. The brief gives no
   distance, so how far it passes from the centre is one seeded draw, as a
   share of the town's radius: 0.25 to 0.85, or 0.15 to 0.4 for a river port
   with no coast, whose river is also half as wide again. It never passes
   nearer than leaves room for the plaza and a quay road. A coast is a line
   of broad bays and headlands; where a land route leaves within 90° of the
   water's bearing, the shore on that side runs out to sea beside it, so that
   no land exit is in the water.
2. **Highways and bridges** (`staged/highways.ts`). Every land route is a
   highway; two exits more than 150° apart are one road through the centre.
   A town is astride its river where the river passes within half its radius
   of the centre, and beside it otherwise. Bridges stand only where a route
   crosses the river or the town is astride it: one under 1,500 buildings,
   two under 4,000, three above, a share of the radius apart (0.3 to 0.45,
   at least 120 m). The main bridge is chosen first, where the river runs
   most nearly square to the way, and the road is laid onto its axis. Beside
   the river the highway splits to the further bridges and rejoins; astride
   it each side bridge's road curves into the nearest road on each bank.
   Astride a river no route crosses, the main bridge carries a road of its
   own from the centre and the bridge roads run on into the far bank as main
   streets. A town beside a river no route crosses has no bridge and takes
   no ground across it.
3. **Harbour.** A port has a quay: on its coast a strip along the shore with
   piers, or with no coast a wharf along the river bank nearest the centre
   with short jetties, clear of the bridges. A settlement with a sea route
   but no port flag has a landing with a single jetty. The sea routes are
   one highway from the centre to the quay, and each has its exit at an end
   of the quay.
4. **The wall** (`staged/wall.ts`), for towns flagged `walls`. One rounded
   ring about the centre, holding ground for half the town's buildings: an
   oval along the road where one road runs through, nearly round where
   several meet. Towers stand about every 85 m and the wall runs straight
   between them. At water it ends at the bank, and at a quay at its edge.
   Where under 30% of the ring lies across a river, or the town has no
   bridge, the far part is left out and the river closes that side. A gate
   stands wherever a highway or main street crosses the wall, and at every
   bridge into a bank the river closes.
5. **Special wards** (`staged/special.ts`). The plaza of a town flagged
   `plaza` lies where the highways meet. The castle of a town flagged
   `citadel` stands just off it in the widest gap between the roads that
   leave the centre, inside the wall and clear of roads and water. Both are
   sized per building between a least and a most, and never more than a
   share of the ground the town needs, so that a village's are small.
6. **Ground** (`staged/ground.ts`). How far the mesh needs to reach: land is
   taken cheapest first until there is 2.6 times the ground the buildings
   need, where cost is distance from the nearest highway and from the
   centre, with smooth noise. One road draws the town out along it; several
   make it round. It is held as squares and never as an outline, and takes
   nothing across a river without a bridge. The cost is kept as the growth
   rank of what stands there.
7. **The mesh** (`staged/mesh.ts`). Seed points are scattered over the
   ground about 0.6 of the radius apart; those near a highway, the river or
   the wall are replaced by pairs either side of it, so that the line falls
   on the border between cells. The castle and the plaza each get a seed
   with one mirrored in every side, which makes each a cell. The Voronoi
   diagram of the seeds is the mesh: cells that share their corners.
8. **Main streets** (`staged/streets.ts`). From mesh corners on a highway
   each follows cell borders outward, taking the straightest way on and
   stopping where the turn is too sharp, then is evened by moving the
   corners it passes through, so the wards beside it bend with it. None
   crosses water or the wall.
9. **Wards** (`staged/wards.ts`). A ward is its cell less the highways, main
   streets, water, wall and special wards, moved in by half a ward border;
   the plaza and the castle are wards with exactly the shape they were
   given. Each ward is then split into blocks (`staged/blocks.ts`): cut
   across its long axis near the middle by a lane, turned slightly, and
   again until its pieces are small enough. The line of each cut is kept
   as the lane's centre line.
10. **Reservations** (`staged/landmarks.ts`). Anything special claims its
    ground before houses are laid. The pack's `landmarks.types` names the
    building types that do and what each reserves: a ward (the citadel in
    the castle, with a keep; the market square, which is the plaza), a
    block, a slot or a gate. A block landmark takes a whole block, the one
    nearest the plaza, a highway or main street, or the harbour, within the
    built-up town, at least 90 m from any other (30 m within one district); its footprint is a template from the pack (a
    cross, a hall round a yard, an L, a plain range) scaled down until it
    fits whole inside. It is never clipped. One that finds no block is
    reported and will be an ordinary house. Slots and gates are not
    reserved yet.
    **Rows of houses** (`staged/rows.ts`). In every block houses are laid
    along each edge, longest edge first: rectangles facing the street, some
    with a rear wing that makes an L, a gap apart, with the courtyard
    behind. A block too shallow for a courtyard has one row right through,
    and about a third of courtyard blocks have a passage through one row.
    A house lies wholly inside its block and never overlaps another or a
    passage; one that does not fit is made a little narrower or shallower,
    and failing that is not built and the ground is left as yard. About two
    and a half times as many houses are made as the town has buildings.
11. **Districts** (`staged/districts.ts`), which in the order of work come
    before blocks. The city's districts are grown over the wards: each
    starts at a seed ward chosen by its kind's placement (first the
    district that owns the plaza, at the ward nearest it, so that the plaza
    stands in its own district; then a waterside one, at the ward whose
    ground comes nearest the quay; then, where there is no plaza, the first
    at the heart of the town; and the rest spread through their band of
    it) and takes neighbouring wards, nearest and
    innermost first; ground is ranked as it is when the town's houses are
    chosen, inside the wall before outside it, so that a district is not
    given ground whose houses the town will not keep. Crossing a highway, a main street, the wall or the
    river (only at a bridge) costs extra, so those become district borders.
    A district stops when its wards have room for its buildings, and what
    is left over goes to the nearest district. A district
    sets its wards' character from the pack: how large houses and blocks
    are, how many lanes, how often a rear wing or a passage. A landmark
    stands in its own district, among its inner blocks.
    **Selection** (`staged/selection.ts`). The town keeps exactly as many
    houses as it has buildings, chosen as one town: the innermost 62%
    always, everything inside the wall first, and beyond that by a score
    that luck inflates with distance, so the centre is solid and the town
    thins toward its edge. A kept house belongs to the district of its
    block. Wards are coarse, so each district's count is then made exact at
    its borders, and no house is dropped or added in doing so. A district's
    body is the largest piece of its blocks that touch; a block apart from
    it, but for a landmark's own, first goes to the district whose body it
    touches. A block then changes district only where its ground touches
    the taker's body (or a bridge link joins the two), and never where
    its loss would part the district that gives it; a district that is
    short first takes the unbuilt blocks between it and the nearest houses,
    and is then supplied from the nearest district with houses to spare
    through the districts between, a block changing hands across each
    shared border on the way. A thin district, every block of which holds
    it together, can give nothing: it is passed through like any district
    between, taking first a block that frees one of its own at the border
    beyond, or one that lies behind that border, and the chain is tried
    again with the district thicker. What blocks cannot settle is settled
    the same way by single houses, which cross a bridge link as blocks do:
    the house of a border block nearest the neighbour's ground, first only from a block that could go itself,
    since a block that has given houses no longer holds its district
    together, and then, for a district still short, from any border block
    so long as most of its houses stay its district's.
    Where a short district has no neighbour across a border with houses to
    spare it takes the nearest kept houses of any district that has: the
    last resort, counted in the selection's `fallback`. If the whole
    town has too few houses, ground is taken again half as large again, at
    most three times: the generator's only loop, which no settlement of
    Lomia needs.
    **Which building goes where** (`staged/fitting.ts`). Every building the
    city made gets exactly one place, and none is added, removed or
    changed. A landmark with a ward or a block has its place already.
    Within each district the rest are sorted by the area of their pack lot
    and the kept houses by the area of their footprint, and paired largest
    to largest, so that pack lot sizes are targets, not exact sizes. Then
    the rule the grid also uses (`layout/shared.ts`) lets buildings with
    lots alike change places, so that trades gather along a street and the
    types the pack spreads stand apart; and last the types listed under
    `fitting.onRoads` change places so as to front a highway or main
    street.
12. **The layout** (`staged/network.ts`, `staged/layout.ts`,
    `staged/tiles.ts`). `generateLayout(city, brief, pack, { generator:
    'staged' })` writes the plan in the one layout format and checks it.
    - *The walking network* is built from the town's own geometry: a
      highway's line, a main street's mesh edges, each ward border, the line
      of each cut between blocks, each passage's axis, a ring round the
      plaza and the castle, the quay, and lanes along the wall, the bank and
      the shore where houses face them. Ways are trimmed out of the water
      and off the wall, carried on to meet the next way, and joined into one
      graph; a pocket of lanes cut off from the rest is joined by the
      shortest lane that passes no house. A way no building fronts and
      nothing needs is left out.
    - *Widths.* A highway's segment is as wide as the whole ground between
      the house fronts either side (19.3 m), since the format wants a lot's
      entrance near its lot; it narrows beside the plaza and near the water.
    - *Lots.* A house's lot is its footprint, with its front; a well is a
      small footprint in an open lot; a block landmark's lot is its block; a
      lot opens onto the nearest way. An open-air building (`openAir` in the
      pack) keeps the whole house rectangle as its lot and is built over only
      as far back from the street as `footprints` in `layout.yaml` gives its
      type, none by default: the rest is its yard.
    - *Courtyards.* What is left of a block once its lots, its ways and the
      gaps between houses are taken out is its courtyard, in as many pieces
      as it falls into; each piece is written with the lots that back onto
      it, and with its passage where a passage's lane reaches it. A lot
      standing free in a courtyard is joined to the ground round it by a slit
      that crosses no other outline. In Badanos 1,812 of 1,825 lots back onto
      one of 311 courtyards.
    - *Gates.* Every way through the wall is a gate. Gatehouses keep the
      highways' gates first, then the gates at bridges into a bank the river
      closes, then as many ward borders as are let through the wall for
      them; a gate beyond the count of gatehouses is plain, kept by no
      building. A sea route's exit stands on the quay (`atQuay`).
    - *District ground.* Every block has a tile of the ground about it, cut
      from one partition of the town, and so do the plaza and the castle.
      A tile is the ground of the district that holds most of its lots,
      and nothing is re-owned afterwards: a district's ground may be in
      several pieces, and a lot in a block a neighbour holds most of stands
      in the neighbour's ground. Nothing is drawn across the water. Where a
      bridge has one district's ground at each end, a bridge link records
      it. A link joins the tiles nearest the bridge's ends, passing a
      landmark's block, the plaza or the castle for the next block along
      the road (`staged/tiles.ts`, `bridgeLinks`). Tiles are kept without
      hairs of ground (narrower than 12 cm), which would make neighbours of
      tiles that do not really meet.

    Layout format version 10 adds wards, a lot's `front`, `atQuay` on an
    exit, and a gate's building as optional, and `bridgeLinks`. The only
    rule for district ground is that no two districts' grounds overlap.
    How many lots stand outside their own district's ground, and how many
    districts are in more than one piece, is measured, not required
    (`measureDistrictGround`, reported by `node scripts/staged-census.ts`).
    Version 11 (phase 6F) gives open-air buildings their yards and adds
    `courtyards`.

    Measured on 2026-11-24, the staged generator keeps every invariant in
    all 682 of Lomia's settlements. Of their 540,856 lots, 3,049 (0.56%)
    stand outside their own district's ground, in 371 settlements; 284 of
    2,229 districts are in more than one piece (108 when a district's own
    bridge links count as joins); 17 settlements use the non-touching
    fallback, for 1,372 houses. All 682 are laid out and checked in about
    5 minutes; Badanos takes about 1 second and Pombal, the largest, about
    4.

A ward's blocks draw on a stream of the ward's own, named by its seed
point, and each block's rows on a stream of the block's own, so that a
change to one ward, or reserving one block, changes no other. Whether a house
fits is tested directly on rectangles (`staged/rects.ts`), not through the
polygon library.

**Its own checks, pins and edits.** Besides the layout invariants, the
staged generator counts on every town it makes (`staged/checks.ts`) pairs
of kept houses that overlap, houses not wholly inside their block, houses
standing in a passage, landmarks clipped or outside the block or ward
reserved for them, and ordinary wards with no blocks; any count above zero
fails the layout, naming the count. `generateLayout` takes `pins`, the
reservations a person made: a block pin (`{ reservation: 'block', at,
buildingType }`) gives the block at its place to a landmark of that type
before any rule chooses, and the rules fill in around it. Ward and slot
pins are accepted and not yet applied. No list and an empty list give the
same bytes. `redraw` names wards to draw afresh, as an edit to one ward
would: that ward's own streams change and no other's, so every other
ward's houses stay as they were, and selection keeps or drops a few houses
elsewhere to hold the town's total (in Badanos 24 of 4,913, most of them
at the edge). A layout asked for with `check: false`, as the comparison
view and `npm run render -- <id> --generator staged` do, is returned
without either set of checks.

Polygon arithmetic (taking shapes out of shapes, moving outlines in, giving
lines width) goes through `clipper2-ts`, a TypeScript port of Clipper2 with
no dependencies, wrapped in `staged/shapes.ts`. It works on whole numbers,
here millimetres, so the same shapes give the same answer on every machine.
The mesh is `d3-delaunay`'s Voronoi diagram.

`node scripts/render-stages.ts <out folder> <suffix> [--kinds] [--as flag,flag] <settlement name>...`
draws the plan as far as the stages go; `--as walls,plaza,citadel` draws a
town as if its brief had those flags too, and `--kinds` tints houses by the
kind of building in them and not by district. `docs/renders/*-6e-step1.svg`,
`*-6e-step2.svg` to `*-6e-step7.svg` are seven towns after each step
(the last tinted by kind of building: dwelling, workshop with a home,
workplace, landmark in a row), and `badanos-6e-step<n>-as-walled.svg` are Badanos, which the world gave no wall, drawn with one for comparison with
the prototype.

`node scripts/staged-census.ts [every] [--towns]` lays out every settlement
(or every nth) with the staged generator and counts which invariants are
broken and how often the non-touching fallback is used.
`PROBLEM-6E-districts.md` describes what is still open.

**The village generator (phase 6E, Villages, being built).** A settlement
under `village.below` residents (1,000; 136 of Lomia's 682) is to be laid out
by `layout/village/`, after the approved prototype
`docs/prototypes/proto_village5.py` and the Villages section of `sim-6e.md`:
no mesh, wards or wall ring; the road leads and buildings are placed one at a
time. Its numbers, and which building types hold its anchors, are in the
`village` block of `layout.yaml`, and it draws on streams named `village-…`.
It does not make layouts yet. Built so far:

1. **Environment** (`village/plan.ts`). A stream with broad bends or a calm
   shore, drawn by the staged generator's water stage with the village's
   own numbers, the radius being the cap on the through road.
2. **Road** (`village/roads.ts`). Each land route is a road 6 m wide from
   the centre; two exits more than 140 degrees apart are one through road,
   evened so that it bends at the centre. A small bridge wherever a road
   crosses the stream; a road that would run into the sea stops at the shore.
   The shape follows: a coast gives *shore*; two or more roads, *crossroads*;
   the `plaza` flag, *green*; otherwise *street*. The brief carries no
   settlement type, so a Lake or Naval settlement is a shore village only
   where it is coastal.
3. **Anchors** (`village/anchors.ts`). The green (flag `plaza`): an oval
   beside a road at the centre, with a pond, the well and a lane round its
   far side. Without it, the well by the road at the centre. A church
   (flag `temple`, or a chapel in the city) in its churchyard by the green
   or near the centre; a manor (flag `citadel`) in its own yard with a barn;
   a mill beside the stream's crossing; a landing (flag `port`) with one
   jetty and a lane to it. Each holds the first building of its pack types
   the city has.

`node scripts/render-village.ts <out> <suffix> [--as flag,flag] <name>...`
draws a village's plan so far; `docs/renders/*-village-step3.svg` are
Vereceldo (65 buildings) and Monhas (180) after step 3.

`ringShare` is in every layout's summary so that a town falling back into
rings and spokes shows without a picture. It is the share of street and lane
length within 20° of a circle about the centre or of a line to it, leaving
out the innermost 30 m.

**Drawing a town.** `renderLayoutSvg(layout, options)` in core returns a
picture of a layout as SVG text: water, streets by kind, lots tinted by
district, the wall and its gates, the plaza, and exits labelled with where
they lead. `npm run render` wraps it:

```sh
npm run render -- settlement-641 [--generator grid|staged] [--seed <number>] [--out <file.svg>]
```

`docs/renders/*-6f.svg` are the seven test towns as the pack lays them out
with `npm run render`, by the staged generator.
`docs/renders/` also holds five towns as the grid lays them out (`-grid`), as the
removed generator did at phases 6D.3 and 6D.4 (`-grown-6d3`, `-grown-6d4`),
and the staged generator's plans step by step (`-6e-step1` to `-6e-step7`)
and its layouts (`-6e-step8`, `-6e-step10`).

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
  of its own, and never passes through a footprint or off its ground. A
  building whose lot has no open ground, as a staged house's has not, uses the
  courtyard its lot backs onto; failing that, the plaza if the lot is nearer
  to it than to its entrance; failing that, the street in front, as a visit
  marked `where: street` does (`outsideGrounds` in `life/wander.ts`, life
  version 6). A pace of zero means standing still. Sleep and time at home are
  always indoors.
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

Daily life has its own `LIFE_VERSION`, now 6, in `life/records.ts`. Version 6
sends someone outside at a building with no open ground of its own to its
courtyard, the plaza or the street in front, where it had them stand at the
lot's frontage. On the grid that touches only stays at the few lots its
footprints fill (66 of 104,481 in every sixth settlement), which now go out
on the street in front. Version 5
added outsiders to every answer and changed no resident's plan. Version 4
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

## Outsiders

Phase 6C brings to town the first people who are not residents
(`packages/core/src/outsiders`). **Travellers** arrive by the roads and the
sea, find lodging, go about their business and leave; **vagrants** live on the
streets. Neither is in the city's people, households or counts: a town still
holds exactly the brief's population, and no resident's plan reads an
outsider, which a test holds by comparing every resident's plan in Badanos
over eight days with outsiders computed and without.

**Outsiders obey the rule everyone obeys: nothing is stepped and nothing is
remembered.**

- The parties that arrive on a day are a function of the settlement, the day
  and a seed. Each kind of traveller has a random stream of its own per day,
  and each party one of its own.
- A party's whole visit is derived from the day it arrives: who is in it,
  where they came from, how long they stay, where they lodge, what they do,
  and when and by which exit they leave. So the people in town on a day are
  that day's arrivals and those of the few days before whose visit has not
  ended; day 40 can be asked about without working out days 1 to 39.
- A traveller's ID carries the settlement, the arrival day, the kind, the
  party and the member (`traveller-641-000040-merchant-002-01`), so anyone can
  be found again from their ID alone.
- Vagrants are a fixed, seeded set, and where each sleeps on a night is a
  function of the vagrant and the night.

**Where routes lead.** The importer follows each route exit of a brief to the
first settlement along it and records its ID, name, size group, population,
culture, state and the distance along the route (`leadsTo`); a route that
reaches no settlement leaves the field out. From Badanos the Pusztaszian
trail leads to Pusztaszi at bearing 227 and to Veszfetaros at bearing 61.
1,566 of Lomia's 1,794 exits lead to a settlement, and every one leads back
by the same route. Nothing else in any brief changed. A sea route is followed
the same way, to the next settlement on it: 22 of those are not flagged as
ports in the export, and are named as they are.

**A town's draw** is a number worked out from its brief by the pack's rules
(`drawOf`): a weight for each flag and status, a term for sheer population, a
term for specialties. It comes with its breakdown by term. Below the pack's
floor (5) a settlement draws no tourists at all. 223 of Lomia's 682
settlements reach the floor. The ten highest:

| Settlement | Residents | Draw | Why | Travellers expected a day |
| --- | --- | --- | --- | --- |
| Pombal | 47,603 | 40.4 | capital 10, port 4, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 11.9, specialties 1.5 | 152 |
| Celenaza | 31,131 | 36.3 | capital 10, port 4, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 7.8, specialties 1.5 | 109 |
| Vasetbo | 28,083 | 35.5 | capital 10, port 4, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 7, specialties 1.5 | 96 |
| Cevilefon | 20,032 | 33.5 | capital 10, port 4, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 5, specialties 1.5 | 93 |
| Ruha | 35,699 | 33.4 | capital 10, port 4, citadel 3, walls 1, plaza 2, province seat 3, population 8.9, specialties 1.5 | 108 |
| Karpeysk | 24,561 | 32.1 | capital 10, port 4, citadel 3, walls 1, temple 4, province seat 3, population 6.1, specialties 1 | 85 |
| Guignesto | 24,042 | 30.5 | capital 10, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 6, specialties 1.5 | 88 |
| Rabe | 21,404 | 29.9 | capital 10, port 4, citadel 3, walls 1, plaza 2, province seat 3, population 5.4, specialties 1.5 | 90 |
| Sunde | 20,921 | 29.7 | capital 10, citadel 3, walls 1, plaza 2, temple 4, province seat 3, population 5.2, specialties 1.5 | 88 |
| Klauka | 20,572 | 29.1 | capital 10, port 4, citadel 3, walls 1, plaza 2, province seat 3, population 5.1, specialties 1 | 99 |

Badanos, a province seat of 9,607 with two specialties, has a draw of 6.4;
Vereceldo, a walled village of 253, has 1.6.

**Lodging and the visitors' quarter** (generator version 5). A settlement has
an inn for every 12 travellers its rules expect to arrive in a day, and at
least one wherever any are expected: 1,287 across Lomia, two in Badanos,
thirteen in Pombal, one in Vereceldo. An inn is a landmark whose staff are
fixed posts: an innkeeper, whose household lives in it, and in larger places
inn servants and chambermaids. Innkeepers worked in taverns before; in
Badanos thirteen did, and two keep the inns now. Posts take their slots from
their own category, so population, workforce and the seven category counts
did not move in any settlement, while occupation counts inside a category
did: `badanos-counts-v5.json` lists what moved. A settlement whose draw
reaches 22 has a **visitors' quarter**, a district of its own beside the
centre: 22 settlements do, Pombal among them and Badanos not. The inns, the
players' halls and a gaming house stand there; in a town without the quarter
they stand in the centre.

The quarter's types are placeholders: inns, the existing players' hall
standing for a playhouse, and a gaming house. To add a type of your own,
define it in `landmarks.yaml` or `workplaces.yaml`, give it a lot in
`layout.yaml`, and list it under the `visitors` kind's `types` in
`districts.yaml`. A test does exactly that with a made-up menagerie.

**Travellers.** Each kind is a pack entry in `travellers.yaml`: how many
parties arrive in a day and what that depends on (residents, the number and
kind of route exits, the draw, the day of the week), party size, nights,
hours of arrival and departure, where they lodge, what they do, and how they
leave. The medieval pack has five placeholders: merchants, tourists (who
depend on the draw alone), adventurers and mercenaries (who lodge at the
adventurers' guild hall or an inn and keep to it and the taverns), and people
passing through (about half of whom do not lodge, and who leave by a
different exit where the town has more than one).

- **A party moves together**: its members share one plan, and are in the same
  place at every moment.
- **A day in town is a plan like a resident's.** A party enters at an exit
  junction, walks to its lodging, makes the visits the pack gives its kind,
  sleeps at its lodging, and on its last day walks to an exit and is gone.
  One that does not stay the night makes its visits one after another on the
  way through. A trip from an exit is a trip like any other; opening hours
  apply as to anyone; and every plan passes the rules a resident's passes,
  for the time the traveller is in town (`outsiders/invariants.ts`).
- **Origin** is the settlement the entry route leads from, where the brief
  names one; otherwise the route itself.
- **Names** are made from the town's own name base, because a brief carries
  no other: a merchant from Pusztaszi is named as Badanos names its own.

**Vagrants.** A settlement of at least 1,000 residents has 0.3% of its
residents again as vagrants (29 in Badanos, 143 in Pombal, none in
Vereceldo): 8,527 across Lomia. At night each sleeps at a point on a street,
standing still: on a lane, by the end of a bridge, or on a street built on
one side only, as at the town's edge. Each has three such places and keeps
one for a run of three to ten nights. By day they wait about outside chapels
and taverns, stand by wells and in the square, and wander the streets, all of
it out on a street: a vagrant is never inside a building. They never lodge
and never work, and the watch does nothing about them.

**One population for every query.** `createLife({ city, layout, pack, brief })`
works out the outsiders too and answers for them in `whereabouts`,
`occupants`, `trips`, `outsideStays`, `nearby` and `daySummary`, each marked
`outsider`; `life.outsiders` gives the records (`arrivals(day)`,
`partiesInTown(day)`, `inTown(day)`, `vagrants()`, `outsider(id)`). A
traveller asked about before arriving or after leaving is `away`. The avatar
perceives outsiders exactly as it perceives residents. Without the brief, or
with a pack that has no travellers file, there are no outsiders and every
answer is what it was.

**In the viewer.** Outsiders are drawn in colours of their own from
`display.yaml`, one for each kind of traveller and one for vagrants, and the
legend lists those in town that day. Hovering one shows their name, their
kind and where they are from ("Merchant from Pusztaszi"). Clicking one opens
their panel: kind, party (each companion opens their own panel), where they
came from and by which route, when they arrived and when they leave and where
that route leads, their lodging, what they are doing now, and today's plan as
the timeline residents have. A collapsible **In town today** pane lists the
day's outsiders by kind with counts and follows the clock's day. A building
where travellers lodge lists its guests. The settlement panel beside the
world map shows the draw with its breakdown, the travellers expected in a
day, whether the town has a visitors' quarter, and where each route leads
with the distance. The around-you panel lists perceived outsiders with their
kind and origin. The members of a party are drawn on one point, since they
are in the same place: the others are reached through the party list.

**What phase 6C changed** (default seeds; work days 8 to 13 for the travellers
in town, day 1 for the rest). The magnitudes are estimates to be reported,
not quotas: every rate is a placeholder meant to be defensible for a town of
that size on that road.

| Settlement | Travellers in town on a work day | Of them | Vagrants |
| --- | --- | --- | --- |
| Badanos, 9,607 residents, one trail | 75 (0.78%; day by day 64 to 81) | 40 merchants, 14 adventurers, 12 tourists, 6 mercenaries, 2 passing through | 29 |
| Pombal, 47,603 residents, capital and port | 409 (0.86%; 365 to 465) | 196 merchants, 114 tourists, 43 passing through, 37 adventurers, 20 mercenaries | 143 |
| Vereceldo, 253 residents | 5 (4 to 6) | 3 merchants, 2 passing through, no tourists | 0 |

People to be seen on the streets (walking, stopped on a street, or outside at
a building) on each hour of day 1, before the phase and now with outsiders:

| Hour | Badanos before | Badanos now | of whom outsiders | Pombal before | Pombal now | of whom outsiders | Vereceldo before | Vereceldo now | of whom outsiders |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 00:00 | 11 | 38 | 29 | 152 | 261 | 143 | 0 | 0 | 0 |
| 01:00 | 12 | 41 | 29 | 102 | 233 | 143 | 0 | 0 | 0 |
| 02:00 | 12 | 39 | 29 | 92 | 243 | 143 | 0 | 0 | 0 |
| 03:00 | 11 | 40 | 29 | 97 | 257 | 143 | 0 | 0 | 0 |
| 04:00 | 12 | 42 | 29 | 120 | 252 | 143 | 0 | 0 | 0 |
| 05:00 | 37 | 60 | 29 | 226 | 379 | 143 | 0 | 0 | 0 |
| 06:00 | 27 | 55 | 29 | 330 | 443 | 143 | 0 | 0 | 0 |
| 07:00 | 92 | 112 | 29 | 1,022 | 903 | 151 | 1 | 1 | 0 |
| 08:00 | 1,398 | 1,386 | 29 | 8,713 | 8,676 | 148 | 20 | 19 | 0 |
| 09:00 | 1,069 | 1,106 | 34 | 5,412 | 5,429 | 153 | 24 | 25 | 0 |
| 10:00 | 1,493 | 1,507 | 32 | 7,580 | 7,628 | 179 | 36 | 36 | 0 |
| 11:00 | 1,696 | 1,738 | 32 | 8,607 | 8,711 | 180 | 41 | 42 | 0 |
| 12:00 | 1,213 | 1,255 | 32 | 6,233 | 6,182 | 188 | 29 | 28 | 0 |
| 13:00 | 1,014 | 1,049 | 37 | 4,967 | 5,048 | 201 | 20 | 23 | 0 |
| 14:00 | 1,001 | 997 | 31 | 4,852 | 4,902 | 173 | 21 | 22 | 0 |
| 15:00 | 1,522 | 1,555 | 32 | 7,958 | 7,965 | 176 | 30 | 34 | 0 |
| 16:00 | 1,898 | 1,914 | 31 | 9,881 | 9,727 | 176 | 43 | 43 | 0 |
| 17:00 | 1,817 | 1,785 | 32 | 11,168 | 11,005 | 174 | 18 | 20 | 0 |
| 18:00 | 342 | 352 | 30 | 1,887 | 1,826 | 153 | 7 | 6 | 0 |
| 19:00 | 455 | 458 | 32 | 2,925 | 2,766 | 153 | 7 | 8 | 0 |
| 20:00 | 96 | 123 | 29 | 1,012 | 1,009 | 160 | 3 | 3 | 0 |
| 21:00 | 63 | 97 | 29 | 709 | 787 | 150 | 2 | 1 | 0 |
| 22:00 | 26 | 57 | 29 | 407 | 537 | 145 | 0 | 0 | 0 |
| 23:00 | 62 | 97 | 29 | 696 | 836 | 143 | 0 | 2 | 0 |

Most travellers at any moment are indoors, at their lodging or on a visit, so
of Badanos's 60 to 80 only a few are on the streets at once; at night the
people to be seen are the watch and the vagrants asleep.

Phase 6B's target figures, before the phase, now for the residents alone, and
now with outsiders counted. The residents' figures moved because the layout
and the city did (wells apart, inns), not because outsiders exist:

| Measure | Town | Before | Residents now | With outsiders |
| --- | --- | --- | --- | --- |
| Walking at 12:30, mean of six work days | Badanos | 203 (2.1%) | 197 (2.05%) | 200 |
| | Pombal | 1,417 (3.0%) | 1,266 (2.7%) | 1,299 |
| | Vereceldo | 1 | 2 | 2 |
| Walking at 07:50 on day 1 | Badanos | 910 | 870 | 870 |
| | Pombal | 8,378 | 7,891 | 7,897 |
| Share of 100 seeded street points perceiving someone at 12:30, and the mean and median perceived | Badanos | 49%, 2.0, 0 | 54%, 2.5, 1 | 58%, 2.6, 1 |
| | Pombal | 50%, 2.1, 1 | 58%, 2.5, 1 | 59%, 2.6, 1 |
| | Vereceldo | 16%, 0.3, 0 | 14%, 0.3, 0 | 14%, 0.3, 0 |
| Watchmen on the streets on the hour, least and most | Badanos | 11 to 34 | 9 to 36 | 9 to 36 |
| | Pombal | 92 to 405 | 90 to 404 | 90 to 404 |
| Trips per resident in a day | Badanos | 3.65 | 3.66 | 3.66 |
| | Pombal | 3.12 | 3.25 | 3.25 |

With a district's wells on streets of their own, the nearest well is nearer:
walks to fetch water are shorter, so fewer people are walking at one instant
(a tenth fewer in Pombal at midday), while the people who are out are spread
over more streets, and the median street point in Badanos perceives one
person again, where it perceived none. The full figures are in
`baselines/streets-before-6c.json` and `baselines/streets-after-6c.json`,
made by `scripts/measure-streets.ts`.

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

**Homes that are workshops.** A building in which a household lives and
people work is named as both, by the pack's pattern: "Forge and home", on
hover, in its panel and as a household's home. On the map it has a second
outline inside its footprint, which the legend explains, so it can be told
from a plain dwelling and a plain workplace without relying on colour. Its
panel lists the household that lives there before the people who work there.

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
`baselines/badanos-lot-paths.json`; phase 6B.5's are in `districts.test.ts`
(nothing created or destroyed, spread, tiers, housing near work, streets of
one trade, in Badanos and in every settlement), with
`baselines/city-v3.json` (every city as generator version 3 made it) and
`baselines/badanos-districts-v4.json` (the new baseline and what moved);
phase 6B's are in `civic.test.ts` (civic
buildings in every settlement), `rounds.test.ts` (rounds, chains, repeats,
strolls, the targets, emergence and pack behaviour), `baseline.test.ts` with
`baselines/badanos-counts-v3.json` (the new baseline and what moved) and
`baselines/badanos-life-v3.json`; phase 6A's are in `wander.test.ts`
(moving about outside), `layout.test.ts` and `lomia-cities.test.ts`
(footprints), `baselines/layout-v1.json` and `baselines/badanos-life-v2.json`
(what must not have moved), and `packages/client/e2e/viewer.e2e.ts` (the
viewer); phase 6C's are in `spacing.test.ts` (civic buildings apart, in
every settlement), `routes.test.ts` (where routes lead), `visitors.test.ts`
(the draw, inns and the visitors' quarter, in every settlement, with
`baselines/badanos-counts-v5.json` and `baselines/city-v4.json`),
`outsiders.test.ts` (arrivals, who is in town, travellers' visits, vagrants,
residents untouched, the queries, the magnitudes and pack behaviour),
`lomia-cities.test.ts` (every outsider's plan on day 1 in every settlement),
`outsiders-api.test.ts` in the server, and `viewer.e2e.ts`. Tests that hold
exact figures from before phase 6C (`baseline`, `civic`, `coherence` and
`districts`) run on the pack with what the phase added taken out
(`medievalPackBefore6C`), which the fingerprint in `baselines/city-v4.json`
proves gives the cities generator version 4 gave.

The whole-world run generates all 682 settlements of Lomia, 2,935,089 people,
and checks every invariant on each. With generator version 5 it takes about
10.5 seconds on one core of an Intel Core Ultra 7 265K, as part of the whole
suite running in parallel; Pombal, the largest settlement at 47,603 people,
takes about 0.13 seconds.

Laying out all 682 settlements, now 540,793 lots, takes about 6 seconds more,
again including the generator's own check of every layout invariant. No
settlement takes longer than 0.15 seconds; Pombal's 8,632 lots take about
that.

Outsiders cost little beside residents. Planning day 1 for every resident of
Lomia takes about 117 seconds now, and for all 43,122 outsiders in town that
day about 4 seconds more. Working out every outsider's plan for
three days of Pombal (about 500 in town a day) takes about 0.3 seconds, one
yardstick, against a limit of 6. Across Lomia 43,122 outsiders are in town on
day 1, 8,527 of them vagrants, and every one of their plans passes every
rule and joins on to day 2.

Planning one day for all 9,607 residents of Badanos takes about 0.5 seconds.
It was 0.12 before phase 4.5 added some 4,800 visits a day and the
opening-hours checks, 0.2 before phase 6A added the wanders, and 0.3 before
phase 6B tripled the trips: 1.7 times slower for three times the walking.
Pombal's 47,603 residents take about 4 seconds for the first day (it was
2.7), which includes preparing the path tables for its layout, and about 1.6
seconds for each day after (it was 0.9). Planning one day for every one of
Lomia's 2,935,089 residents takes about 115 seconds (it was 69), and every
plan in all 682 settlements passes every plan rule.

The test runner's default limit for one test is two minutes, set once in
`vitest.config.ts`, so that slow hardware cannot fail a correct build.

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
