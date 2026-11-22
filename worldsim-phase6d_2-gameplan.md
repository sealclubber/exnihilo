# Phase 6D.2 Gameplan — Road First

Nov 22, 2026 · @seal

## Goal

Make a town that reads as grown along its road: the road existed first, arterials branched off it, and the town filled in around them. The user has approved a prototype of this look, and it is the reference for this phase: `docs/prototypes/proto_road.py` and its picture `docs/prototypes/proto_districts.png`.

The 6D.1 towns at `abfe9cd` fixed the rings and the river, but read as cracked mud. Four causes, all from the 6D.1 gameplan:

- **One scattered point per block.** Every block is a similar polygon, so the town is a honeycomb.
- **No street continues.** Every junction is a three-way fork near 120°, so each street is one straight edge with a kink at both ends.
- **Lots fan into block centres.** That makes pinwheels with bare middles.
- **The town is a round blob.** Ground was taken by distance from the centre, so nothing shows that the road came first. Pombal's wall is a near-circle drawn in steps.

Keep from 6D.1: the water, the Voronoi machinery, the render command, the layout format, bridges, and the tests. Replace how roads, ground, blocks, streets, lots and districts are derived.

## The method

Follow the prototype step for step; each step below names what it does there. Port it to TypeScript in core, seeded through `stepRng`, with every number moved to `layout.yaml`. The prototype's numbers are the starting values. Where the prototype cuts a corner, the step says what the real version must do.

1. **Water.** As 6D.1 makes it. Unchanged.
2. **Highways.** Every route in the brief is a highway, laid before anything else. Two exits roughly opposite each other, as in Badanos, are one continuous road through the centre. Other exits run from their bearing to the centre and join there. A highway wanders gently and is the widest road in town; it keeps the segment kind `arterial` and its `routeId`, so nothing downstream changes.
3. **Arterials.** Arterials branch off each highway on alternating sides, at irregular spacing (prototype: 120 to 210 m), leaving at roughly a right angle and wandering outward. They are longest near the centre and shorter towards the ends of the built-up stretch. One reaches the river and crosses it by a bridge; a town above the pack size gets a second. Give these the kind `street` at arterial width, or add a segment kind if cleaner; say which in the report.
4. **Along the water.** A street runs along each built bank, as in 6D.1.
5. **Ground.** Ground is taken in order of a cost: distance from the nearest highway, plus a smaller term for distance along the highway from the centre, plus a term for distance from the nearest arterial, plus low-frequency noise. The town therefore stretches along its road. The order in which ground is taken is kept on each block as `growthRank` between 0 (oldest) and 1 (newest).
6. **Patches and grain.** Divide the area into large patches (prototype: coarse points 200 m apart). Each patch takes its grain, a direction, from the nearest highway, arterial or bank at its middle, with a small random turn.
7. **Block seeds.** Inside each patch, lay seeds as brickwork in the patch's grain: rows a block-depth apart, seeds a block-length apart along each row, alternate rows offset by half a length, everything jittered. Sizes vary per patch. Blocks are smaller where `growthRank` is low. Then drop seeds too near a road or the water, and add mirrored pairs of seeds along both sides of every highway, arterial and riverside street, so those roads fall on cell boundaries.
8. **Cells.** One Voronoi diagram of all seeds. A block is a cell. Do not relax it: relaxing undoes the brickwork.
9. **Through streets.** At each junction, pair the two edges that continue each other most nearly straight (prototype: within 40°); those are one street passing through, and any other edge ends there as a T. Then, for several rounds, pull each junction part-way towards the midpoint of its two through-neighbours. Streets straighten along their length and bend gently instead of kinking. Emit one segment per junction-to-junction stretch as before, with its line smoothed.
10. **Blocks.** Inset each cell by half the width of each bordering street (the prototype uses one inset; the real version uses each street's own width), round the corners slightly, and cut away water and road surface.
11. **Lots.** Take the block's long axis. Split the block along it into two rows back to back (one row if shallow). Cut each row into strips across the axis, each strip's width drawn from its building's pack frontage with the 6D.1 spread, sides skewed slightly. A strip is a lot; its entrance is on the street its outer end faces. Old blocks are filled wall to wall; newer blocks leave gaps by pack probability. The prototype cuts strips without regard to buildings; the real version places each district's buildings, biggest first, using the existing arrangement rules.
12. **Leftover ground.** A block with no lots stays as open ground inside the town (a green, a yard, a field). Keep some: they stop the town looking stamped.

The cannot-fail loop stays: if buildings are left over, take more ground and repeat from step 6 for the new ground.

## Districts, walls and other town shapes

**Districts are chunks, not rings.** A district is a connected piece of town whose edges are, where possible, a highway, an arterial or the river.

- Each district has a seed block. The centre's is the oldest block; the others are spread out by repeatedly taking the block farthest from all seeds so far, subject to the existing placement rules (harbour on water, visitors' quarter beside the centre, outskirts at the edge, tier preferences).
- A block joins the district whose seed is nearest, where crossing a highway, an arterial or the river adds a pack penalty to the distance (prototype: 140, 110 and 400 m). Roads and the river therefore become district boundaries without being forced to.
- Then adjust at the boundaries until each district's ground fits its buildings, keeping every district in one piece.
- Age is not a district. `growthRank` is a separate property for Phase 7 and for lot density. Do not colour or name by it.
- A large town should have districts of very different sizes, and fewer of them than 6D.1 drew for Pombal. If the city generator's district count forces confetti, report it; do not change the city.

