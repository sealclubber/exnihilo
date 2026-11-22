# Phase 6D.1 Gameplan — Break the Rings

Nov 21, 2026 · @seal

## What went wrong

The grown generator draws Badanos as concentric rings joined by short spokes. The cause is the Phase 6D gameplan, not the implementation.

- **The grain rule.** Step 4 said a street follows the direction of the nearest arterial and "turns towards radial near the centre". Badanos has one road through it, so almost everywhere the only direction on offer was radial, and streets came out as spokes and the rings that cross them.
- **The tests.** The shape tests checked that the town was not a grid: spread of directions, few four-way junctions, bent streets, non-rectangular lots. A polar grid passes all of them.

Measured from the committed Badanos renders, ignoring the 30 m around the centre:

| Share of street and lane length | Grid | Grown | A town with no preferred direction |
| --- | --- | --- | --- |
| Running around the centre (within 20° of a ring) | 25% | 60% | 22% |
| Running to the centre (within 20° of a spoke) | 30% | 39% | 22% |
| Either | 55% | 99% | 44% |

The fix is to stop deriving street direction from the centre at all.

## The change: blocks first, streets between them

Replace steps 2, 4, 5 and 6 of the grown generator (main roads, side streets, lanes, blocks). Instead of growing streets along a direction field, scatter the blocks and let the streets be the gaps between them. This is the method Watabou's city generator uses, and it has no centre-relative direction to fall into.

This time the method is prescribed. Deviate only where a step cannot work, and report it.

