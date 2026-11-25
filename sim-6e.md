# Town Layout — Design and Gameplan (Phase 6E, replaces the 6D series)

Nov 23, 2026 · @seal

## Summary

This replaces the whole 6D series. The town generator is rebuilt as a staged pipeline on one shared mesh, following a prototype the user has approved over nine rounds. Ignore every 6D gameplan and `FINDINGS-6D4.md`; where they disagree with this document, this document wins.

**Reference files.** The user will add these to `docs/prototypes/` before work starts:

| File | What it is |
| --- | --- |
| `proto_wards9.py` | The prototype: 531 lines of Python using numpy, scipy, shapely and matplotlib. Run as `PH=1.0 PR=0.55 CL=30 python3 proto_wards9.py river out.png` (or `port`, `bigriver`, `village`; use `PH=0.6 PR=0.8 CL=70` for towns with several highways). `STREETCOL="#d62828"` draws lanes in red. |
| `w9_river.png`, `w9_port.png`, `w9_bigriver.png`, w9\_village.png | Its output for a river town, a sea port, a city on both banks and a village |
| `w9_river_streets_zoom.png` | A close-up with lanes in red |

The script is a sketch to read and port, not code to keep. It grew by patching, so it is untidy; this document is the clean statement of what it does. It has no connection to the city generator: its districts, building types and counts are stand-ins.

**Why the 6D generators failed.** They made the town all at once and repaired it afterwards: streets were grown and houses fitted to them, or ground was cut into pieces that were then forced to be houses, and exact building counts were met by cutting and retrying. That gave houses of impossible shape, streets through houses, walls on roads, slivers, and retries that ran for minutes.

**Licence.** The user has cleared reading Watabou's open-source generator (`watabou/TownGeneratorOS`, GPL-3). If code is ported from it, add a GPL-3 `LICENSE` and a credit in the README.

## Principles

Six ideas carry the design. Each one removes a class of bug the 6D series fought.

1. **Stages, each final.** The town is made in a fixed order, and a later stage never moves what an earlier one placed. Water, then highways and bridges, then the wall, then special wards, then the mesh, and so on. Nothing is repaired afterwards.
2. **One shared mesh.** After the first stages, the town is a mesh of cells with shared corners. Highways, the river, the wall and ward borders all lie on its edges; each cell is a ward. Because they share corners, a wall cannot lie on a road, a street cannot cut a house, and a road cannot miss its gate.
3. **Reserve, then fill.** Anything special claims its ground first: a ward (castle, plaza), a block (church, hall) or a slot in a row. Ordinary houses fill only what is left. Landmarks and, later, an editor's placements use this one mechanism.
4. **Houses are rectangles.** A house is a rectangle or an L, T or U made of rectangles, laid in a row along its block's edge and facing the street, with a courtyard behind. Odd-shaped ground is left as yard, never turned into a house.
5. **Make too many, keep the best.** The generator builds more houses than the town has, then keeps exactly the number the city needs, choosing the best-placed. The rest never existed. That gives exact counts with no cutting, no retries and no constraint solving, and it is what makes the town thin out at its edge.
6. **Streets are found, not made.** After everything is placed, the lanes are whatever lies between blocks where houses stand. No ward or block is moved to make a street. The same gaps are the walking network.

A seventh, for later: **edits stay local.** Each ward draws its randomness from its own stream, keyed to the ward, so changing one ward regenerates only that ward.

## The pipeline

Eleven stages. *N* is the town's building count from the city. Numbers are the prototype's and are starting values; all go in `layout.yaml`. Widths: highway 10 m, main street 7 m, ward border 6.5 m, lane 4.2 m.

**1. Water.** Calm shapes only.

- A river enters and leaves on the brief's bearings and passes the centre at a distance the generator chooses, since the brief gives only bearings: a seeded draw from a pack range, as a share of the town's radius (start at 0.25 to 0.85). A river port with no coast draws from a nearer range (start at 0.15 to 0.4), so its quay is close to the centre. This one draw decides whether the town is beside its river or astride it, so it comes from its own stream and is reported in the layout summary. It has two broad bends and nothing tighter: one control point halfway along each half, pushed sideways by 7 to 13% of that half's length, then smoothed. Constant width.
- A coast is a line on the brief's side with wide bays and headlands from heavily smoothed noise.

