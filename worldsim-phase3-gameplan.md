# World Sim — Phase 3 Gameplan

Nov 19, 2026 · @seal

Phase 3 gives a generated city its first geometry: a street graph and a lot for every building, laid out simply. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Given a generated city and its settlement brief, produce a layout: a connected street graph, the water, and one lot per building with an entrance on a street. Show it as a town map in the viewer.

**Done when:** all acceptance tests below pass, Badanos opens as a town map on which every building's lot can be clicked, and the shortest walking path between any two lots can be shown.

## Context

The city generator (version 2) turns a brief into people, households, buildings and districts with no geometry. Read `CLAUDE.md`, the README and the generator before starting.

**The format matters more than the layout.** Phase 4 will build NPC movement and schedules on the street graph and lot entrances defined here. A later phase will replace this simple generator with one that produces natural-looking towns. That replacement must be possible without touching anything that consumes a layout. So this phase has two separate deliverables:

1. **The layout format:** general enough for an organic town, and the only thing later code may depend on.
2. **A simple generator:** a regular, easy-to-debug layout that fills the format correctly.

The simple generator will be regular. That is intended: when an NPC later walks somewhere strange, a regular map makes it obvious whether behaviour or layout is at fault.

**Lots only.** A lot is a parcel with an entrance on a street. Building footprints inside lots belong to the later visual phase.

## Scope

**Build**

- The layout format: schemas, types and invariants, in a new `layout` module in `core`
- The simple layout generator, as a pure function in `core`
- A shortest-path function over the street graph
- Layout numbers in the `medieval` pack
- An API endpoint for a settlement's layout
- A town map in the viewer

**Do not change**

- The city generator's output. `GENERATOR_VERSION` stays 2 and the Badanos baseline counts must not move.
- The settlement brief or the importer

**Do not build**

- Building footprints, interiors, or anything drawn inside a lot
- Organic or natural-looking street patterns
- An avatar, NPC positions, movement or schedules
- Town walls as geometry; gatehouses are placed as ordinary lots
- Fields, farms or anything outside the town's edge
- Generated street names, beyond the rule for arterials below
- Storage of layouts, or editing them in the browser

## Layout format

A layout belongs to one settlement. Coordinates are metres, with the origin at the town centre, x pointing east and y pointing south. Bearings are degrees clockwise from north, as in the brief.

| Record | Fields |
| --- | --- |
| Junction | ID, position, kind: crossing, dead end, bridge end, or exit |
| Segment | ID, the two junctions it joins, a polyline of points between them, kind: arterial, street, lane or bridge, width, optional name, optional route ID |
| Exit | ID, the junction on the town's edge, the brief's route ID, name, kind and bearing |
| Water | ID, kind: river or sea, and its shape: a centre line with a width for a river, a polygon for the sea |
| Lot | ID, the building it belongs to, a polygon, the district, and an entrance: the segment it opens onto and the point on that segment |
| District area | The district's ID, the polygon or polygons enclosing its lots, and a label point |
| Summary | Counts of each record, the town's bounding box, built area, residents per hectare, the layout version, the generator name, the pack name and version, and the seed |

Rules of the format, which every future layout generator must also satisfy:

- **One lot per building**, and every building has one.
- **Shapes are general.** A segment is a polyline and a lot is a polygon. Nothing that reads a layout may assume straight streets, right angles, rectangles or a grid.
- **The graph is the truth for movement.** A lot is reached through its entrance point on its segment. Lots do not connect to each other directly.
- **IDs** follow the existing pattern and carry the settlement number: `junction-641-000012`, `segment-641-000034`, `lot-641-000123`.
- **The summary names the generator** that produced the layout, so a later generator can coexist with this one.

Add a `LAYOUT_VERSION`, separate from `GENERATOR_VERSION`, raised whenever a layout for the same inputs would change.

## The simple generator

A pure function in `core`: a generated city, its brief, the pack and a seed in; a layout out. It uses its own random streams, named apart from the city generator's.