1. **Seeds.** Scatter points over the town's ground by Poisson-disc sampling. The spacing comes from the pack and widens with distance from the centre (start at 45 m in the middle, 75 m at the edge), so blocks are small in the old core and larger outside. No seed within half a spacing of water.
2. **Cells.** Build the Voronoi diagram of the seeds. Relax it once (move each seed to its cell's centroid and rebuild). One pass only: more makes honeycomb. Clip cells to the outline and to the banks.
3. **Candidate streets.** Every edge between two cells is a candidate street, and every cell corner a candidate junction.
4. **Main roads.** Each arterial is the cheapest path along candidate edges from the cell corner nearest the centre (or the plaza's edge) to the corner nearest its exit, where turning costs extra so the road wanders without zig-zagging. Then smooth each arterial's line between junctions. The road now bends because the town's fabric does.
5. **More ways out.** A town should have at least a pack number of roads leaving its centre (start at 5). Where the brief's exits are fewer, add local roads of kind `street` in the widest gaps between existing ones, made the same way as arterials and ending at the town's edge. They are farm lanes, not routes: no exit, no `routeId`.
6. **Along the water.** On each built bank, the candidate edges nearest the bank become a continuous riverside street. Arterials still cross on `bridge` segments at roughly a right angle.
7. **Merge and demote.** Not every edge becomes a street. With pack probabilities: remove an edge so two cells become one larger block; mark an edge as a `lane`; in a block too deep for its lots, cut a dead-end court in from one side. Never remove an edge that would disconnect the graph or that an arterial, local road or riverside street uses.
8. **Blocks.** A block is a cell, or merged cells, inset by half the width of each bordering street. Blocks at the wall follow the wall with the clear strip kept.
9. **Lots.** Unchanged in principle: the existing code that lines lots along a block's street edges, now fed polygonal blocks.

A Delaunay or Voronoi library is permitted if it is pure, deterministic across platforms and small; `d3-delaunay` is the obvious candidate. Say in the report what was added.

Delete the grain field and the code that grows streets along it. Do not keep it as an option.

## Other faults in the Badanos render

Fix these in the same pass.

- **The river has one sharp corner and straight banks.** It is two straight lines meeting near the centre. The Water section below replaces it.
- **The town turns its back on the river.** A wedge of empty ground lies between the centre and the west bank. The outline should treat the banks as cheap ground, and the riverside street in step 6 gives lots something to front.
- **Ford Bottoms hangs off one bridge.** The district across the river is a separate fan joined by a single bridge well away from the centre. Ground across the river should be taken only around a bridgehead, and a town above a pack size (start at 5,000 residents) with building on both banks gets a second bridge on a `street`.
- **Streets stop dead at the edge.** Nearly every ring ends in mid-air at the outline. After the change, edge blocks should be closed by a street or a lane on their outer side, or left as open-backed lots; a street may end at the edge only where step 5 or step 7 put it.
- **The outline is a spiral staircase.** It is the ends of the rings. With cells it should come out ragged and rounded; check it by eye.

## Water

No water in any town may have a straight edge. Today a river is two straight lines of constant width and the sea is a straight-sided polygon. Water is generated first, before roads and the outline, so everything else fits around its real shape.

**Rivers**

- The centre line is a meandering curve. It still arrives and leaves on the brief's bearings and still passes the centre at today's distance, but in between it swings from side to side. Meander wavelength is a pack multiple of the river's width (start at 11, which is typical of real rivers) and amplitude a pack share of the wavelength, both varied by the seed along the length.
- The line is sampled finely enough that it reads as a curve at any zoom the viewer allows.
- The width varies along the length by a pack share (start at plus or minus 25%), wider on the outside of bends. Add an optional `widths` list to the river record, one value per point of the centre line; `width` stays as the mean.
- The curve continues past the town's bounds so its ends are never seen.
- Bridges go where the river is narrow and cross at a right angle to the river's direction at that point.

**The sea**

- The coast is an irregular line on the brief's side: broad bays and headlands with smaller wobble on top, from seeded noise at two scales set in the pack.
- A town flagged `port` gets a bay at its harbour district, so the docks stand on sheltered water. Dock lots touch the shore.
- The sea polygon extends well past the bounds on its open sides.

**Everything that touches water** uses the real shape, not the old straight one: the outline, the riverside street, the wall's ends, the no-overlap invariants, and where vagrants sleep at bridge ends.

## Lots: break the uniformity

The bar for the look is Watabou's city generator: at minimum a town should read like one of its maps. Building outlines proper are Phase 6E, but the rows of identical boxes come from the lots, so fix that here.

- **Sizes vary.** A building type's lot size in the pack is a typical size, not an exact one. Each lot draws its frontage from a seeded spread around it (start at plus or minus 30%), with a pack minimum. No two neighbours of the same type should match.
- **Depth comes from the block.** A lot runs back to the middle of its block or to the lot behind it, within pack limits for its type, so depth changes along a street as the block's shape does.
- **The block is filled.** In the centre and craft districts lots fill the whole street frontage of a block wall to wall, corners included, with corner lots taking the odd-shaped ground. Gaps between lots appear only in the outer districts, by a pack probability per district kind.
- **Lot lines are not all square.** Side boundaries tilt by a few seeded degrees and follow the block's corners.
- **Totals hold.** The sum of lot area per district stays within 10% of what the pack sizes give, so density does not drift.

Placeholder footprints stay as they are, scaled to their lots. Phase 6E replaces them.

## Acceptance tests

Every Phase 6D test still applies and is re-run. These are added or changed. *Estimates* are reported, not bent to.

| Test | Now | Passes when |
| --- | --- | --- |
| No rings: share of street and lane length within 20° of a ring or a spoke about the centre, ignoring the inner 30 m | Badanos 99% | At most 60% in Badanos, Pombal, Cevilefon and every settlement above 2,000 residents (*estimate*; an undirected town scores 44%) |
| No rings from any point: the same measure taken about each district's label point | not measured | At most 65% (*estimate*) |
| Roads out of the centre | Badanos 2 | At least the pack's number in every settlement above 1,000 residents |
| Block sizes vary | not measured | The standard deviation of block area is at least 30% of the mean in Badanos and Pombal (*estimate*) |
| River | one corner | No two consecutive pieces of a river's line turn by more than 10°; its length inside the bounds is 1.1 to 1.6 times the straight distance between its ends (estimate); it enters and leaves within 10° of the brief's bearings |
| Riverside | empty wedge | In Badanos and Pombal at least 60% of the bank's length inside the outline has a street within 40 m (*estimate*) |
| Bridges | Badanos 1 | Badanos and Pombal have at least 2; every lot across the river reaches the centre |
| Streets ending at the edge | most rings | Dead ends are between 3% and 15% of junctions, as in 6D, counted with edge endings included |
| Phase 6D shape, wall, plaza, life and cost tables | passing | Still pass; report any value that moved by more than 10% |
| No straight water: every 200 m stretch of any bank or coast, in all 682 settlements | all straight | Bows away from the straight line between its ends by at least 4 m (estimate) |
| River width | constant | Narrowest and widest points differ by at least 20% of the mean; every bridge stands where the width is at or below the mean |
| Harbour, Cevilefon and Pombal | straight shore | Every dock lot is within 15 m of the water; Cevilefon's harbour lies in a bay |
| Lots vary: frontage of cottages, and of row houses, in Badanos | identical | Standard deviation at least 15% of the mean for each type; no street has three adjacent lots of equal frontage and depth (estimate) |
| Blocks filled, centre and craft districts | gaps and bare corners | At least 90% of each block's street frontage is lot (estimate); district lot area within 10% of the pack total |

Add the ring measure to the layout summary as `ringShare`, so it is printed for every town and a regression is visible without a render.

## What stays, and what to report

Keep everything else from Phase 6D: the layout format, walls and gates, the plaza, the outline's cost idea, districts, the lot code, the bent-street hardening, the render command and the viewer. `LAYOUT_VERSION` goes up by one. The city, life and outsiders are not touched.

Commit new renders of the five towns beside the old ones; keep the ring renders under another name for comparison.

**Report back with**

1. The tables above with measured values, and the full Phase 6D tables re-measured.
2. `ringShare` for the five towns, and the ten highest across Lomia with their names.
3. The pack numbers chosen for seed spacing, merge, lane and court probabilities, and what each does to the look.
4. The dependency added, if any.
5. Any town that still looks wrong, with its render.

