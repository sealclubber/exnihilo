# Phase 6G Gameplan — Districts Drawn After Houses

Nov 25, 2026 · @seal

## Summary

Districts are drawn after the houses are chosen, not before. Tested on every town over 1,000 people in Lomia, this puts every district in one piece and gives 538 of 539 towns exactly the city's counts.

Today the generator draws district ground first, then selection keeps houses town-wide, so the ground holds the wrong number of houses and selection repairs it afterwards. That repair is where the fallback houses, the districts in pieces and the lots outside their own ground come from. This phase removes the repair and the cause together.

| Measure, 539 towns, 513,236 houses, 2,058 districts | Today | This method |
| --- | --- | --- |
| Houses the district ground gets wrong | 83,122 (16%) | 26, all in one town |
| Towns with exact counts | n/a (repaired by fallback) | 538 of 539 |
| Districts in more than one piece | 284 | 0 |
| Houses placed by the non-touching fallback | 1,372 | 0 |
| Blocks shared between two districts | n/a | 1,220 of 170,920 (0.7%) |

The district method was tested outside the generator, on real `planTown` output from main at `1ebf85f`. Two parts were **not** tested, because they need changes inside the generator: landmark assignment, and house character without owned districts. Both are flagged where they come up.

The reference is `docs/prototypes/districts-after-houses.test.ts`. Where this doc and that file disagree, the file is what was measured.

## The new order of stages

District ground moves from before the houses to after them. Everything up to selection keeps its current order.

1. Water, highways, harbour, wall, special wards, ground, mesh, main streets, wards, blocks. Unchanged.
2. **Forecast.** Unchanged, but demoted. It is now only a rough guide for house character (row density, house sizes) and for where each district's seed sits. Nothing counts houses against it.
3. Reservations and rows. Landmark sites are reserved as today, but **unowned**: a site records what kind of slot it is, not which district's building stands on it.
4. **Selection.** Keeps the town's total number of houses by growth rank, as today. It no longer assigns a district to any house, and all of its district repair (block moves, chains, single houses, the non-touching fallback) is deleted.
5. **Districts.** New stage. Draws districts over the kept houses, block by block. Described in the next section.
6. **Assignment.** Each district's buildings go onto the houses inside its own ground. Landmark buildings go onto landmark sites inside their owner's ground.
7. Found streets and drawing. Unchanged. District ground is drawn from the blocks each district holds.

"Layout never changes the city" still holds. Every district ends with exactly the city's count.

## The districts stage

The stage works on blocks. Its inputs are the kept houses per block, block adjacency (`tilesBeside`), the bridge links, each district's target count, and the forecast's seed ward per district. It has five steps, in this order.

**Terms.** A *bank* is a set of blocks joined without crossing a bridge. A *unit* is a district, or the part of a district on one bank. A *bridgehead* is the block at one end of a bridge link.

### 1. Seed

Each district gets one seed block: the block with kept houses nearest the centre of its forecast seed ward. Smallest districts pick first. No two districts share a seed.

### 2. Share the districts among the banks

Add up what the units seeded on each bank want, and compare with the houses that bank holds. While some bank is over by more than 2 houses, take the most crowded one and:

- Find the bridge from it to the bank with the most room. The amount to move is the smaller of the excess and that room.
- **A district already crosses that bridge:** it carries more over. Its near part shrinks and its far part grows by the amount. If that would leave the near part under 6 houses, the whole district goes to the far bank.
- **Otherwise** take the unit seeded nearest the bridge that does not already cross a bridge. If its target is within 3 of the amount, it moves across whole and is seeded beside the far bridgehead. If not, it splits: a new unit on the far bank takes the amount, and both parts are seeded **on** their bridgeheads.
- A unit already seeded on a bridgehead that another district needs is moved to the nearest free block on the same bank.
- **The bank has no bridge:** its largest unit is re-seeded on the bank with the most room. This is the Haurinen case, a 6-house bank with a 111-house harbour seeded on it.

Bridgehead blocks belong to the district that crosses there and are never traded away. This is what keeps a district that spans a river in one piece.

### 3. Grow in turns