The intended approach is below. The details are yours to settle, provided the acceptance tests pass and the result is regular and easy to read.

1. **Size the town.** Give every building a lot size from the pack, by building type. The total lot area, plus streets, sets the extent.
2. **Lay a regular street grid** over that extent, with block dimensions from the pack. Trim it to a compact outline so the town is not a perfect rectangle.
3. **Place the water.** A river crosses the town as a band from the brief's arrival bearing to its departure bearing, passing beside the centre and not through it. A coastal settlement has the sea on the side of the brief's water bearing. Remove blocks and street segments that fall in water.
4. **Connect the exits.** Each route exit in the brief becomes an exit junction on the town's edge at its bearing from the centre. The streets on the path from the centre to that exit are marked arterial and carry the route's ID and name.
5. **Bridge the river.** Every arterial that crosses the river does so on a bridge segment. Add further bridges if needed so that both banks are connected.
6. **Place districts** as contiguous groups of blocks. The pack says where each kind belongs: at the centre, in the middle ring, at the edge, or by the water.
7. **Subdivide blocks into lots** along their street frontages, giving each building a lot in its own district. Landmarks take their larger lots first. Gatehouses sit at exits where the settlement has them.
8. **Set entrances** on each lot's frontage.
9. **Check** every layout invariant and fail loudly if one is broken.

Cases the Lomia fixture contains, which the generator must handle:

| Case | Count in Lomia | Handling |
| --- | --- | --- |
| No river and not coastal | Most settlements | Skip the water step |
| River flows through | 165 | Band from arrival bearing to departure bearing |
| River rises here, so the brief has no arrival | 42 | Start the river inside the town's edge region and run it out at the departure bearing |
| River ends here, so the brief has no departure | 3 | Run it to the sea if coastal, otherwise to the town's edge opposite the arrival |
| River and coast together | 55 | The river meets the sea |
| A single route exit | 53 | One arterial from the centre |
| Up to six route exits | 2 with six | All are connected |
| A route exit and the river leaving at the same bearing | Badanos: both at 61 | The arterial runs beside the river, not in it |
| Very small settlements | Vereceldo has 253 residents | A handful of blocks is a valid town |

## Pack additions

Every layout number lives in the pack, in a new `layout.yaml` with the usual explanatory comments. All values are placeholders.

| Setting | Meaning |
| --- | --- |
| Street widths | One per segment kind: arterial, street, lane, bridge |
| Block dimensions | Length and depth of a regular block |
| Default lot size | Frontage and depth for a building with no entry of its own |
| Lot sizes by type | Frontage and depth per workplace, dwelling and landmark type, where it differs from the default |
| River width | The brief does not carry one, so the pack supplies it |
| Density limits | The lowest and highest acceptable residents per hectare of built area, used as a sanity check |

In `districts.yaml`, each district kind gains a placement: centre, middle, edge or waterside. A dwelling type that holds several households, such as a tenement, should have a larger lot than a single-household one.

## Town view

- **API.** One endpoint returns a settlement's layout. It is generated on request and cached in memory like the city.
- **Path function.** In `core`, a function returns the shortest walking path between two lots: the ordered segments and the length in metres. The API exposes it.
- **Viewer.** "Open city" gains a town map beside the inspector:
  - Water, segments drawn by kind, and lots coloured by district
  - Exits labelled with their route name
  - Pan and zoom, with a scale bar in metres
  - Clicking a lot shows its building, using the inspector's existing building view
  - Selecting a household or building in the inspector highlights its lot on the map
  - A path tool: pick two lots and the shortest path between them is drawn, with its length

