# Phase 6D.4 Gameplan — Thin Lots and Walls at the Water

Nov 22, 2026 · @seal

## Where things stand

The 6D.3 generator at `aeedee1` is approved by the user as the look. Two faults remain: stick-thin lots in places, and walls drawn along the water. Everything else stays as it is; do not rework the method.

Thin lots, measured on the default seeds. Length and width are the sides of a lot's smallest enclosing rectangle.

|  | Badanos | Cevilefon | Pombal | Vereceldo |
| --- | --- | --- | --- | --- |
| Lots | 1,825 | 3,606 | 8,632 | 65 |
| Median length ÷ width | 1.60 | 1.58 | 1.63 | 1.62 |
| Lots over 4 times as long as wide | 75 (4.1%) | 173 (4.8%) | 565 (6.5%) | 4 (6.2%) |
| Lots over 6 times | 26 | 76 | 278 | 2 |
| Lots under 4 m wide | 46 | 76 | 261 | 1 |
| Narrowest lot | 1.6 m | 1.0 m | 1.5 m | 2.2 m |

The typical lot is well shaped. The fault is a tail: a few percent of lots, which cluster in a few wards and so catch the eye. They fall on every kind of building and every district, so it is not one ward type's settings.

## Fix 1: thin lots

**Cause.** Nothing stops a cut from making a sliver; the only floor is an area of 6 m². The worst source is the "too few pieces" fix in `allot.ts`: it cuts the largest pieces again *across their fronts, both halves keeping the front*. Each such cut halves a lot's frontage and keeps its depth, and a ward that is several buildings short gets the same pieces halved more than once. That is the row of sticks. Confirm this by reporting how often that fix fires per ward and how many of the thin lots it made.

**Three changes, in this order.**

1. **A floor on every cut.** Add two pack numbers: a least width (start at 5 m) and a greatest length-to-width (start at 3.5), both measured on a piece's smallest enclosing rectangle. Any cut anywhere, plain or corrective, is refused if either half would break them. A refused cut tries other ratios, then the piece's other axis; if nothing passes, the piece is not cut. Tiny building types whose pack lot is itself under the least width (a well, a market stall) are exempt by their own size, not by a list of names.
2. **Aim high, then merge down.** Remove the cut-across-the-front fix. When the plain cutting gives a ward fewer pieces than it needs, cut the whole ward again with the same random streams and a building size 10% smaller, and repeat until there are at least enough. Then use the existing "too many" path to come down to the exact count. When merging, pick the pair whose joined shape is squarest, not simply the smallest piece.
3. **A piece that fronts nothing.** The fix existed because every lot must touch a way. Keep that rule, but meet it the way the plain cutting does: when a cut would leave a back piece with no front, leave an alley on that cut and run it out to the nearest way. A back lot on an alley is right for these towns; a sliver reaching for the street is not.

**A last pass.** After counts are exact, any lot still breaking the floor is joined to the neighbour along its longest shared wall, and the ward's largest lot is cut once (floor applied, alley if needed) to restore the count. Report how many lots this pass touches; after changes 1 to 3 it should be few.

## Fix 2: walls at the water

Cevilefon's layout has 5 wall records: the main wall, plus short stretches lying along the coast road on top of the quay. Pombal shows the same dashes along its river. The wall line is being followed along the water where the walled ground meets it.

- **A wall never runs along water.** Where the walled ground reaches the sea or a river, the wall ends at the bank on each side and the water closes the gap. Drop every stretch of wall that lies within the quay's width of a bank.
- **One wall, one record.** A town has one wall. It may be an open line, or several open lines where water interrupts it, but they are parts of one record with one gate list. Pombal's wall crosses its river: it stops at each bank and resumes on the other, with no stretch along the bank.
- **Not on a road.** A wall never lies along a road's surface. It may cross a road only at a gate.
- **Gates.** Check Cevilefon and Pombal for arterials that cross the wall line without a gate. If the path graph already stops them, the render should show the break; if it does not, they need a gate or must stop.

## Small items

- **Village roads are too wide.** In Vereceldo (65 lots) the arterial stubs are drawn at full arterial width and dominate the village. Under a pack size, branches are `street` width.
- **An exit labelled "road".** Pombal's southern exit has no destination and is labelled just "road". Label it by its bearing ("road south") when the brief gives no destination.
- **Time.** Pombal takes 17 s to generate on the reviewer's machine against a budget of 8 s; Cevilefon 3.6 s; Badanos 1.9 s. Report your own timings. If Pombal is over budget on your machine too, profile it and report where the time goes before optimising.

## Acceptance tests

All existing tests still pass. Add:

| Test | Now | Passes when |
| --- | --- | --- |
| No slivers, all 682 settlements | 1.0 m narrowest | No lot is narrower than the pack's least width, except a building whose pack lot is itself narrower |
| Few long lots | 4.1 to 6.5% over 4 times | Under 1% of lots are over 4 times as long as wide in each of the four towns; none over 6 times |
| Shape unchanged otherwise | median 1.6 | Median length ÷ width stays between 1.4 and 1.8 |
| Exact buildings | passes | Still one lot per building everywhere |
| Back lots are reachable | n/a | Every lot's entrance is on a way it borders, alleys included |
| One wall | Cevilefon 5 records | Every walled settlement has exactly one wall record |
| No wall along water or road | fails | No stretch of wall longer than 10 m lies within 12 m of a bank or on a roadway |
| Village roads | arterial width | No way wider than `street` width in a settlement under the pack size, highways excepted |

**Report back with** the measured table, how often the old fix fired and what share of thin lots it explained, how many lots the last pass touched, timings, and new renders of the five towns. Keep the current renders under another name for comparison.
