# Districts after selection: what was built, and where it falls short (Phase 6F, Part B)

2026-11-25. For review. The gameplan is `sim-6f.md`, Part B; the 6E background is `PROBLEM-6E-districts.md`.

## In one paragraph

Part B replaces the three answers to "which district is this?" with one, made after selection: group the kept
blocks into banks, share each district's count among the banks, then grow each district over kept blocks within
its bank to exactly its count. Items 2 and 3 of the order of work are built. Exact counts, no fallback and
landmarks in their owner's ground all hold by construction. But districts come out in far more pieces than
before (972 against 287, target under 40), lots outside their own ground are 344 rather than 0, and 6
settlements break the waterside invariant. The default is unchanged: the new path is behind a pack switch that
is off. Item 4 (removing the old path) should not go ahead until the growth step is redesigned.

## What was built

All in `packages/core/src/layout/staged/`.

| Step (gameplan) | Where | State |
| --- | --- | --- |
| 1. Character plan | `districts.ts`: `growDistricts` renamed `forecastDistricts`, `DistrictPlan` → `DistrictForecast`, `plan.districtPlan` → `plan.forecast` | Done. Selection still reads it on the old path. |
| 2. Blocks, rows, landmarks, selection | unchanged | Selection still decides which houses exist. |
| 3. Banks | `banks.ts`, `shareBanks` | Done; carried on every plan as `plan.banks`. |
| 4. Share districts among banks | `banks.ts` | Done; see the deviations below. |
| 5. Grow each district within its bank | `grow.ts`, `growDistricts` | Behind `layout.staged.districts.afterSelection` (off). |
| 6. Ground | `layout.ts`, `districtGround`, `plan.grown` branch | Behind the same switch. |