Plain shapes are enough. The map is a working tool in this phase, not a finished look.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Format.** Write the layout schemas, types and `LAYOUT_VERSION`.
2. **Invariants.** Write the layout invariants as a function that returns one line per broken rule, as the city invariants do. Test them against small hand-built layouts, valid and invalid, before any generator exists.
3. **Geometry helpers.** Polygon area, overlap, point on polyline, and bearing, with tests. Keep them in `core` and free of any library that touches the clock or random numbers.
4. **Pack.** Add `layout.yaml`, the district placements and their schemas.
5. **Generator, dry land.** Steps 1, 2, 4, 6, 7 and 8 for a settlement with no water. Target: Vereceldo, then a mid-sized town with no river and no coast.
6. **Generator, water.** Steps 3 and 5: rivers, bridges and the sea. Target: Badanos, then Pombal.
7. **Path function.**
8. **API.**
9. **Town map.**
10. **Whole-world run.** Lay out all 682 settlements, fix what breaks, and record the timing in the README.
11. **Wrap up.** Update the README and `CLAUDE.md`: the new module, the format's rules, and the pack file.

## Acceptance tests

All of these are automated and run against the Lomia fixture with the `medieval` pack. Every existing test keeps passing.

**Layout invariants, checked for every one of the 682 settlements**

- Every building has exactly one lot, and every lot belongs to exactly one building.
- No lot overlaps another lot, a segment's roadway, or water.
- Every lot's entrance point lies on the segment it names, and that segment borders the lot.
- Every lot's district is its building's district.
- The street graph is connected: every lot entrance and every exit can be reached from every other.
- There is exactly one exit per route exit in the brief. Seen from the town centre, each lies within 20 degrees of its bearing.
- Where the brief has a river, the river reaches the town's edge within 20 degrees of each bearing the brief gives.
- Only bridge segments cross water.
- A coastal settlement has sea in the direction of its water bearing and none in the opposite direction.
- A settlement with the port flag has a harbour district that touches the water.
- Each district's lots form one connected area.
- Residents per hectare of built area fall within the pack's density limits.
- Every ID referenced exists, IDs are unique, and lists are in ID order.

**Path function**

- A path exists between any two lots in every settlement.
- A path's length equals the sum of its segments' lengths plus the two partial segments at its ends.
- The path from a lot to itself has length zero.
- A path between lots on opposite banks of a river includes a bridge segment.

**Named settlements**

| Settlement | Check |
| --- | --- |
| Badanos (`settlement-641`) | 1,772 lots. Two exits, both on the Pusztaszian trail, near bearings 227 and 61. The river arrives near bearing 152 and leaves near 61. The arterial toward 61 never enters the water. The graph is connected across the river |
| Pombal (`settlement-5`), 47,603 residents, coastal port | Lays out in under 5 seconds. Its docks lie in the harbour district, which touches the sea |
| Vereceldo (`settlement-455`), 253 residents | Lays out with a single district and passes every invariant |
| Karlen (`settlement-8`), where a river ends | Lays out and passes every invariant |

**Determinism and isolation**

- The same city, brief, pack and seed give a byte-identical layout on repeated runs.
- Generating a layout does not change the city it was given.
- The Badanos baseline counts from phase 2.5 are unchanged, and `GENERATOR_VERSION` is still 2.
- A different seed gives a different layout that still passes every invariant.

**Pack edits take effect**

- Widening the river in a copy of the pack widens it in Badanos.
- Enlarging the default lot in a copy of the pack enlarges the town's built area.
- A lot size or street width of zero or less is rejected on load.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **Consumers read the format, never the generator.** The viewer, the API and the path function may use only what the format guarantees. If the town map would break on a curved street or a five-sided lot, it is wrong.
- **Layout is a separate module.** It reads a finished city and never reaches back to change it.
- **The brief's bearings are facts.** Exits and water must honour them; do not move an exit to make the grid tidier.
- **Regular is a feature here.** Do not spend effort making the town look organic. That is a later phase with its own brief.
- **Every number is in the pack.** Widths, block sizes, lot sizes, river width and density limits.
- **Report, don't relax.** If an invariant cannot hold for some settlement, name the settlement and the reason before changing the invariant or the pack. The 20-degree tolerance and the 5-second limit are my estimates; say so if either proves wrong.
- **Check the lot count.** If Badanos does not have 1,772 buildings under the default seed, report the figure you find before going further.

