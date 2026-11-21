# World Sim — Phase 6B.5 Gameplan

Nov 21, 2026 · @seal

Phase 6B.5 is a patch to how a town is divided into districts: everyday buildings in every district, housing mixed with work, the wealthy placed sensibly, and trades gathered along streets. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Make a town's districts mixed the way such towns were: every district has its own baker, tavern, shop and chapel; people live near where they work; the wealthy live toward the centre; and a trade lines a street instead of being scattered through a quarter.

**Done when:** all acceptance tests below pass, and in Badanos no district is a pure dormitory or a pure workshop zone, and no mansion stands among the tenements.

## Context

Phases 1 to 6B are complete. Read `CLAUDE.md`, the README, and the `city` and `layout` modules before starting, in particular how the city generator assigns buildings to districts and how phase 6B spreads civic buildings by population.

**Badanos today** (`settlement-641`, default seed, generator version 3):

| District | Residents | People working there | Taverns | Bakeries | General shops | Chapels | Mansions and noble houses |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bank Market (centre) | 1,825 | 717 | 13 | 0 | 30 | 13 | 0 |
| Old Market (centre) | 1,809 | 736 | 15 | 0 | 29 | 13 | 0 |
| Mill Row (craft) | 1,245 | 1,160 | 0 | 24 | 0 | 0 | 0 |
| Ford Street (common) | 2,164 | 58 | 0 | 0 | 0 | 0 | 0 |
| Ford Bottoms (lower) | 1,941 | 151 | 0 | 0 | 0 | 0 | 10 |
| Upper Fields (outskirts) | 623 | 1,597 | 0 | 0 | 0 | 0 | 0 |

**What is wrong.**

- **Zoning is too clean.** Every building goes to the district its type prefers. All 28 taverns and all 26 chapels are in the two centre districts, and all 24 bakeries are in the craft district. Ford Street houses 2,164 people and has no tavern, baker, shop or chapel.
- **Homes and jobs are apart.** Ford Street has 58 jobs for 2,164 residents; Upper Fields has 1,597 jobs for 623 residents.
- **The wealthy are in the poorest district.** Badanos has no upper district, and all its mansions and its noble house fell through to Ford Bottoms, among tenements and laundries.
- **A trade is scattered within its quarter.** Along a Mill Row street the forges and leather shops alternate, where a real town would have a street of smiths and a street of leatherworkers.
- **A workshop with a family living in it reads as a shop only.** 295 of Mill Row's 309 buildings are homes as well as workshops, and nothing on the map says so.

**What is right and must stay.** Craftsmen living over the shop, trades gathered in a quarter, and noxious trades such as tanning kept to the outskirts.

**This patch moves buildings between districts and lots. It does not create or remove any.** Population, workforce, category counts, occupation counts and the number of buildings of each type must all stay exactly as they are.

## Scope

**Change**

- District assignment in the city generator
- The order in which the grid layout generator gives lots to buildings inside a district
- The pack: which types are spread, where each status tier prefers to live, and how much housing mixes with work
- Labels and drawing for buildings that are both home and workplace
- The test runner's default timeout

**Do not change**

- Who exists, what they do, where they work, or which building a household lives in
- The street graph, the outline of the town, lot sizes or footprints
- Daily life. `LIFE_VERSION` stays 4; plans change only because the town they are computed for has changed.

**Do not build**

- New building types, occupations or visits
- Street names
- A tourism district, travellers or vagrants; that is phase 6C
- Organic streets or building shapes

## Changes

### 1. Everyday buildings in every district

**Rule.** A workplace type may be marked `spread` in the pack, with the same meaning it has for civic buildings: its buildings are shared out among districts in proportion to their residents.

- In the `medieval` pack mark the types people use daily: tavern, bakery, butchery, general shop, chapel and healer's house, as placeholders.
- A spread type with a household living in it keeps that household; the home moves with the shop.
- Types that are not spread keep their district preference. Tanneries stay on the outskirts.

### 2. Housing near work

**Rule.** A share of dwellings is placed in the district where the household's head works, instead of the district the dwelling's status tier prefers.

- The share comes from the pack, as one number with optional values per district kind. A kind may be closed to this, so that a household is never moved somewhere the pack says nobody lives.
- Which dwellings are chosen is seeded. A dwelling with several households follows the head of the first.
- The household stays in its building. Only the building's district changes.

### 3. Where each status tier lives

**Rule.** Each status tier has an ordered list of district kinds it prefers, in the pack. A dwelling goes to the first kind on its tier's list that the settlement has.

- In the `medieval` pack the wealthy and noble prefer an upper district, then the centre, and never the lower or outskirts kinds while anything else exists. The poorest prefer lower, then common, then outskirts.
- This replaces whatever fallback puts Badanos's mansions in Ford Bottoms.