Repeat: the unit furthest below its target (lowest have ÷ target) claims one block. The block is the unclaimed block touching its ground, on its own bank, nearest its seed. Empty blocks are claimed too; they join ground together. A unit stops when it reaches its target or has nothing left to claim.

Then every block still unclaimed joins the touching unit with the smallest surplus, repeated until nothing changes. A block that touches no claimed block on its bank is an island and joins the nearest unit. In the full run this happened zero times.

### 4. Pass surplus along chains

For each unit short by 2 or more, largest shortfall first: search outward through touching units to the nearest one with a surplus of 2 or more. Along that path, each unit hands one border block to the next.

A block may be handed over only if all of these hold:

- It touches the receiver's ground on the same bank.
- It is not the giver's seed or a bridgehead.
- Its house count is at most the amount wanted plus 2.
- Neither the giver nor the receiver ends in more pieces than before. Count only pieces that contain houses.

A hop that finds no such block is marked dead and not tried again. Stop when no short unit can find a path.

The check on the receiver matters. Without it, a block can be attached to an empty scrap the receiver was cut off from earlier, and the district ends in two pieces.

### 5. Make the counts exact

After step 4 the districts are off by about 2.6 houses per town on average. Whole blocks cannot close that, so single houses do.

For each district still short, search through touching districts to the nearest with a surplus. Along the path, each district lends houses to the next through one border block: the block stays the giver's ground, and some of its houses belong to the neighbour. A block keeps at least one of its owner's houses and lends to one neighbour only.

In the full run this used 1,220 blocks and 2,021 houses, a median of 1 shared block per town and at most 34.

**Not tested:** which houses in a shared block go to the neighbour. The test only counted them. Use the houses nearest the neighbour's ground.

### What was tried and rejected

- **Growing ward by ward.** Wards are too coarse; it left hundreds of houses out per town.
- **Growing one district at a time.** The first districts wall in the rest. This was 6F Part B.
- **Letting bridgehead parts grow first.** It walls in their neighbours: Pombal went from 19 houses out to 631.

## Landmarks and house character

Two earlier steps use districts before the houses exist. Neither was tested in the sandbox, so both need measuring as they go in.

### Landmarks

**Amended Nov 25 after step 3 stopped. This replaces the rule below, which failed: 35% of landmarks needed a site next door, and its second case cannot work.**

Landmark sites stay owned and stay where main puts them, in the owner's forecast wards. Revert step 2 (`efcb18e`). The districts stage then makes ground follow the landmarks:

1. **Claim.** After seeding and bank sharing, before growth, each district claims the blocks holding its own landmark sites, on any bank where it has a unit.
2. **Grow toward them.** A unit's score for a candidate block is the smaller of its distance to the seed, and its distance to one of the unit's landmark blocks plus half that landmark block's distance to the seed.
3. **Release.** After growth and the leftover pass, any block of a unit that cannot be reached from its seed or bridgeheads is released, and joins a touching unit as leftovers do. This is what keeps districts in one piece.
4. **Protect.** In chains, a unit never hands over a block holding its own landmark.
5. **Fall back.** If a town does not come out exact, run the stage again for that town without steps 1 to 4 and keep that result.

A landmark whose block ends in another district's ground stays on its site and keeps its district. Count it in the census. Nothing is moved, so no house is displaced.

Measured on all 539 towns, on main's site placement, reference `docs/prototypes/districts-after-houses-landmarks.test.ts` run with `LM=2`:

| Measure | Without claims | With claims |
| --- | --- | --- |
| Landmarks outside their district's ground | 1,059 of 4,289 (25%) | 414 (9.7%) |
| Districts in more than one piece | 0 | 0 |
| Towns not exact, before the fall-back in step 5 | 1 | 4 (Nobla, Meunglain, Tuvaaki, Borfino) |
| Shared blocks | 1,220 | 1,261 |

Stop and report if landmarks outside their ground exceed 15%, or any district is in pieces.

Today a landmark is tied to a district when its site is reserved. With districts drawn later, 1,059 of 4,397 landmarks (in 342 towns, up to 19 in one) stand on a block that ends in another district.

