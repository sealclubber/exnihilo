# Phase 6D.3 Gameplan (final) — Roads, Wards, Buildings

Nov 22, 2026 · @seal

## Goal

Generate towns in three moves: roads, then wards, then buildings. The user has approved a prototype of exactly this, and it is the reference: `docs/prototypes/proto_combined.py` with `proto_combined.png` (seed 7) and `proto_combined_b.png` (seed 3). The user will add them to the repo before this phase starts.

This replaces the road-first generator at `0f0508a`, which the user judged a regression: skinny lots stacked side by side and large empty areas. It also supersedes the earlier 6D.3 draft ("The Ward Method"); ignore that document.

**The idea that was missing.** Earlier attempts laid lots along streets and put a building in each. Here there are no lots as a separate thing. Roads cut the town's ground into wards, and each ward is cut in two again and again until the pieces are building-sized. The pieces are the buildings. The cutting is the method of Watabou's Medieval Fantasy City Generator.

**Licence.** The user has cleared this: you may read Watabou's open source (`watabou/TownGeneratorOS`, GPL-3) for the cutting step. If you port code from it, add a GPL-3 `LICENSE` to the repo and credit it in the README.

## The method

Port the prototype step for step into core, seeded through `stepRng`, every number in `layout.yaml`. The prototype's values are the starting values. Where it cuts a corner, the step says what the real version does.

1. **Water.** Keep the river and coast from 6D.1.
2. **Highways.** Every route in the brief is a highway, laid before anything else. Two exits roughly opposite each other are one road through the centre; other exits run in to the centre and join there. A highway wanders gently. It crosses a river once, on a bridge set square to the bank, and the road bends to meet the bridge's ends.
3. **Arterials.** Arterials branch off a highway on alternating sides at irregular spacing (130 to 220 m), leaving at roughly a right angle and wandering outward, longest near the centre. An arterial that reaches water stops at the bank.
4. **Second bridge.** A town over the pack size gets one more bridge, a few hundred metres along the river from the first, square to the bank, with its own arterial from the highway to the bridge and on from the far end.
5. **Quays.** A street follows each bank.
6. **Ground.** The town needs ground equal to its buildings' total pack lot area divided by a fill share (0.8), plus a small margin. Ground is taken cheapest first, where cost is distance from the nearest highway, plus a smaller term for distance along the highway from the centre, plus a term for distance from the nearest arterial, plus smooth noise. Water costs infinity. Smooth the outline and fill any holes. Keep the cost: it is the order the town grew in.
7. **Trim the arterials.** Once the ground is settled, cut every arterial back to the town's edge. Only highways run on past it, out to their exits. An arterial left shorter than about 25 m is dropped.
8. **Wards.** Subtract the highways, arterials, quays, bridges and water from the ground, each road at its own width. The pieces left are wards. Any ward larger than a limit drawn between 0.65 and 1.5 hectares is split in two by an ordinary street, cut across its long axis near the middle, turned by a small random angle, and bent slightly along its length; repeat until every ward is under its limit.
9. **Buildings.** Cut each ward into buildings. For a piece of ground: cut it across its long axis at a point near the middle, the ratio and a small turn both wandering with the ward's *grid chaos* (no turn once the piece is under four times the building size). Leave an alley's gap (2.4 m) on the cut while the piece is large, none once it is small. A half that is under the ward's building size, times a random factor set by *size chaos*, is finished: it is a building, or with a small probability open ground. Otherwise cut that half again.
10. **Ward character.** Each kind of district sets building size, grid chaos, size chaos and the open-ground probability. Building size also varies from ward to ward, so neighbours differ.
11. **The edge frays.** The last fifth of wards by growth cost are loose: more pieces left open, rising towards the very edge, and each building pulled in a little from its piece so houses stand apart. No ward is left empty and no ground lies outside a ward.

The prototype takes the long axis from the piece's smallest enclosing rectangle. Watabou's code uses the longest side instead, which is equivalent for plain shapes; the rectangle is sturdier for the curved pieces that roads leave.

## Fitting it to this project

The prototype draws about the right number of buildings. The project needs exactly the city's buildings, each reachable on foot. The prototype has none of what follows.

**Districts own wards.** Each ward belongs to one of the city's districts, and a district is one connected group of wards.

- Districts are chunks bounded by roads and the river. A ward joins the district whose seed ward is nearest, where crossing a highway, an arterial or the river adds a penalty (150, 110 and 400 m in the prototype). Then weights are adjusted over several rounds until each district's ground matches its buildings' share of pack area.
- Seeds keep the existing placement rules: the centre district at the oldest ground, the visitors' quarter beside it, the harbour on water, outskirts among the loose edge wards, poorer districts farther from the highway, tier preferences.
- A district's buildings are shared among its wards in proportion to ward area.

**Exactly the city's buildings.** Each ward is cut with a building size equal to the mean pack lot area of the buildings it must hold. Then:

- *Large buildings first.* List the ward's buildings whose pack area is over three times its building size, largest first. While cutting, a half whose area is within 30% of the next one on the list goes to that building and is not cut further.
- *Too few pieces:* cut the largest remaining pieces again, without an alley, until there are enough.
- *Too many pieces:* leave up to the ward's open-ground share empty, choosing the pieces farthest from a street first; then merge the smallest pieces into a neighbour they share a wall with.
- *Match.* Pair buildings with pieces by rank of area, largest to largest. Then apply the existing arrangement rules (streets of one trade, housing near work, spread civic buildings) by swapping buildings between pieces of similar area.

Pack lot sizes become targets. A cottage's ground will vary by ward; that is intended, and it is what gives the varied look.

**The lot is the piece.** A building's lot polygon is its piece. Its footprint is the same polygon in ordinary wards, and the pulled-in polygon in loose edge wards. Phase 6E refines footprints.

