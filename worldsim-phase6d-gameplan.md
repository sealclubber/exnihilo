# Phase 6D Gameplan — A Natural Town: Streets and Lots

Nov 21, 2026 · @seal

## Goal

Replace the grid with a town that looks grown: main roads that run from the centre to the real route exits, side streets that branch off them irregularly, blocks of uneven shape, and lots that follow the streets. Walled towns get a wall with gates, and towns with a plaza get one where the main roads meet.

The new generator emits the same layout format the grid does, so the city, daily life, outsiders, the avatar and the viewer keep working. Nothing about who lives in a town or what they do changes; only where things stand and how people walk between them.

This phase stops at lots. Building outlines inside lots, and grounds for the citadel and temple, are Phase 6E. The user wants to judge the street feel before shapes are built on it, so this phase also adds a way to render a town to an image file.

## Context

Phase 6C is verified on `68c5e9a`: 808 core and client tests pass, `GENERATOR_VERSION` 5, `LAYOUT_VERSION` 4, `LIFE_VERSION` 5, pack 0.10.0. The layout is made by `packages/core/src/layout/grid.ts` and its summary already says `generator: "grid"`.

The grid, measured with default seeds. These are the numbers the new generator is compared with.

| Measure | Badanos | Pombal | Vereceldo | Cevilefon | Flupines |
| --- | --- | --- | --- | --- | --- |
| Flags that matter here | none | walls, plaza, port, citadel, temple | walls | walls, plaza, port, citadel, temple | citadel |
| Water | river | river | none | sea | none |
| Lots | 1,825 | 8,632 | 65 | 3,606 | 95 |
| Segments | 314 | 1,361 | 35 | 670 | 35 |
| Street length, m | 22,381 | 97,862 | 2,514 | 48,000 | 2,429 |
| Share of street length on the two grid axes | 100% | 100% | 98% | 100% | 98% |
| Segments that are a straight line | 100% | 100% | 100% | 100% | 100% |
| Junctions with 3 or more streets that have 4 | 86% | 91% | 40% | 92% | 64% |
| Lots that are 4-point rectangles | 100% | 100% | 100% | 100% | 100% |
| Residents per hectare of lot area | 252 | 259 | 157 | 224 | 181 |
| Time to generate here, ms | 116 | 297 | 3 | 147 | 2 |

Two things follow from the table.

- **No segment has ever had a bend.** The format allows polylines, but every path, position, wander and nearby query has only ever been run on two-point segments. Expect bugs there and test for them first.
- **Walls and the plaza are flags the layout ignores.** Pombal, Cevilefon and Vereceldo are the test towns for them.

Things the rest of the code relies on, which the new layout must still provide: segment kinds `arterial`, `street`, `lane`, `bridge`; junction kinds including `dead-end`, `bridge-end` and `exit`; one lot per building with an entrance on a segment; one contiguous area per district. Vagrants sleep at lanes, bridge ends and the town's edge, and watch rounds, carters and travellers walk the arterials.

## Scope

**In**

- A second layout generator, `grown`, beside the grid, chosen by a setting in the pack's `layout.yaml`. `grown` becomes the default; the grid stays, for comparison and as a fallback.
- Curved arterials to the real exits, grown side streets, lanes and dead-end courts, irregular blocks, lots shaped to their street.
- An irregular town outline that stretches along the roads and the water.
- Walls with gates for towns flagged `walls`; a plaza for towns flagged `plaza`.
- Two additions to the layout format: walls and open places. `LAYOUT_VERSION` goes to 5.
- A command that renders a town to an SVG file, and committed renders of the five test towns.
- Viewer support for bent streets, odd-shaped lots, walls, gates and the plaza.

**Out**