**Walls.** The wall follows the edge of the ground whose `growthRank` is below the walled share, smoothed, so it has the town's stretched shape and is never a circle. It is drawn as a smooth line, not steps. Gates stay where highways and arterials cross it.

**Other shapes of town.** The rule is always the same: highways first, the town along them.

| Brief | Result |
| --- | --- |
| Two exits roughly opposite | One through road; a long town |
| One exit | The highway ends at the centre; a town at the end of its road |
| Three or more exits | Highways meet at the centre or the plaza; the town is a star with arms along each, arterials linking the arms |
| A port | The quay is treated as a highway: arterials branch from it inland |
| No routes | One short local road through the centre stands in as the highway |
| Under about 300 residents | A highway and its roadside lots, perhaps one arterial; no patches needed |

## Acceptance tests

All Phase 6D and 6D.1 tests are re-run and still apply, including `ringShare`, straight water, bridges, lot variety, life and cost. These are added. *Estimates* are reported, not bent to.

| Test | 6D.1 now | Passes when |
| --- | --- | --- |
| Road first: every highway is one unbroken chain of segments from its exit to the centre, or exit to exit | broken into block edges | True in all 682 settlements |
| Arterials branch from highways | none | Badanos has at least 5, each starting on a highway; none starts at the centre junction |
| Town follows the road, Badanos | round | The town's extent along the highway is at least 1.4 times its extent across it (*estimate*) |
| Through streets | none | In Badanos and Pombal, at least half the street length lies in through streets that pass 3 or more junctions (*estimate*; prototype measures this as chains) |
| T-junctions | forks at 120° | At least 60% of three-way junctions have one pair of arms within 25° of straight (*estimate*) |
| No kinks | kink at every junction | Along any through street, no turn at a junction exceeds 30° |
| Blocks are elongated | near-round | Median block length is at least 1.6 times its depth in Badanos and Pombal (*estimate*) |
| Strip lots | fans | At least 85% of lots are four-sided with their long sides within 15° of each other; no block has an empty middle wider than 12 m unless it has no lots at all (*estimate*) |
| Districts are chunks | confetti in Pombal | Every district is one connected piece; in Badanos at least half of all district boundary length lies on a highway, arterial or bank (*estimate*) |
| Districts are not rings | n/a | No district encloses the centre without containing it |
| Wall shape, Pombal and Cevilefon | circle in steps | The wall's turn between consecutive points never exceeds 15° except at gates; its longest diameter is at least 1.2 times its shortest (*estimate*) |
| Growth order | n/a | Every block has a `growthRank`; the oldest tenth of blocks all touch a highway |

**By eye.** Render Badanos with the default seed and put it beside `proto_districts.png`. It should be recognisably the same kind of town, with real buildings, a wall-less plan and proper road widths. That comparison, for the five test towns, is what the user will judge.

## Reference files, and what to report

The user will add two files to the repo before this phase starts: `docs/prototypes/proto_road.py` and `docs/prototypes/proto_districts.png`. The script is Python with numpy, scipy, shapely and matplotlib; run it with `python3 proto_road.py <seed> <out.png>` to see other seeds. It is a sketch to read and port, not code to keep: it has no buildings, no wall, no exits, one inset width, and it draws main roads on top instead of making room for them.

`LAYOUT_VERSION` goes up by one. The city, life and outsiders are not touched. Standing rules in CLAUDE.md apply.

**Order of work.** Port steps 2 to 10 and commit a Badanos render with blocks only, no lots, before going further. Then lots, then districts, then walls, then all of Lomia.

**Report back with**

1. The acceptance table with measured values, and the 6D and 6D.1 tables re-measured.
2. New renders of the five towns, with the 6D.1 renders kept under another name.
3. Where the port departs from the prototype and why.
4. How each row of the town-shapes table came out, with one example settlement each.
5. Any town that still looks wrong, with its render.