**Streets and entrances.**

| Part of the town | Segment kind |
| --- | --- |
| A highway | `arterial`, with its `routeId`, at highway width |
| An arterial or a bridge's road | `arterial` without a `routeId`, narrower |
| A quay, or a street that split a ward | `street` |
| The middle of every cut that left an alley | `lane`, joined by a junction to whatever it meets at each end |
| A bridge | `bridge` |

A lot's entrance is the nearest point on a road, street or lane it borders. A piece that borders none is merged into a neighbour that does, before pieces are counted. Where a street or lane reaches the edge of town it ends as a dead end.

**Plaza.** In a town flagged `plaza`, reserve an open place where the highways meet or, with one through road, beside it at the centre, before wards are made. It is the market square's lot.

**Walls.** In a town flagged `walls`, the wall encloses the oldest share of the ground by growth cost (the existing pack share; everything in a small town), along a smoothed line that follows ward edges, never through a ward. Gates stand where highways and arterials cross it, with more added on ward streets to match the gatehouse count. A street that meets the wall elsewhere stops.

**Other shapes of town.**

| Brief | Result |
| --- | --- |
| Two exits roughly opposite | One through road and a long town, as in the prototype |
| One exit | The highway ends at the centre |
| Three or more exits | Highways meet at the centre or plaza; arterials branch from each |
| A port | The quay is treated as a highway, with arterials branching inland |
| No routes | A short local road through the centre stands in as the highway |
| Under about 300 residents | A highway, one or two wards beside it, mostly loose |

## Acceptance tests

The correctness, water, life and cost tests from 6D and 6D.1 still apply and are re-run. The shape tests written for earlier methods are withdrawn and deleted with their code: `ringShare`, through streets, T-junction share, elongated blocks, strip lots.

*Estimates* are reported, not bent to.

| Test | Passes when |
| --- | --- |
| Exact buildings | Every building has exactly one lot in all 682 settlements (Badanos 1,825; Pombal 8,632; Vereceldo 65) |
| Reachable | Every lot's entrance is on a road, street or lane its polygon borders; a path exists between every pair of lots |
| No overlaps | No lot overlaps another lot, a roadway, water or the wall |
| No empty ground | Every part of the town's ground is a road, a ward or the plaza; every ward holds buildings; in wards that are not loose, lots cover at least 75% of the ward (*estimate*) |
| Loose edge only | Wards with under 60% coverage are all among the last fifth by growth cost (*estimate*) |
| No skinny lots | In Badanos and Pombal the median lot is under 2 times as long as wide, and under 3% are over 4 times (*estimate*) |
| Sizes vary | The standard deviation of lot area is at least 40% of the mean in every district of Badanos (*estimate*) |
| Arterials stay in town | No arterial extends more than 10 m past the town's ground; only highways reach exits |
| Bridges | Every bridge crosses within 15° of square to the river; Badanos and Pombal have 2 or more; no other road crosses water |
| Road first | Each highway is one unbroken chain from its exit to the centre or to the opposite exit; every arterial starts on a highway or a bridge |
| Town follows the road, Badanos | Its extent along the highway is at least 1.3 times its extent across (*estimate*) |
| Districts are chunks | Every district is one connected group of wards; in Badanos at least half of district boundary length lies on a highway, arterial or bank (*estimate*) |
| Ward sizes | No ward over 1.6 ha; wards hold a median of 20 to 45 buildings in Badanos (*estimate*; the prototype has about 70 wards for 1,825 buildings) |
| Lanes | In Badanos at least a third of lots have their entrance on a lane (*estimate*) |
| Walls and gates | Gates equal gatehouses; no street crosses the wall except at a gate; the wall cuts through no ward |
| Life | Trips per resident within 15% of the grid's 3.69 in Badanos; mean trip length reported for grid and for this generator |
| Cost | Badanos under 1.5 s, Pombal under 8 s (*estimate*); all of Lomia reported |

**By eye.** Render Badanos and put it beside `proto_combined.png`. It should be the same kind of town. The user judges the five test towns this way.

## What goes, what stays, and the order of work

**Remove** from the grown generator: patches with a grain, brickwork seeds, the Voronoi blocks, through-street pairing and junction pulling, strip lots, and district growth over blocks. Keep the 6D.2 renders under another name.

**Keep:** the grid generator, the layout format with walls and places, the 6D.1 water, the 6D.2 highways, arterials and ground cost where they already match this document, bent-street support, the render command and the viewer. `LAYOUT_VERSION` goes up by one. The city, life and outsiders are not touched.

**New geometry needed:** cutting a polygon by a straight or bent line with a gap, subtracting road strips from a polygon, a polygon's smallest enclosing rectangle, and finding which pieces share a wall. A small, pure, deterministic polygon-clipping library is permitted; name it in the report.

**Order of work.** Commit a Badanos render after each of the first three steps. If one does not resemble the prototype, stop and report instead of continuing.

1. Roads, bridges, ground, trimmed arterials and wards. No buildings.
2. Wards cut into buildings by the plain method, counts not yet exact. This should already look like `proto_combined.png`.
3. Districts on wards, exact counts, large buildings, matching.
4. Streets, lanes, entrances, the path graph.
5. Plaza, walls, the other town shapes, small settlements.
6. All of Lomia, life, cost, viewer, docs.

**Report back with**

1. The acceptance table with measured values.
2. Renders of the five towns beside the prototype.
3. Where the port departs from the prototype and why.
4. How often each count fix fired (extra cuts, open ground, merges) in Badanos and Pombal.
5. One example settlement for each row of the town-shapes table, with a render.
6. Any town that looks wrong, with its render.