- Building outlines inside lots: `footprints` stays as the grid fills it today. Phase 6E.
- Grounds for the citadel and temple; they remain ordinary lots. Phase 6E.
- Fields, farms and roads outside the town.
- Terrain height. Towns stay flat.
- Street names.
- Any change to the city generator, the pack's people rules, daily life rules or outsiders rules. `GENERATOR_VERSION` should stay 5. If something forces a change there, stop and report it.

## The generator: how a town is grown

The town is built in the order a real one was: site, main roads, the ground it covers, side streets, then plots. Each step uses its own `stepRng(seed, step)` stream, as the grid does. Every number below is a new placeholder in `layout.yaml`, not a constant in code.

The steps describe the result wanted. Where a step names a method, it is a suggestion; choose a better one if you find it, and say so in the report.

1. **Site.** The centre is the origin. Water comes from the brief as today. A river's line should bend gently between its arriving and leaving bearings instead of running straight; the sea keeps its side.
2. **Main roads.** One arterial from the centre to each exit, leaving town within a few degrees of the brief's bearing. Arterials bend: a low-frequency sideways drift, strongest in the middle and zero at both ends. An arterial that meets the river crosses it at a right angle on a `bridge` segment. In a port town one arterial-width quay street follows the water.
3. **The ground the town covers.** The area needed is the lots' area plus streets, as today. The outline is not a rectangle: land is cheaper to take the closer it is to the centre, to an arterial and to the water, so the town reaches out along its roads and thins between them. The outline is one piece, never crosses water except at bridges, and has a ragged edge.
4. **Side streets.** Streets branch from the arterials and from each other at irregular spacing and keep going until they meet another street, the water, the wall or the outline. A street follows the local grain, which is the direction of the nearest arterial or bank and turns towards radial near the centre, with some drift. A street that ends near another joins it, so most junctions are T-shaped. Spacing is tighter near the centre than at the edge.
5. **Lanes and courts.** Blocks too deep for their lots are split by a `lane`, or entered by a dead-end court. This keeps lanes and dead ends in the town for the vagrants and for the look.
6. **Blocks.** A block is a face of the street graph. Blocks are whatever shape the streets leave: no two need match.
7. **Districts.** Each district takes a connected group of blocks whose street frontage and area fit its lots. The grid's placement rules carry over unchanged: centre in the middle, the visitors' quarter beside it, harbour on the water, outskirts at the edge, and each tier's district preferences.
8. **Lots.** Lots line the streets around a block, each with its pack frontage on the street and running back towards the middle of the block. Side boundaries are roughly square to the street, so along a bent street lots fan and are not rectangles. Land left in the middle of a block is open ground. The grid's arrangement rules carry over: streets of one trade, spread civic buildings, housing near work.
9. **Entrances.** A lot's entrance is the point on its street's centre line nearest the middle of its frontage.

Three properties matter more than the method.

- **The density holds.** A lot keeps roughly its pack area, so a town covers about the land it does today and walks stay about as long.
- **Everything is reachable.** The street graph is connected, including across the river and through the wall.
- **It cannot fail.** The grid retries with a bigger grid when the town does not fit. The grown generator needs the same: if lots are left over, extend the outline and grow more streets. All 682 settlements must generate.

## Walls, gates and the plaza

Both features use buildings the city already makes, so the city generator does not change.

**Walls.** A town flagged `walls` already has 2 to 8 gatehouses, staffed by gate guards.

- The wall is one ring around the older part of town, drawn before the side streets so that streets grow against it. It follows a smoothed outline, not the ragged edge.
- It encloses a share of the town's ground set in the pack (start at 75%). The rest lies outside as suburbs along the roads. In a town below a pack size (start at 1,000 residents) the wall encloses everything.
- Streets cross the wall only at gates. The number of gates is the number of gatehouses: one where each arterial crosses, then the remainder as lesser gates placed to split the longest gateless stretches. If a town has more arterial crossings than gatehouses, report it; do not change the city.
- Each gatehouse's lot stands at its gate, just inside the wall. Gatehouses keep the district the city gave them.
- At a river the wall stops at each bank; at the sea it ends at the shore. Neither needs a gate.
- A wall has a width from the pack. No lot or footprint overlaps it, and a clear strip of pack width stays open on the inside.