**2. Highways and bridges.** Every route in the brief is a highway. Two exits more than 150° apart are one road through the centre; others run to the centre.

- *Bridge first.* If a highway must cross the river, the crossing is chosen before the road: the point near the centre where the river runs most nearly square to the direction of travel. The bridge is set square to the bank and the road is routed onto its axis.
- *How many.* Under 1,500 buildings, 1 bridge; 1,500 to 4,000, 2; over 4,000, 3.
- *Town beside the river* (centre more than about 230 m from the crossing): the highway splits before the river, each branch crosses on its own bridge 150 to 200 m along the bank from the next, and the branches rejoin into one road on the far side.
- *Town astride the river* (centre closer than that): side bridges are spread along the river at about half the wall's radius apart. Each bridge's road runs on from both ends and curves into the nearest highway on that bank. No rejoin.
- Split branches and bridge roads are highways for every later stage.

**3. Harbour.** A route of kind sea-route is a highway from the centre that ends at a quay. On a coast the quay is a strip along the shore with piers square to it, as in the prototype. In a river port with no coast (70 of Lomia's 178 ports, Pombal among them) the quay is a wharf along the bank nearest the centre, with short jetties no longer than a quarter of the river's width so the channel stays open, and the river is drawn wider through a port (pack factor, start at 1.5). A sea route has no exit on the town's edge: ships leave by water. If a town has both coast and river, the quay goes on the coast. If it has neither, make no harbour and report the settlement. Needs the `port` flag and water.

**4. The wall.** Only for towns flagged `walls`. Designed now, before the mesh.

- One rounded ring centred on the town, enclosing ground for about half its buildings. With one through road it is an oval 1.4 times as long as wide, along the road; with several highways, 1.12. A slight wobble keeps it from being a perfect ellipse.
- Towers about every 85 m; the wall runs straight between towers.
- At water the wall ends at the bank. If under 30% of the ring's area lies across a river, the far part is dropped and the river closes that side. Otherwise both banks are walled.

**5. Special wards.** Small wards placed by rule and cut out before ordinary wards exist.

| Ward | When | Size | Where |
| --- | --- | --- | --- |
| Plaza | `plaza` flag | 1.3 m² per building, between 1,200 and 6,500 m² | Where the highways meet |
| Castle | `citadel` flag | 3.2 m² per building, between 3,500 and 14,000 m² | Just off the plaza, in the widest gap between highways, inside the wall. Own wall and towers. |

**6. Ground.** How far the mesh needs to reach. Take land cheapest first until there is 2.6 times the area the town needs (*N* × 250 m²), where cost is a weighted sum of distance from the nearest highway and distance from the centre, plus smooth noise. Weights: one through road 1.0 and 0.55; several highways 0.6 and 0.8. This cost is kept as each ward's `growthRank`.

**7. The mesh.** Scatter seed points over the ground at a spacing of about 0.6 of the town's radius, between 120 and 300 m. Remove seeds close to a highway, the river or the wall, then add mirrored pairs of seeds along both sides of each, so those lines fall on cell borders. Take the Voronoi diagram. Each cell is a ward.

**8. Main streets.** From mesh corners that lie on a highway, follow cell borders outward, always taking the straightest continuation and stopping when the turn is too sharp. Starts are kept apart. Each main street then moves the corners it passes through towards their neighbours, so the wards beside it bend with it.

**9. Wards and blocks.** A ward is its cell minus highways, main streets, water, wall and special wards, moved in by half a ward border. Each ward is split into blocks: cut across its long axis near the middle with a lane's gap, turned slightly, and repeat until blocks are under 2,200 to 4,600 m² times the ward's scale.

**10. Reservations, then rows.**

- *Reservations.* Chosen blocks are given to landmarks (see Fitting the city). A landmark's footprint is a template scaled down until it fits whole inside its block. It is never clipped.
- *Rows.* In every other block, lay houses along each edge, longest edge first. A house is a rectangle on the edge; half get a rear wing, making an L. Width is drawn around 12.5 m times the ward's scale; depth 10 to 14 m, capped at a third of the block's narrow side so a courtyard always remains. A block too shallow for a courtyard gets one row straight through. About a third of courtyard blocks get a 3.6 m passage through one row.
- *Hard rules.* A house lies wholly inside its block. A house never overlaps another, a passage or a reservation. A house that cannot keep 60% of its intended shape is not placed.

**11. Selection and streets.**

- *Selection.* Score every house by the ground cost at its centre. The innermost 62% of the count is always kept, as is everything inside the wall. Beyond that, the score is inflated by a random factor that grows with distance, and the lowest scores are kept until the count is exact.
- *Streets.* The street surface is the ground between blocks, within a few metres of a kept house, plus the passages, minus the wall. Main streets are trimmed to the built-up area.

## Fitting the city

The prototype stops at coloured rectangles. This section is new design, not yet prototyped, and is where care is needed. The city generator is not changed: every building it makes gets exactly one place.

**Districts are groups of wards.**

- After the mesh exists, estimate each ward's capacity from its area and its growth rank.
- Grow the city's districts over neighbouring wards from seed wards, with the existing placement rules (centre at the plaza, visitors' quarter beside it, harbour on water, outskirts at the edge, poorer districts farther out). Crossing a highway, a main street, the wall or the river costs extra, so those become district borders. Stop growing a district when its wards' capacity reaches about 1.4 times its building count.
- A district sets its wards' character: building scale, lane frequency, how often a row gets a rear wing. A poor quarter is small and tight; a rich one is large and open. Scale also varies a little from ward to ward.

