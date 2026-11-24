# Open problem: district ground in the staged town generator (Phase 6E)

Written 2026-11-24. **Status: stopped, to be looked at again.** This brief
assumes no context. Read `CLAUDE.md` for the project's standing rules and
`sim-6e.md` for the gameplan.

- `main` (this file) is the last state where `npm run check` passes:
  643 of 682 settlements pass every layout invariant.
- Branch `6e-district-rules` holds the user's approved rule changes and the
  fixes made after them: 657 of 682 pass. The full check has **not** been
  run on that branch.

## The problem in one paragraph

The staged generator (`packages/core/src/layout/staged/`) lays out all 682
settlements of the Lomia test world. Everything about streets, walls,
gates, water, lots and houses passes everywhere. What fails, in 25 to 40
settlements depending on the rules, is **district ground**: the polygons
that say which district a piece of town belongs to. Some buildings stand
in ground that is not their own district's, or not next to it. The pack
keeps naming the old grid generator until this passes in all 682.

## Why it keeps coming back

Over nine rounds the pass count went 397, 582, 589, 637, 643, 650, 655, 657.
Each round found a real fault, fixed it, and uncovered the next. The faults
differ; the shape does not. The question for the next attempt is whether
the design should change, not which patch comes next.

The current design has **three separate answers to "which district is
this?"**, made at different stages from different information, and
reconciled afterwards:

1. **Wards** get a district when districts are grown over the mesh
   (`districts.ts`). This uses ward area and adjacency, before any house
   exists.
2. **Houses** get a district in selection (`selection.ts`). The town keeps
   houses by rank, town-wide. Each district's count must then be made
   exact. That is done by moving blocks across borders, chains of block
   moves, single houses at borders, then a counted fallback that ignores
   borders.
3. **Ground** gets a district when the layout is written (`layout.ts`,
   `districtGround`). Each block's tile goes to the district most of its
   lots belong to. Pieces are then re-owned until each district is one
   piece, first on the tile graph and again on the drawn polygons.

Every failure is a disagreement between two of these answers:

- Districts are grown on ground whose houses selection then does not keep,
  so a district is short. It borrows across a border, or through the
  fallback from anywhere.
- A borrowed house's lot stands in the lender's ground. If the lender is
  not beside the borrower, the lot fails.
- Re-owning a tile to keep one district in one piece moves its lots out of
  their own district's ground, which pushes another district over the 3%
  limit.