Tests: `staged-town.test.ts` ("banks, and districts shared among them") checks banks and shares for all 682;
`staged-layout.test.ts` checks the grown path on Badanos and Montica (every invariant, exact counts, no lot
outside its ground, every landmark in its owner's ground). The census measures both ways:
`node scripts/staged-census.ts 1 --grown`.

### Banks and shares (steps 3 and 4)

- A bank is a whole stretch of land, not only touching kept blocks: blocks join through their tiles
  (`plan.tilesBeside`) and never across the river (`river.side`); a bank is such land that holds kept houses.
  Read literally ("connected sets of kept blocks"), a riverless town would fall into several banks wherever an
  empty block parts kept ones, contradicting "a town with no river is one bank".
- Placement order, which the gameplan does not spell out past "centre first": centre, middle, waterside, edge.
- Landmark pulls: a district owning the plaza, the castle or a block landmark first gets a foothold of one house
  on that landmark's bank, then takes the rest from there; the other districts fill banks nearest the plaza
  first, the overflow going on to a bank a bridge joins.
- Lomia: 488 settlements are one bank, 192 two, 2 three. 204 districts span banks, 6 of them with no bridge
  between. In Pombal, Inillanue, Ruha and Montica: two banks each, one spanning district each, bridged.

**Deviation: at most b − 1 spanning districts is not by construction.** Nearly every district owns a block
landmark, so the pulls, not the placement-order fill, decide most placements. Where the districts pulled to one
bank need more than it holds, one must spill over. The foothold keeps every landmark in its owner's ground (the
gameplan's Landmarks test) at the cost of extra spanning districts in **12 of 682** settlements. Dropping the
foothold instead lets a pulled district be pushed off its landmark's bank entirely (Nuvusvaa did).

### Growth (step 5), as built

Bank by bank; districts that span banks first, then placement order.

- **Seeds:** all the district's landmarks on this bank, and its bridge's end if it spans (several sources at
  once); failing those, the block the previous district left part of; failing that, by placement (waterside
  nearest the water, edge farthest from the plaza, otherwise beside claimed ground, favouring wards forecast as
  its kind).
- **Grow:** cheapest path over the land (Dijkstra over block tiles), with the forecast's barrier costs for
  crossing a highway, main street or wall. Blocks with no kept houses can be crossed but are not claimed; other
  districts' blocks and landmark blocks cannot be crossed.
- **No orphans:** a claim that would cut off a pocket of unclaimed blocks that fits in the district's remaining
  need claims the pocket too; one too big defers the block once.
- **Exact count:** the last block gives a run of houses round its edge, the run nearest the district; the next
  district starts from the rest.
- **Last on a bank** takes whatever remains.
- Added during measuring (the gameplan forbids repair passes; these change growth rather than repair after it,
  but the reviewer may count some as repairs): blocks touching a district's landmark are reserved for it until it
  has grown; spanning districts grow first from their bridge.

### Ground (step 6), as built

A district's ground is the tiles of its blocks and of its landmarks; no vote. A block two districts share has
its tile divided along the line between their houses when that line parts them cleanly; when it does not (the
run turns a corner), the second district gets the ground close round its houses and out to the street, the first
the rest. For drawing only: a block with no kept houses takes the district of most of the blocks round it, and a
piece of a district's ground holding none of its lots is dropped.

A bug worth knowing about: a divided tile's first part had a hole round the second's houses; joined into one
outline by a slit and then grown (the foreign subtraction), the slit outline filled its own hole and erased the
second district's ground. Fixed by growing parts with their holes kept apart (`grown(rings, by, round, holes)`).

## The census, all 682 settlements

| Measure | Selection's districts (old) | Grown districts (new) | Target (`sim-6f.md`) |
| --- | --- | --- | --- |
| Settlements keeping every invariant | 682 | **676** | all |
| Lots outside their own district's ground | 3,049 | **344** | 0 |
| Districts in more than one piece | 287 | **972** | under 40 |
| ... with their bridge links counted as joins | 111 | **903** | |
| Houses by the non-touching fallback | 1,372 | 0 | 0 |
| Every district exact, every building placed | yes | yes | yes |
| Landmarks outside their owner's ground | not measured | 0 of 4,643 | 0 |
| Spanning districts / unbridged / settlements over b − 1 | not measured | 204 / 6 / 12 | b − 1, each bridged |
| Wards whose forecast kind is not their district's | not measured | 5,076 of 18,085 (28%) | report |
| Time to lay out all 682 | 315 s | 325 s | |
| Pombal's layout | 4.3 s | 4.5 s | report |

The 6 broken settlements (Calba among them) fail one invariant: a waterside (harbour) district lies more than
the pack's 40 m from the water. The harbour seeds at the water, but its share can be pulled to a landmark's bank
or spill to another bank, away from the quay.

## Why the pieces

Looked at district by district in Pombal and Badanos (`pieces` of each district, with area and lots):

1. **The last district on a bank** takes whatever the others left, scattered: one Pombal outskirts district is in
   11 pieces, a craft district in 7. The gameplan expected this ("expected, not guaranteed") but it is the
   largest single cause.
2. **Districts with several landmarks far apart.** Landmarks are reserved (6E: reserve, then fill) inside the
   district's forecast wards before any district exists; a district with landmarks in three places grows three
   bodies. Many second pieces are exactly one lot of 2,000 to 8,000 m²: a landmark's block on its own.
3. **Small slivers in shared blocks**: house-sized islands of the second district where its run does not reach
   its other ground.
4. **Order effects**: a district grown later finds its natural ground already claimed by one grown earlier, and
   jumps.

The gameplan's estimate of under 40 assumed districts would mostly grow as one region from one seed. In this town
model they cannot: the landmarks fix several anchors per district before growth, and sequential growth leaves the
last district the remainder.

## Why the lots outside

All 344 are in shared blocks: either a house on the wrong side of the dividing line (the run is not separable by
a line), or a house whose ground near the division is shaved by the neighbour's part. Making it 0 needs a
division that follows the houses exactly (a Voronoi-like split of the tile by nearest house), not a line.

## Open questions for review

1. **Grow all districts on a bank at once**, in rounds (each claims its cheapest next block in turn, a
   competitive flood fill), instead of one at a time. No district is left with only the remainder; borders fall
   where fronts meet. Risk: exact counts then need a final balancing at the borders, which looks like the
   selection-time moves Part B set out to remove.
2. **Place block landmarks after districts are grown**, in their owner's grown ground, instead of before. This
   removes the multiple-anchor pieces, but changes 6E's "reserve, then fill" order: houses are laid around
   reserved blocks, so reserving later means re-laying or reserving from the kept houses.
3. **Is "one piece per bank" the right target at all**, or should a district with several landmarks be allowed a
   piece per landmark (and the measure count only pieces without a landmark)?
4. **Spanning districts over b − 1** (12 settlements): accept, or let a pulled district lose its landmark's bank?
5. **The waterside invariant** (6 settlements): pin a harbour district's whole share to the bank with the quay,
   ahead of landmark pulls?
6. **Divide shared tiles by nearest house** instead of by a line, to make lots outside 0.

## Files to read

- `sim-6f.md` (Part B), and this note.
- `packages/core/src/layout/staged/banks.ts`, `grow.ts`; `plan.ts` (where they are called); `layout.ts`,
  `districtGround` (the `plan.grown` branch).
- `scripts/staged-census.ts` (`--grown`) and the README's staged stage 11.
- Tests: `packages/core/test/staged-town.test.ts` (banks), `staged-layout.test.ts` (grown path).