**Exact counts, per district.** Selection runs district by district: each district keeps exactly its own number of houses from the candidates in its own wards, by the scoring in stage 11.

- If a district has too few candidates, it takes unkept candidates from the nearest neighbouring wards, nearest first. Those houses change district; nothing is regenerated.
- If the whole town has too few candidates, take more ground and extend the mesh, at most three times, then fail loudly with the numbers. There is no other loop anywhere in the generator.

**Which building goes where.** Within a district, after selection:

- Sort the district's ordinary buildings by pack lot area and its kept houses by footprint area, and pair them largest to largest. Pack lot sizes are therefore targets, not exact sizes.
- Then apply the existing arrangement rules (streets of one trade, housing near work, spread civic buildings, shops and taverns on highways and main streets) by swapping buildings between houses of similar area.

**Landmarks.** A building type is a landmark if the pack marks it so. Each landmark names its reservation size and placement rule.

| Reservation | Building types (examples) | Placement |
| --- | --- | --- |
| Ward | Citadel, market square | The castle and plaza special wards |
| Block | Temple, guild hall, barracks, large inn, mansion | Temple on the plaza; others on a highway or main street in their district, at least 90 m apart, in a block large enough to hold the template whole |
| Slot | Chapel, well, shrine | A position in a row, or in a courtyard or the plaza for wells |
| Gate | Gatehouse | One per gate, at the gate |

Landmark footprints come from templates in the pack: a cross for a temple, a U round a yard for a hall, a keep for the citadel. Landmarks are placed before rows and always kept; they count towards their district's total.

**Lots.** The layout format wants a lot and a footprint for each building. A house's lot is its footprint. Courtyards are common ground belonging to the block, not to any lot.

**The walking network.** Built from the same geometry, not traced from the drawing.

| Part of the town | Segment kind | Centre line |
| --- | --- | --- |
| Highway, with its `routeId` | `arterial` | The highway's line |
| Main street | `street` | The chain of mesh edges |
| Ward border | `lane` | The mesh edge |
| Lane inside a ward | `lane` | The cut line that split the block |
| Courtyard passage | `lane`, dead end | The passage's axis |
| Bridge | `bridge` | The bridge |

