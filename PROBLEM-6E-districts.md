# Open problem: district ground in the staged town generator (Phase 6E)

Written 2026-11-24, at commit `0592d8e`. This is a self-contained brief for
someone picking the problem up cold. Read `CLAUDE.md` first for the project's
standing rules; `sim-6e.md` is the gameplan this work belongs to.

## The one-paragraph version

The staged town generator (`packages/core/src/layout/staged/`) lays out all
682 settlements of the Lomia test world. 643 of them keep every layout
invariant. The other 39 fail only the rules about **district ground**: some
buildings end up standing in ground that is not their own district's. Until
all 682 pass, the pack keeps naming the old grid generator as the default.
The goal is to get the 39 to pass without breaking the user's rules below,
or to show which rule has to give and put that to the user.

## Background you need

A city (people, households, buildings, districts) is generated first and is
fixed: the layout may not add, remove or change a building, or move one to
another district. Each building belongs to exactly one district, and each
district has an exact building count.

The staged generator then builds the town in stages, each final:

1. Water, highways, bridges, wall, plaza and castle.
2. A Voronoi mesh of **wards**; main streets along mesh edges.
3. Districts are grown over wards (`districts.ts`, `growDistricts`): each
   district starts at a seed ward and claims neighbours until its wards have
   room for its buildings.
4. Each ward is cut into **blocks**; rows of rectangular houses are laid in
   every block. About 2.5 to 3 times more houses are made than the town
   has buildings.
5. **Selection** (`selection.ts`, `chooseHouses`): the town keeps exactly as
   many houses as it has buildings, chosen town-wide by growth rank (centre
   first, inside the wall first, thinning at the edge). This decides which
   houses exist. Nothing later may drop or add a house.
6. Selection then makes each district's count exact by moving **blocks**,
   then **single houses**, between districts. This is where the problem
   lives.
7. Fitting gives each building a kept house in its district (`fitting.ts`).
8. The layout is written (`layout.ts`): walking network, lots, gates, and
   each district's **ground**, drawn from a tile per block (`tiles.ts`).

## The invariant (set by the user; `layout/invariants.ts`)

- Each district's ground is one connected piece, and grounds do not overlap.
- At least 97% of a district's lots lie inside its own ground.
- A lot outside its own ground lies inside a district whose ground touches
  its own (within 0.5 m).
- A waterside district's ground comes within 40 m of the water.

A lot whose wall lies exactly on the ground's edge counts as inside (it is
tested drawn in by 2 cm). That tolerance was added during this work because
two terraced houses of different districts share a wall.

## The user's rules for step 6 (do not change these without asking)

- A block changes district only where its ground touches the taker's.
- Chains are allowed: surplus flows through intermediate districts across
  shared borders.
- After block moves, each district's count is made exact by moving single
  houses between districts, only at a shared border.
- Never drop or add a house; the town-wide selection decides which exist.
- If a short district has no touching neighbour with spare houses, take
  from the nearest district and **count the case** (`selection.fallback`).
- Houses are never clipped; landmarks' blocks never change district.

Decisions the implementation added on top, which the user has been told
about but which are not the user's own rules:

- A block is never taken if its loss would split the district that gives it
  (`whole`).
- The two blocks at the ends of a bridge count as touching for whole-block
  moves. Single houses never cross a bridge.