### 4. Streets of one trade

**Rule.** Inside a district, buildings of the same type are given neighbouring lots, so that a trade lines a stretch of street.

- This is a change to the order in which the grid generator hands out a district's lots. The lots themselves, and everything else about the layout, stay as they are.
- Spread types are the exception: within a district they are placed apart from each other, so that the district's three taverns are not side by side.
- Dwellings fill in around the working buildings.
- Raise `LAYOUT_VERSION` to 3.

### 5. Homes that are workshops

- A building in which a household lives and people work is named as both wherever it is named: "Forge and home". The wording is a pattern in the pack.
- On the map such a building is drawn so that it can be told from a plain dwelling and from a plain workplace, by outline or marking and not by colour alone.
- Its panel lists the household that lives there as prominently as the people who work there.

### 6. Test timeouts

Six tests timed out on a slower machine at the test runner's default limit of 5 seconds; all 700 pass with a longer limit. Set a generous default timeout in the test configuration, once, so that slow hardware cannot fail a correct build.

### Versions

`GENERATOR_VERSION` to 4, `LAYOUT_VERSION` to 3, and the pack's version raised. `LIFE_VERSION` stays 4. Record a new Badanos baseline with a note of what moved.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Test timeout.** Change 6, first, so the rest of the work is not disturbed by it.
2. **Baseline.** Record for Badanos the table in the Context section, plus: the share of workers who live in the district they work in, the average length of a walk to work, and phase 6B's five target figures.
3. **Tier preferences.** Change 3.
4. **Spread workplaces.** Change 1.
5. **Housing near work.** Change 2.
6. **Streets of one trade.** Change 4.
7. **Labels and drawing.** Change 5.
8. **Measure.** Repeat task 2 and set the figures side by side in the README.
9. **Whole-world run, timing and wrap up.** README and `CLAUDE.md`.

## Acceptance tests

All of these are automated. Every existing test keeps passing, apart from those that pin district or lot assignments, which are updated with an explanation.

**Nothing created or destroyed**, for every one of the 682 settlements

- Population, workforce, category counts and occupation counts are identical to generator version 3.
- The number of buildings of each type is identical.
- Every household lives in the same building, and every worker works in the same building, as before.
- The street graph, the lots and their footprints are identical to layout version 2; only which building holds which lot differs.
- Every city and layout invariant holds.

**Spread**, for every settlement

- Each spread type is present in every district that has residents, wherever the settlement has at least as many buildings of that type as it has such districts.
- Within a district, no two buildings of a spread type are on neighbouring lots while a non-neighbouring lot was available.

**Tiers**, for every settlement

- No dwelling is in a district kind that its tier's list ranks below a kind the settlement has.

**Badanos, before and after**

| Measure | Now | Required |
| --- | --- | --- |
| Districts with residents but no tavern, bakery, general shop or chapel | 4 of 6 lack at least one | 0 |
| Mansions and noble houses in Ford Bottoms | 10 | 0 |
| Jobs in Ford Street, for its 2,164 residents | 58 | Higher; report the figure |
| Share of workers living in the district they work in | From task 2 | Higher; report the figure |
| Average length of a walk to work | From task 2 | Report the figure |
| Forges and leather shops in the craft district | 222 | Still the large majority of the town's; report the figure |
| Tanneries outside the outskirts | 0 | 0 |
| Share of non-spread working buildings whose neighbouring lot holds the same type | From task 2 | At least 70%. This is an estimate; report the figure |
| Phase 6B's five target figures | Met | Still met |

**Viewer**

- A building that is both home and workplace shows the pack's combined name on hover and in its panel, and is drawn differently from a plain dwelling and a plain workplace.

**Pack behaviour**

- With no type marked spread, no housing share and the old tier lists in a copy of the pack, the city is identical to generator version 3 apart from its version number.
- A housing share of 0 moves no dwelling for that reason; a share of 1 moves every eligible one.
- A tier list naming a district kind the pack lacks is rejected on load.

**Determinism**

- The same inputs give byte-identical cities and layouts.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this patch:

- **Move, never make.** No person, household, job or building is added, removed or changed. Only districts and lots are reassigned.
- **Keep each quarter's character.** Mixing is a share, not a blend. The craft district must still be recognisably the craft district.
- **Preferences are pack data.** Code must not know that the wealthy like the centre or that a tavern is an everyday building.
- **One baseline change, explained.** Record what moved and why, and confirm what did not.
- **Report, don't relax.** The 70% figure for streets of one trade is my estimate. If the grid's block shapes cap it lower, report the figure reached and why.