- Junctions are mesh corners, the points where a cut meets a border or another cut, bridge ends, gates and exits.
- A segment is kept only if a kept building fronts it or it is needed to keep the network in one piece.
- Each house knows the block edge it was laid along. Its entrance is the middle of its front, projected onto that edge's segment. Every house therefore has an entrance on a way it borders, by construction.
- Lanes that reach the wall away from a gate end there on both sides.

**Small settlements.** Settlements under 1,000 residents do not use this pipeline; see Villages below. The rest of this paragraph is superseded. A walled village gets the ring anyway, sized as above. Below about 60 buildings, skip main streets.

## Villages

A settlement under 1,000 residents is a village and does not use the pipeline above. It has no mesh, wards, districts in the layout, selection or wall ring. The road leads, and buildings are placed one at a time. In Lomia that is 136 of 682 settlements, the smallest with 253 residents and 65 buildings.

The user approved this over five rounds of prototype. Reference files, to be added to `docs/prototypes/`: `proto_village5.py` and `village_sheet5.png` (four shapes at 110 and 180 buildings), and `village_sheet.png` for the 65-building look. Run as `python3 proto_village5.py <street|green|cross|shore> <buildings> out.png`.

**Flags are shrunk, not ignored.** A village honours every flag the map gives it, at village scale.

| The brief says | A town gets | A village gets |
| --- | --- | --- |
| `walls` | Stone ring, towers, gates | A palisade, with gaps where the through roads pass |
| `citadel` | Castle ward | A manor in its own yard, with a barn |
| `plaza` | Market square | A green; without the flag, the well stands on the road at the centre |
| `temple`, or a chapel from the city | Temple on the plaza | One church in a churchyard, by the green or the centre |
| `port` | Quay and piers | A landing: one jetty and a lane to it |
| River | Bridges by size | One small bridge or ford, and a mill beside it |

**Shape.** Chosen from the brief, first match wins: a coast or lake, or settlement type Lake or Naval, gives *shore*; two or more routes that are not one through road give *crossroads*; the `plaza` flag gives *green*; otherwise *street*. A river, palisade or manor can occur with any shape.

**Order of construction.**

1. **Environment.** Water as in the town pipeline, at village scale: a stream with broad bends, or a calm shore.
2. **Road.** Each route in the brief, at 6 m. Opposite exits are one through road. Lanes are 3.6 m.
3. **Anchors.** The green (an oval beside the road, with a pond and the well, and a lane round it), then church, manor, mill and landing, each on its own plot or site.
4. **Central forks.** From 90 buildings, lanes fork off the road near the centre at 25 to 45 degrees; some loop back to it farther out. Two forks under 150 buildings, three above. Under 90 there are none. At a crossroads, curved links join neighbouring arms.
5. **Plots, outward from the centre.** Walk along both sides of every road and lane from the point nearest the centre, laying plots side by side. A plot is 13 to 21 m wide and 30 to 58 m deep, with its house at the front, set back a little, and garden behind. About a third of wider plots are farmsteads with a barn and shed, which are drawing only. From 140 buildings, plots within 70 m of the centre are 7 to 9.5 m wide and their houses join into a terraced row.
6. **Thicken, never lengthen.** The built stretch of the through road is capped at about 70 m plus 0.85 m per building each way. When frontage runs out, a new lane is added: try some 40 candidates, each starting on an existing lane or on the road inside the village, heading off at about a right angle or straight on from a lane's end. Reject any that enters water, crosses the green or runs alongside another way. A candidate that meets another way joins it. Keep the one with the most free plot frontage, favouring joins and ground nearer the centre. A palisaded village may not reach as far.
7. **Palisade.** Fitted after all plots: a near-circle round them, never far from round, with a slight wobble.
8. **Fields, last.** The village has an envelope: the palisade, or a smooth outline round its plots. Fields lie outside it and are cut only by the through roads. They carry furrows; some are woodland. Fields, trees, barns and boats are drawing: no one lives or works in them yet.