- A district grows only from its **body**, the largest connected piece of
  its blocks; a stray block (other than a landmark's) is first handed to the
  district whose body it touches.
- A short district first absorbs unbuilt blocks between it and the nearest
  houses (`reachHouses`).
- A thin district that can give nothing is passed through and thickened
  first; a stopped chain is retried (up to `THICKENINGS` = 8).
- Single houses move in two passes: first only from a block that could
  change district itself; then, for a district still short, from any border
  block that keeps most of its own houses.
- A block whose houses belong to two districts has its tile divided between
  them in the drawn ground, unless dividing would part its own district.

## Where things stand

Measured over all 682 settlements. A settlement can appear in several rows.

| Fails | Settlements |
| --- | --- |
| A lot lies in a district whose ground does not touch its own | 35 |
| More than 3% of a district's lots lie outside its ground | 25 |
| A lot lies outside every district's ground | 8 |
| Any of the above | 39 |

- The non-touching fallback is used in 31 settlements, for 2,631 houses.
- All 18 settlements under 500 people pass. Badanos, Pombal and Boytayay
  pass; Cevilefon, Karlen and Tames do not.
- The walking network, wall, gates and water invariants pass everywhere.
- No settlement needs the "take more ground" loop.

History of the pass count, for scale: 397, then 582 (touching-only moves),
589, 637 (districts kept whole, hairs of ground removed, tiles divided),
643 (thin districts passed through).

## What is known about the remaining 39

Only a handful of the failing towns were examined one by one, so the split
between these causes across the 39 is **not measured**.

1. **Towns astride a river where one bank is starved.** Selection keeps
   houses by rank, town-wide. District growth hands out wards by adjacency
   and room. On the far bank the two disagree: districts are given ground
   whose houses the town mostly does not keep.
   - *Inillanue* (settlement-109): four far-bank districts want 1,384
     houses; the town keeps 661 there. Fallback 423 houses.
   - The only way to supply them is across the bridges.
2. **A landmark's block at the bridgehead.** The bridge link joins the two
   tiles nearest the bridge's ends. If one of them is a landmark's block,
   which never changes district, nothing can cross.
   - *Montica* (three districts, one bridge): 101 spare houses on one bank
     cannot reach the other.
3. **Single houses cannot cross a bridge.** After block chains finish,
   leftovers of about 20 houses per district remain on each bank.
   - *Ruha*: far-bank districts each hold about 20 spare; near-bank ones are
     each about 20 short. Fallback 176.
4. **A plaza or castle that belongs to a district it does not stand in.**
   The city generator says which district owns the market square; the
   layout puts the plaza at the centre regardless.
   - *Klauka*: the market square is district 2's but stands amid district 1,
     and the two grounds do not touch.
5. **Small districts just over 3%.** A visitors' quarter of 39 buildings is
   allowed one lot outside. *Klauka*: 3 of 39.
6. **Drawn ground apart although the tiles are neighbours.** A divided
   tile's part can take the edge its parent shared with a neighbour. Seen in
   Klauka (district 5); not run down.

The last change (thin districts, second house pass) lowered the "does not
touch" row by 5 but raised the other two rows by 5 each. Which of the two
changes did that was not determined.

## Things tried that did not work

- **Letting any border block give houses while it keeps a majority, with no
  wholeness check, as the only house rule.** Cut the fallback but put more
  lots off their ground. It is now the second pass only.
- **Restricting district growth to the "town proper" wards** (those ranked
  inside 1.3 times the building count) while districts take what they need.
  Made Inillanue worse (fallback 645 to 704). Reverted.
- **Using block-only bridge links for the drawn ground as well as for
  selection.** The strip of ground across the bridge then crossed foreign
  blocks and whole banks were re-owned. Reverted; both now use the tiles
  nearest the bridge ends.
- **A separate "block adjustment" pass after selection** (branch
  `6e-step8-wip`, deleted). It thrashed: districts became ribbons.

## Options not yet tried

- **Let a bridge link reach past a landmark's block** to the next block
  along the road, and let single houses use bridge links. The ground would
  need a strip along the road rather than only across the water. Smallest
  change; addresses causes 2 and 3.
- **Seed and grow districts per bank**, so no bank is asked for more houses
  than selection will keep there. Addresses cause 1 at the root, but changes
  how districts are placed, which is a user-facing design change.
- **Make district growth aware of selection** more directly: estimate, per
  ward, how many houses will be kept (rank against the keep threshold)
  instead of using area. Today `roomIn` is area over `perHouse`.
- **For cause 4**, either make the plaza's district the one grown at the
  heart of the town, or exempt special wards from the "touches" rule. The
  second is a rule change and is the user's call.

## Constraints that bite

- `core` is pure and deterministic: no clock, no unseeded randomness; same
  inputs give byte-identical output.
- No loops except "take more ground", at most three times. Bounded passes
  and bounded retries with a fixed count have been accepted so far.
- No hard-coded numbers that are setting data: those live in
  `packs/medieval/layout.yaml` under `staged`. Geometric tolerances
  (`HAIR`, `TOUCH`, `ON_THE_EDGE`) are constants in code today.
- Polygon arithmetic only through `staged/shapes.ts` (wraps `clipper2-ts`).
- Stay inside the gameplan's scope; if a rule has to change, stop and ask
  the user with evidence.
- Do not weaken `packages/core/test/boundaries.test.ts`.

## How to measure

Node 24 or newer runs the TypeScript directly.

```sh
# The table above: all 682 settlements, about 6 minutes.
node scripts/staged-census.ts

# The sample of 57 used while working (every 12th), about 30 seconds,
# with each failing town's first problem.
node scripts/staged-census.ts 12 --towns

# Draw towns as the staged generator lays them out, with what each breaks.
node scripts/render-staged-layout.ts docs/renders 6e-step10 Inillanue Montica Ruha Klauka

# Tests for this area (about 3 minutes and 1 minute).
npx vitest run packages/core/test/staged-town.test.ts
npx vitest run packages/core/test/staged-layout.test.ts

# Before calling anything done (about 5 minutes). Capture the exit status;
# do not pipe it through tail before committing.
npm run check > check.log 2>&1; echo "exit $?"
```

The viewer shows a staged layout beside the grid's with
`?generator=staged` before the `#`.

## Where the code is

| File | What to read |
| --- | --- |
| `staged/selection.ts` | `chooseHouses`: town-wide choice, then `embody`, the rounds, `reachHouses`, the chains, the two single-house passes, the fallback |
| `staged/districts.ts` | `growDistricts`: seeds, ranking, claims; `wardsBeside`: what counts as adjacent and what crossing costs |
| `staged/tiles.ts` | `tileBlocks`: a tile per block, hair removal, adjacency; `bridgeLinks` |
| `staged/layout.ts` | `districtGround`: votes, dividing tiles, one-piece passes on the tile graph and then on the drawn polygons, bridge strips |
| `staged/plan.ts` | `planTown`: how the stages are wired, and what selection is given (`beside`, `touching`, `fixed`) |
| `layout/invariants.ts` | The district-ground checks and their messages |
| `packs/medieval/layout.yaml` | The `staged` block: `districts`, `selection` |

## What a good answer looks like

- The census table with the pass count and the fallback count, before and
  after, over all 682.
- No regression in the rows that are already zero, and `npm run check`
  green.
- Any rule that was bent named plainly, with the settlements that needed it.
- If the answer is "a rule must change", the smallest change, the evidence,
  and the settlements it would fix, put as a question to the user.