Gates matter for more than looks. Everyone entering or leaving the walled part walks through one, so travellers, carters and commuters from the suburbs will bunch there without any rule saying so.

**Plaza.** A town flagged `plaza` already has one market square, an open-air landmark in the centre.

- Its lot becomes the plaza: an open polygon at the centre, sized from the pack by population between a minimum and a maximum, replacing its fixed 50 by 44 m lot.
- Every arterial ends at the plaza's edge. A street runs all the way round it, and the lots facing it are the centre's best frontage: put the centre district's landmarks and richest trades there first.
- A town without the flag has no plaza. Its arterials meet at a plain junction.

**Format additions.** `LAYOUT_VERSION` becomes 5.

| Addition | Shape |
| --- | --- |
| `walls` | A list, empty for most towns. Each wall: id, a line (closed, or open where it meets water), a width, and its gates. Each gate: the junction where a street passes through, the gatehouse building's id, and whether an arterial uses it. |
| `places` | A list of open places people can stand in. For now only the plaza: id, polygon, the building id of the market square it belongs to. |
| Junction kind `gate` | A junction on the wall's line. Paths through it work like any other junction. |
| Summary | `generator: "grown"`, counts of walls, gates and places, and the area inside the outline. |

The grid generator emits empty `walls` and `places` lists, so both generators satisfy one schema.

## What must keep working

The layout format is the seam, so most of the code should not notice. These are the places it might.

- **Bent segments.** Paths, positions along a segment, travel interpolation, wander, street stops, sleeping places, the avatar's walk and the nearby query have only run on straight segments. Before writing the generator, feed them a hand-made layout with bent segments and fix what breaks. Distance along a segment is length along its polyline, never the straight line between its ends.
- **The grid's assumptions.** Search for anything that assumes axis-aligned streets, rectangular lots, or a fixed block size outside `grid.ts`: lot sides, district polygons, label points, bounds, the spacing rules for civic buildings, streets of one trade, and where vagrants sleep.
- **Shared code.** Move what both generators need (district placement, lot arrangement, exits, water) out of `grid.ts` into shared modules. Do not copy it.
- **Invariants.** `layout/invariants.ts` runs on both generators. Add: no lot overlaps another lot, a roadway, water, a wall or a place; every lot touches the street its entrance is on; every segment's first and last points are its junctions' positions; streets cross a wall only at gates.
- **Life and outsiders.** Their rules do not change, but every walk does, so `LIFE_VERSION` goes to 6 only if life code changes. Day plans will differ from today's because paths differ; the checks that matter are the invariants and the magnitudes in the acceptance tests.
- **Stored state.** A saved avatar position refers to a segment or building of the old layout. The layout version already guards this; confirm an avatar saved under version 4 is reset cleanly and not left on a missing segment.
- **Baselines.** Layout baselines are regenerated for `grown`. Keep one grid baseline so the grid stays tested.

## Rendering and the viewer

**A render command.** Add `npm run render -- <settlement id> [--generator grid|grown] [--seed n] [--out file.svg]`. It writes one SVG of the town with no people: water, outline, streets by kind, lots tinted by district, the wall and gates, the plaza, exits labelled with where they lead. The drawing code is a pure function in core that takes a layout and returns SVG text; the command is a thin wrapper.

This is how the user and the reviewer judge the result without starting the server. Commit renders of Badanos, Pombal, Vereceldo, Cevilefon and Flupines to `docs/renders/`, each beside its grid render.

**Viewer.** Keep the minimalist style: flat fills, thin lines, no texture.