**The city and exact counts.** Every building the city generator makes gets one plot; step 6 repeats until all are placed. The larger a building's pack lot, the nearer the centre and the wider its plot. Districts remain a property of each building and are not drawn. Which buildings a village has is setting content in the pack (for example, no guild hall or players' hall below a population), and is the user's to set.

**Known faults in the prototype.** Do not port these.

- Most added lanes end as closes. Build some loops on purpose by linking two lane ends that lie near each other.
- At 180 buildings too many forks meet at one point. Start some a little way along the road.
- The palisade is loose at 110 buildings: tighten the reach cap for palisaded villages.
- Fields are too even. Near the village they should be long strips; farther out, larger closes and commons.
- The through road is nearly straight; it should wander as highways do.
- Lanes stop at a hard count in the prototype. The real version must always reach the exact building count.

**At the boundary.** A town just over 1,000 residents looks cramped under the town pipeline. Treat 1,000 as the switch for now and report how the first few towns above it look; a blend, with village plots on a small town's outer lanes, is a likely later change.

**Tests.** All 136 villages generate with exactly one plot per building; no plot overlaps another plot, a way, water or the green; every house has an entrance on the way its plot fronts; the walking network is one piece; the built length of the through road is within its cap; a palisade exists exactly when the brief is flagged `walls`, and no field touches it; the same village from the same seed is byte-identical. Life runs on a village: trips per resident reported.

## Pins and the future editor

No editor is built in this phase. Three hooks are, because adding them later would mean reworking the generator.

- **A pins input.** `generateLayout` takes an optional list of pins, empty by default. A pin is a reservation a person made: a ward, a block or a slot, given a building type or a bespoke footprint, at a stated place. In stage 10, pins are applied first and the rules fill in around them. Define the type and thread it through now; an empty list must give exactly today's output.
- **A stream per ward.** Every ward's blocks, rows and passages draw from a stream derived from the town's seed and that ward's identity, not from one shared stream. A ward's identity must be stable: derive it from its seed point, not from its position in a list.
- **Stages that can be re-run from the middle.** Each stage is a pure function of the stages before it. Regenerating one ward must not require regenerating the mesh.

With those in place, an edit behaves as Watabou's warp tool does: change one ward and only that ward redraws. The town's total stays exact because selection drops or restores a house at the fringe.

Pins are stored, authored state, like the clock and the avatar. Everything else remains derived from brief, pack and seed.

## Checks and acceptance tests

**Built-in checks.** These run inside the generator's invariants on every layout, not only in tests. The prototype prints the first two; both read 0 for all three reference towns.

| Check | Must be |
| --- | --- |
| Pairs of buildings overlapping by more than 1 m² | 0 |
| Buildings overlapping a street, lane, passage, wall or water | 0 |
| Buildings not wholly inside their block | 0 |
| Landmarks clipped or outside their reservation | 0 |
| Buildings without an entrance on a way their block borders | 0 |
| Ordinary wards with no blocks | 0 |

**Acceptance tests.** *Estimates* are reported, not bent to. Reference values are measured from three Watabou maps the user supplied.