The change: a site is reserved by kind of slot only (plaza edge, main street, row slot, and so on). After the districts stage, each landmark building takes a free site of the right kind inside its owner's ground, nearest the district's seed.

If a district has no free site of the right kind, in this order:

1. Use a site of the right kind in a touching district. The building keeps its district; it stands next door.
2. Put it on the largest ordinary house in its own ground.

Count both cases in the census. If the first case is more than about 5% of landmarks, stop and report rather than tune.

The plaza and castle wards are not blocks and are not part of this. Whatever stands in them stays as it is.

### House character

Row density and house sizes currently read the district from the forecast. Keep that. The forecast stays as a rough guide, and a district's final ground will mostly overlap its forecast ground because both grow from the same seed.

Where they differ, a district gets some houses built for a neighbour's character. That is accepted. Assignment sorts it out: within a district's ground, the largest buildings go on the largest houses.

Measure one thing: the share of buildings placed on a house smaller than their footprint needs, before and after. If it rises by more than a point, report it.

## What gets removed

- Selection's district repair: block moves, chains, single-house moves and the non-touching fallback.
- Any check or census line that counts houses against forecast ground.
- District ownership on landmark sites at reservation time.
- Branch `6f-ground-districts`. Do not merge it; delete it once this phase is in.

Villages are untouched. They have no districts stage.

## Checks and acceptance numbers

Hard checks, every town:

- Every building in the city is placed exactly once. Unchanged.
- Every kept house belongs to exactly one district.
- No two districts' grounds overlap. Unchanged.

Census, across all 539 towns. These are the sandbox figures; the real stage should land close to them.

| Measure | Sandbox | Stop and report if |
| --- | --- | --- |
| Districts in more than one piece (bridges count as joins) | 0 | more than 5 |
| Towns not exact after step 5 | 1 (Borfino, 26 houses) | more than 5 towns or 200 houses |
| Houses out after step 4, before step 5 | 1,425 (0.28%) | over 1% |
| Shared blocks | 1,220 (0.7% of blocks) | over 2% |
| Districts spanning a river | 146, in 146 river towns | no threshold; record it |
| Islands | 0 | any |

**The one known failure.** In Borfino a craft district splits across the bridge, and its far part is boxed in at the bridgehead before it can grow: it wants 71 houses and gets 8. Chains recover most of it; 26 houses stay out. I did not find a clean fix. For a town like this, place the leftover buildings on houses in the nearest touching district, count them in the census, and move on. Do not design a repair pass for it.

Add these as regression towns, since each one broke a version of the method: Karlen and Ruha (bank sharing), Haurinen (bank with no bridge), Pombal (size), Borfino (the known failure, pinned at its current number).

## Order of work

Commit after each step. Run the census after steps 1, 3 and 4.

1. **Port the districts stage as a pure function** in `packages/core/src/layout/staged/`, from the version-3 section of the reference file, steps 1 to 5. Do not wire it in. Run it beside the current pipeline on all towns and confirm the census matches the sandbox table. If it does not, stop: the port differs from the reference.
2. **Unown the landmark sites** at reservation.
3. **Switch over.** Selection keeps houses only; the districts stage runs after it; assignment places each district's buildings in its own ground, landmarks included. Delete selection's repair code in the same commit.
4. **House character check** and the landmark counts from the section above.
5. Renders for Badanos, Pombal, Karlen and Cevilefon into `docs/renders/` with district ground coloured, plus a short `FINDINGS-6G.md`: census table, anything that hit a stop condition.

### Notes on the reference file

- It is a measuring script, written to be fast to change. Port the logic, not the style.
- It scales targets to the kept total because it runs outside the generator. In the generator, a district's target is the number of its buildings that need a house.
- The first half of the file (growth by ward, direct block trades) is the rejected version 1, kept for comparison. The method is everything after the comment `version 3`.
- Run it with `TOWNS=A,B`, or `SAMPLE=n OFFSET=k` for every nth town. Results go to the path in `OUT`.

### Rules for this phase

- If a number misses its threshold, stop and write it up. No new repair passes, no tolerance changes.
- Per-ward random streams stay as they are. The districts stage uses no randomness.