- Streets are drawn along their polylines with round joins and caps, so bends and junctions have no gaps or spikes.
- Lots are drawn from their polygons. Hover, selection and the bounding outline must work on any polygon, not only rectangles.
- The wall is a thick dark line with a gap and a small marker at each gate. The plaza is a pale paved fill.
- People walking a bent street follow the bend. Check this by eye at 30x.
- The town pane gains the generator's name, the wall's gate count, and the plaza's area where they exist.
- A `?generator=grid` query on the town page shows the grid layout of the same town, for comparison. It is a viewing aid; the stored world still uses the pack's setting.

## Tasks

In this order. Each ends with the tests green. Tasks 3 and 5 end with renders committed, because those are the two points where a look can save the most work.

1. **Harden for bent streets.** A hand-made layout fixture with bent segments, a dead end and a bridge; run paths, positions, wander, stops, the avatar and the nearby query over it; fix what breaks.
2. **Format and shared code.** Add `walls`, `places`, the `gate` junction kind and the summary fields; bump `LAYOUT_VERSION` to 5; move shared steps out of `grid.ts`; add the generator setting to the pack schema and `layout.yaml`; add the new invariants. The grid still passes everything.
3. **Render command, then the skeleton.** The SVG renderer and command first, with grid renders committed. Then the grown generator's steps 1 to 3 plus the wall line and plaza: site, arterials, outline. Commit skeleton renders of the five towns.
4. **Side streets, lanes and blocks.** Steps 4 to 6, with gates.
5. **Districts and lots.** Steps 7 to 9, with the arrangement rules carried over and the cannot-fail loop. Commit full renders of the five towns.
6. **All of Lomia.** Generate all 682 settlements with `grown`; fix failures; record the time.
7. **Life on the new streets.** Run life, outsiders and avatar tests on `grown`; re-measure the magnitudes in the acceptance tests; make `grown` the default.
8. **Viewer.**
9. **Tune by eye.** Adjust the placeholders in `layout.yaml` until the five renders look like towns. Note in the report which numbers moved and why.
10. **Document.** README section, CLAUDE.md layout notes, regenerated baselines, final renders.

## Acceptance tests

Default seeds, `grown` generator, unless a row says otherwise. Rows marked *estimate* are my guesses at what a natural town measures: if one fails, report the measured value and why; do not loosen the rule or bend the generator to hit it.

**Correctness**

| Test | Passes when |
| --- | --- |
| Schema and invariants | Every layout of all 682 settlements parses and passes every invariant, old and new |
| Nothing lost | Every building has exactly one lot; lot counts equal the grid's (Badanos 1,825; Pombal 8,632; Vereceldo 65; Cevilefon 3,606; Flupines 95) |
| City untouched | `GENERATOR_VERSION` is 5 and the city baselines are byte-identical |
| Determinism | Same brief, pack and seed give a byte-identical layout twice; another seed gives a different one |
| Connected | A path exists between every pair of lots in each of the five towns (sampled in Pombal) |
| Exits | Each exit lies within 5° of its brief bearing, seen from the centre, and its arterial reaches the centre or the plaza |
| Water | No lot or street other than a `bridge` overlaps water; Badanos and Pombal each have at least one bridge |
| Grid kept | The grid generator still passes its own tests when selected |
| Bent streets | On the hand-made fixture, a walker's position at every sampled time lies on the polyline, and distance walked equals speed times time |

**Shape.** Grid values are from the Context table.