| Test | Passes when |
| --- | --- |
| Exact buildings | Every city building has exactly one lot, in all 682 settlements, and each district's count is exact |
| No retries | The only loop is "take more ground", at most three times; report how many settlements used it |
| House shapes | At least 95% of ordinary footprints have 4, 6 or 8 corners; at least 85% of corners are right angles (reference: 82 to 91%) |
| House sizes | In each test town, the large-to-small ratio of footprint area (90th to 10th percentile) is between 2.5 and 4.5 (reference: about 3); no ordinary house under 6.5 m wide (*estimate*) |
| Courtyards | At least 80% of blocks deep enough for one have open ground in the middle (*estimate*) |
| The edge fades | Building density falls steadily over at least 60 m at the town's edge; no ground outline is drawn or stored |
| Wall | One closed ring, or open only at water; every highway and main street crosses it exactly once, at a gate; no lane crosses it; gates equal gatehouses |
| Bridges | Count follows the size rule; each within 10° of square to the bank; every bridge road joins a highway at both ends |
| Special wards | Plaza and castle within their size limits; castle inside the wall; neither crossed by a road |
| Districts | Every district is one connected group of wards; at least half of district border length lies on a highway, main street, wall or bank (*estimate*) |
| Network | One connected walking network; every lot reachable from every other |
| Local edits | Changing one ward's stream changes only that ward's buildings and, through selection, buildings in the outer fifth of the town |
| Empty pins | An empty pin list gives byte-identical output to no pin list |
| Determinism | Same brief, pack and seed give a byte-identical layout |
| Life | Life, outsiders and avatar suites pass; trips per resident within 15% of the grid's 3.69 in Badanos; report mean trip length for grid and new |
| Cost | Badanos under 2 s, Pombal under 10 s on your machine (*estimate*); report all of Lomia. For scale, the prototype takes about 9 s for the river town (1,825 kept of 4,716 made) in unoptimised Python, drawing included. |

**By eye.** Render the five test towns and put Badanos beside `w9_river.png`. They should be the same kind of town. The user judges this.

## What goes, what stays, and the order of work

**Remove.** The whole `grown` generator from the 6D series: road-first ground, ward cutting into pieces, `allot.ts` and its count fixes, back-lot alleys, the lot floor code, the 6D wall, and the tests written for them. Keep its renders under another name for comparison.

**Keep.** The grid generator as a fallback and for comparison. The layout format's records for junctions, segments, lots, footprints, districts, walls and places. Bent-street support. The render command and the viewer. The city generator, life and outsiders are not touched; `GENERATOR_VERSION` does not change.

**Add to the format.** Wards (id, polygon, district, kind, growth rank), blocks, a building's front edge, and the pins input. `LAYOUT_VERSION` goes up by one.

**Geometry.** The prototype leans on a polygon library for difference, intersection, inset and union. Use a small, pure, deterministic one (for example `polygon-clipping` or a Clipper port, and `d3-delaunay` for the mesh) and name the choice in the report. Most row placement is rectangles against a nearly convex block, so write direct tests for that instead of calling the library per house.

**Order of work.** Commit a render of the river-town reference (Badanos) after every step, and stop and report if one does not resemble the prototype at that stage. Do not start a step before the one above it has been looked at.

1. Water, highways, bridges for both river cases, harbour. Roads only.
2. Wall ring, plaza, castle.
3. Mesh, main streets, wards drawn as plain cells.
4. Blocks, then rows of houses in every ward, uniform character, no selection.
5. Reservations and landmark templates.
6. Districts on wards, ward character, selection per district, exact counts.
7. Building types matched to houses; arrangement rules.
8. Walking network, entrances, gates; life runs on it.
9. Built-in checks, pins plumbing, per-ward streams, the local-edit test.
10. All of Lomia, small settlements, cost, viewer, docs.

**Known faults in the prototype.** Do not port these.

- Only one of the river town's two bridges gets a gatehouse; every bridge into a walled bank should.
- A few main streets end mid-town. A main street should reach the edge of the built-up area or end at a junction.
- Fringe houses keep the angle of a block that has mostly vanished. A house left alone at the edge should turn to face the nearest way.
- An ordinary ward occasionally comes out with no blocks.
- Plaza and castle are cut out of the mesh as shapes; in the real version they should be mesh cells like any ward.
- Districts are placed by a stand-in rule and ward character is partly random.
- Bridge count and several thresholds are tied to the prototype's four test scenes; check them across Lomia. In the village scene (170 buildings) roads and lanes are drawn at city widths and overwhelm the houses, and the wall and plaza are large for the place: widths and special-ward sizes need to scale down for small settlements.

**Report back with**

1. The render from each step of the order of work.
2. The built-in checks and the acceptance table, measured, for the five test towns and across Lomia.
3. Where the port departs from the prototype or this document, and why.
4. The geometry library chosen and where it is and is not used.
5. Any settlement that needed more ground, failed, or looks wrong, with its render.