- Landmarks (plaza, castle, a temple's block) belong to a district by the
  city's say-so but stand where the layout put them. A strip of ground
  joining one to its district can cut a third district in two.

Each fix so far made two of the answers agree in one more case. None
removed the need to reconcile.

## Rules in force

From the user, on `main`:

- A district's ground is one connected piece; grounds do not overlap.
- At least 97% of a district's lots lie in its own ground.
- A lot outside its own ground lies in a district whose ground touches its
  own.
- A waterside district's ground comes within 40 m of the water.
- Blocks, then single houses, change district only across a touching
  border. Chains are allowed. No house is dropped or added. A short
  district with no touching neighbour takes from the nearest district,
  and that fallback is counted.

Approved later; on the branch only:

1. One connected piece **per bank**. Pieces on different banks must be
   joined by a bridge link. No ground is drawn across water, and the
   strips that crossed bridges are removed.
2. A lot outside its own ground may also lie in a district joined to its
   own by a bridge link. Single houses may cross a bridge link.
3. The limit is 97%, or all but 2 lots, whichever allows more.
4. A bridge link reaches past a landmark's block to the next block along
   the road.
5. The district that owns the market square is seeded beside the plaza.
6. No new passes.

## Where the branch stands

Over all 682 settlements, 657 pass every invariant and 25 fail:

| Fails | Settlements |
| --- | --- |
| A lot lies in ground that neither touches its own nor is bridge-linked to it | 21 |
| More than 3% (and more than 2) of a district's lots lie outside its ground | 20 |

- The non-touching fallback is used in 17 settlements, for 1,372 houses.
- Every failing settlement has a river, so towns astride water are the
  hard case.
- All settlements under 500 people pass, and so do Badanos and Boytayay.
  Pombal fails on one temple and 19 lots.

### The failing settlements and their causes

Taken from a classifier run on the branch, which was stopped partway, so
the list is incomplete. It sees at most the first 20 problems of each town.

Tags used in the table:

- **fallback**: a lot in a house given by the non-touching fallback.
- **drawn elsewhere**: a lot in its own district's block, but the block's
  tile was re-owned to keep some district in one piece.
- **over limit (n/m)**: n of a district's m lots lie outside its ground.
- **gatehouse**: a gatehouse with no gate of its own, standing at another
  district's gate.
- **landmark**: a landmark standing apart from its own district.

| Settlement | Fallback houses | Causes |
| --- | --- | --- |
| Klauka | 0 | over limit (14/303) |
| Sunde | 0 | gatehouse |
| Pombal | 0 | drawn elsewhere ×19; landmark (temple's block) |
| Karlen | 268 | drawn elsewhere ×17; over limit; landmark (market square, town hall) |
| Karpeysk | 8 | fallback ×8; drawn elsewhere ×4; over limit (5/41) |
| Vasetbo | 0 | gatehouse |
| Ruha | 96 | fallback ×18; landmark (citadel); over limit |
| Joen | 0 | landmark (citadel); over limit ×2 |
| Courceauligy | 57 | fallback ×19; over limit |
| Tames | 0 | gatehouse; over limit (5/157) |
| Tiorpanki | 46 | fallback ×17; over limit ×3 |
| Borfino | 14 | fallback ×14; over limit ×3 |
| Nuvusvaa | 66 | over limit (79/264) and one more; fallback ×2 |
| Batimanchy | 0 | over limit (8/239) |
| Ririm | 150 | fallback ×19; gatehouse |
| Horncesham | 184 | drawn elsewhere ×13; fallback ×4; over limit ×3 |
| Mevezomaz | 0 | over limit ×2 |
| Chawbume | 56 | fallback ×12; over limit ×2 |
| Haurinen | 3 | fallback ×3 |

The classifier was stopped before it reached the rest. A run on slightly
earlier branch code also failed Ertin, Bemegoro, Feins, Lilov, Gasilnik
and Tuvaaki: fallback houses, lots over the limit, and blocks moved across
a border the ground then lost.

### Cause 6, run down

Cause 6 was "drawn ground apart although the tiles are neighbours".

- **Strips across other districts.** A castle or other landmark standing
  amid another district was joined to its own by a 2 m strip drawn
  straight across. The strip cut the other district in two. Strips now
  never cross water or another district's ground. Mevezomaz went from
  about 125 lots off their ground to 1.
- **Hairs on divided tiles.** Dividing a tile left hair-thin slivers that
  made two tiles neighbours on the tile graph but not when drawn. Hairs
  are now removed when a tile is divided. Horncesham went from 64 lots
  to 10.

What remains of cause 6 is landmark ground whose strip is now refused, so
the landmark stands apart. That is the **landmark** cause above.

## Directions worth weighing before more patches

These change the design, so they are the user's call.

- **One answer instead of three.** Choose the kept houses first. Then grow
  districts over *kept houses or blocks*, not wards, to the exact count,
  as connected regions. Ground then follows the blocks with no vote and
  no re-owning. Exact counts and connected ground come from one process,
  not three reconciled ones. The cost: district character (house size,
  lane density) is set per ward before houses exist, so it would need to
  be set some other way, or the houses re-laid after districts are known.
- **Make the ground follow the lots, not the blocks.** Draw each
  district's ground as the union of its own lots plus the open ground
  nearest them, for example a Voronoi of lots clipped to the town. Every
  lot is then inside its own ground by construction. The remaining
  question is only whether that ground is one piece per bank. Borrowed
  houses would make ragged borders.
- **Grow districts per bank.** No bank is asked for more houses than
  selection keeps there, so the fallback across water mostly disappears.
  This keeps the current design and addresses the largest single cause.
- **Seed every landmark's district beside the landmark**, as the plaza's
  now is: the castle, and block landmarks such as a temple or town hall.
  This removes the landmark cause.
- **Exempt gatehouses**, wherever they stand, from the "touches" rule. A
  gatehouse standing at another district's gate is a fact of the wall,
  not a fault of the districts.

## How to measure

```sh
node scripts/staged-census.ts            # all 682, about 6 minutes
node scripts/staged-census.ts 12 --towns # the sample of 57, about 30 s
node scripts/render-staged-layout.ts docs/renders try Pombal Ruha Karlen
npm run check > check.log 2>&1; echo "exit $?"   # about 5 minutes
```

## Where the code is

| File | What it does |
| --- | --- |
| `staged/districts.ts` | `growDistricts`: seeds, ranking, claims over wards |
| `staged/selection.ts` | `chooseHouses`: the town-wide choice, block moves, chains, single houses, fallback |
| `staged/tiles.ts` | `tileBlocks`: a tile per block, adjacency, hairs; `bridgeLinks` |
| `staged/layout.ts` | `districtGround`: votes, divided tiles, re-owning, strips, the drawn polygons |
| `layout/invariants.ts` | The district-ground rules |
