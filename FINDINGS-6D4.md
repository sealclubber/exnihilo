# Phase 6D.4: findings and state (work in progress)

Written 2026-11-23 at the end of a working session, for the user and the
planning agent. The commit holding this file is **work in progress**:
`npm run check` does **not** pass yet (see "Still open"). Everything below was
measured on the development machine; see CLAUDE.md for how long things take.

## What the gameplan asked, and where it stands

| Item | State |
| --- | --- |
| Floor on every cut (`leastWidth` 5 m, `longest` 3.5) | Done. Pack fields in `layout.yaml` `grown.buildings`. |
| Remove the cut-across-the-front fix; aim high, merge down | Done. |
| A piece with no front gets an alley to the nearest way (spur) | Done, reworked after review (below). |
| Last pass for lots still under the floor | Done. |
| Report the old fix | Done (below). |
| Walls never along water; one wall record; never on a road | Reworked after review (below). Record is `walls[0].lines`: one closed line, or open lines that end at the banks. |
| Gates on every arterial crossing | Reworked after review (below). |
| Village roads at street width (`arterials.streetBelow` 1000) | Done. |
| Exit with no destination labelled by bearing ("road south") | Done. |
| Timings, profile | Done (below). |
| New renders; old kept | `docs/renders/*-grown.svg` new, `*-grown-6d3.svg` the 6D.3 ones. |

Versions: LAYOUT_VERSION 9, pack 0.15.0, GENERATOR_VERSION 6, LIFE_VERSION 5.
Fingerprints: `packages/core/test/baselines/layout-grown-v9.json`.

## Measured, default seeds

| | Badanos | Cevilefon | Pombal | Vereceldo |
| --- | --- | --- | --- | --- |
| Lots | 1,825 | 3,606 | 8,632 | 65 |
| Median length ÷ width | 1.54 | 1.54 | 1.54 | 1.43 |
| Over 4 times as long as wide | 0 | 3 (0.08%) | 5 (0.06%) | 0 |
| Over 6 times | 0 | 0 | 0 | 0 |
| Narrowest lot | 4.0 m* | 4.0 m* | 4.1 m* | 5.3 m |
| Layout time | 1.2 s | 2.4 s | 5.5 s | 0.1 s |

\* Narrow building types only (their own pack lot is under 5 m), which the
floor exempts.

Before this phase (6D.3, same machine): Badanos 0.8 s, Cevilefon 1.7 s,
Pombal 6.8 s, Tames 7.4 s.

**The old fix** (cut across the front, both halves keeping it) made 58 of 74
thin lots in Badanos (78%), 132 of 155 in Cevilefon (85%), 464 of 516 in
Pombal (90%), measured before removing it.

**The last pass** touched 13 lots in Badanos, 17 in Cevilefon, 36 in Pombal,
0 in Vereceldo (measured before the review changes below; not re-measured).

**Profile.** Half the layout time was the test of whether a piece fronts a way
(`frontageOf` in `allot.ts`): it now gathers the road pieces once per edge and
tests squared distances. `Math.hypot` in `cutting.ts` was replaced by
`Math.sqrt`. Both changed only speed (and last-digit rounding).

## How buildings are shared out (user's instruction during the phase)

Each ward is cut once to count the lots it can make that keep every rule; a
district's buildings are shared among its wards in proportion to those counts.
A district short of lots is recut with a building size 10% smaller, at most 5
times, then the town is laid out on more ground. No buildings pass between
wards. Every loop is bounded; a ward that cannot be cut throws with its id,
area, capacity and demand. Districts are first balanced: the district with
fewest lots for its buildings takes a bordering ward from a neighbour when that
raises the poorer of the two.

The ward-size test (≤ 1.6 ha) passed while oversized wards existed because it
reads only the final layout's blocks, and the oversized wards (in retry
attempts, outside a wall whose outer street had collapsed) were never blocks.
The collapse is fixed (`offsetRing` in `cutting.ts`).

## Changes after the user's review of the renders

The user looked at renders of the failing walled towns and asked for three
things.

1. **Walls only on the outside; water is the barrier.** The wall still follows
   a contour of the oldest ground, but it:
   - stops at a bank where it comes within a quay's reach (quay offset + half
     the quay's width + half the wall's), and the water closes the gap;
   - drops any stretch that only hugs a bank (never more than twice that
     clearance from water);
   - stands across the river from the centre only where a highway passes
     through it (Pombal's far bank is now open; Caspo lost a loop that
     enclosed nothing);
   - is moved off any road running along it, leaving a lot's width between;
   - after lots are placed, drops any open line with no gate and no town
     behind it.
2. **Every road that crosses the wall has a gatehouse.** The city decides how
   many gatehouses (pack: 0.25 per thousand, 2 to 8, at least one per route
   exit); the layout may not add buildings. Agreed with the user: only roads
   at a gate cross. Any other road is cut back on both sides to the last
   junction before the wall. When a town has more gatehouses than crossings
   (Vikholt: its sea route ends at the shore), a road end is carried out
   through the wall to make a gate, from up to 120 m away. Vikholt's extra gate
   leads nowhere beyond the wall; dropping sea routes from the gatehouse
   count was tried and reverted, because in river towns (Karlen) sea routes are
   drawn as highways and do cross the wall.
3. **No street ends in someone's living room.**
   - A spur (alley to a back lot) runs square out from the middle of one side
     of the lot it serves and stops flush with that side, giving the lot its
     frontage without notching it; failing that, straight from the lot's
     middle to the nearest way, still flush.
   - A ward street's dead end is drawn back until its roadway is clear of the
     next ward; the ground left is a thin seam between the wards.
   - A lane's unconnected end is drawn back further, so its round end stays in
     its alley.
   These also removed most "lot overlaps the roadway" failures, which had made
   towns retry: Pombal now lays out at its first attempt.

## Still open (why `npm run check` fails)

Last whole-Lomia run (682 settlements), after all the above:

- **Two settlements fail to lay out:** Anvines (settlement-22) does not fit
  even 8.2 times the usual ground; Hoski (settlement-7) leaves one lot with no
  street. Not yet investigated.
- **Slow settlements:** the whole-Lomia test requires every layout under 20 s.
  Karpeysk 29 s, Rabe 22 s, Bertuera about 29 s, Villeou about 27 s, Hoski about
  24 s. The time is retries: districts too small for their buildings
  ("too small at the districts"), or a ward that cannot be cut for its
  buildings though its count said it could. Each attempt costs 2 to 5 s in a
  large town.
- **The new acceptance checks in `lomia-cities.test.ts`** (no lot under the
  floor, one wall record, no wall stretch over 10 m along water or on a road,
  village roads at street width) have not been run since the review changes.
  The four test towns pass them.
- The wall measure (`wallStretches` in `test/shape.ts`) counts a street that
  meets the street outside the wall at a shallow angle as "wall on a road";
  these are harmless junctions (e.g. Nuora) and the measure may need to be
  narrowed rather than the layout changed.
- Pack field `grown.buildings.frontDepth` is no longer read.

## Open design questions for the planner

- Should a town with more gatehouses than land crossings keep a gate that
  leads nowhere (Vikholt), or should gatehouse counts follow which routes
  actually cross the wall? That needs the city to know something only the
  layout knows today.
- The wall still follows the oldest 75% of the ground (`wall.share` 0.75), so
  outskirts lie outside it. The user confirmed: wall on the landward edge of
  the walled town, ending at water, never around nothing.
- Retries are now the main cost of large towns. A cheaper capacity count, or
  a district plan that knows the floor before the wards are cut, would remove
  most of them.