| Test | Grid | Passes when |
| --- | --- | --- |
| Street directions, Badanos and Pombal | 61 to 63% in one 15° bin | No 15° bin holds more than 25% of street length (*estimate*) |
| Four-way junctions, Badanos and Pombal | 86%, 91% | At most 35% of junctions with 3 or more streets have 4 or more (*estimate*) |
| Bent arterials | 0% | Every arterial longer than 200 m deviates from the straight line between its ends by at least 3% of its length (*estimate*) |
| Dead ends, Badanos | 2 junctions | Between 3% and 15% of junctions are dead ends (*estimate*) |
| Lanes | 139 in Badanos | Every town above 1,000 residents has `lane` segments |
| Lot shapes, Badanos | 100% rectangles | At most half the lots are exact rectangles (*estimate*) |
| Lot size | exact | Each lot's area is within 25% of its pack frontage times depth, and its street frontage is at least 60% of the pack frontage (*estimate*) |
| Density, five towns | 252, 259, 157, 224, 181 | Residents per hectare of lot area within 15% of the grid's |
| Outline | rectangle | The outline's area is at most 80% of its bounding box in Badanos and Pombal (*estimate*) |
| Streets of one trade, Badanos | 65% | Report the value; it should not fall below 60% |

**Walls and plaza**

| Test | Passes when |
| --- | --- |
| Who has them | A layout has a wall exactly when the brief is flagged `walls`, and a plaza exactly when flagged `plaza`; Badanos and Flupines have neither |
| Gates | Gates equal gatehouses in every walled settlement; each gatehouse lot is within 30 m of its gate; no segment crosses a wall except at a gate |
| Through the gate | In Pombal and Cevilefon, every path from a lot outside the wall to a lot inside passes a gate junction |
| Suburbs | Pombal and Cevilefon have lots outside the wall; Vereceldo has none |
| Plaza | In Pombal and Cevilefon every arterial ends on the plaza's edge and the plaza's area is within the pack's bounds |

**Life on the new streets.** Badanos, day 1 and work days 8 to 13.

| Test | On the grid | Passes when |
| --- | --- | --- |
| Life, outsiders and avatar suites | pass | Pass unchanged in what they assert, on `grown` |
| Trips per resident | 3.69 | Within 10% |
| Mean trip length and duration | measure first | Report both generators; `grown` within 30% of the grid (*estimate*) |
| People to be seen at 12:00 | 1,255 | Within 20% |
| Travellers in town | 64 to 81 | Unchanged: the layout does not affect who arrives |
| Wells | none share a street | No two wells within the pack's spacing distance of each other |
| Vagrants at 03:00 | 29 asleep on streets | All 29 asleep at a lane, a bridge end, a gate or the town's edge |

**Cost**

| Test | Grid here | Passes when |
| --- | --- | --- |
| Time to generate one layout | Badanos 116 ms, Pombal 297 ms | Badanos under 1 s and Pombal under 4 s on your machine (*estimate*); report both |
| All of Lomia | measure first | Report the total for 682 settlements on both generators |

**By eye.** The ten committed renders, five grid and five grown, are the last test. The user decides this one.

## Rules and reporting

CLAUDE.md's standing rules apply. The ones this phase leans on:

- **Core stays pure.** The generator and the SVG renderer take inputs and return values. No clock, no files, no unseeded randomness; only the render command touches the disk.
- **The brief is the only world input.** The wall, the plaza and the port quay come from the brief's flags, nothing else.
- **No setting knowledge and no numbers in code.** Spacings, drift, the walled share, plaza sizes and wall widths live in `layout.yaml` with a comment each, all marked as placeholders.
- **Derived, not stored.** A layout is still a pure function of city, brief, pack and seed.
- **Geometry by hand or by a small pure library.** If you add a dependency for polygon clipping or triangulation, it must be deterministic across platforms, and the report says why it was needed.

**Report back with**

1. The acceptance tables with measured values, grid beside grown, and every estimate that missed with the reason.
2. The method chosen for each generator step where it differs from the suggestion.
3. The ten renders, and which `layout.yaml` numbers were tuned by eye.
4. Anything in life, outsiders or the avatar that broke on bent streets and how it was fixed.
5. Settlements that needed the cannot-fail loop, and any that look wrong: a tiny walled village, a town with four exits on one side, a port on a river.
6. What you would do differently in the generator given another pass. Phase 6E builds on it, so this is the time to say.

