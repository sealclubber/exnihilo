# District ground in the staged generator: what was dropped (Phase 6E)

2026-11-24.

## What was dropped

Making district ground pass the old rules was stopped. Now:

- **The rule.** A district's ground is each block's tile, and the plaza's
  and the castle's, given to the district holding most of its lots.
- **Removed from the generator.**
  - The passes that re-owned tiles to keep a district in one piece, both on
    the tile graph and on the drawn polygons.
  - The division of tiles shared by two districts.
  - The landmark strips and the bridge strips.
- **Removed from the invariants.**
  - One connected piece per district.
  - At least 97% of a district's lots inside its own ground.
  - A stray lot in a touching or bridge-linked district.
- **Kept.** The only district-ground rule left is that no two districts'
  grounds overlap. A layout still records its `bridgeLinks`.
- **Selection is unchanged.** It still makes each district's count exact
  by block moves, chains, single houses and the counted fallback.

What used to be required is now measured: `measureDistrictGround` in
`layout/measure.ts`, reported by `node scripts/staged-census.ts`.

## Census, all 682 settlements of Lomia

| Measure | Value |
| --- | --- |
| Settlements keeping every layout invariant | 682 of 682 |
| Lots outside their own district's ground | 3,049 of 540,856 (0.56%), in 371 settlements |
| Districts in more than one piece | 284 of 2,229, in 192 settlements |
| Of those, still in pieces when their own bridge links count as joins | 108 |
| Settlements using the non-touching fallback | 17, for 1,372 houses |

The full check passes with the grid still the pack's generator.

## Not done: switching the pack to the staged generator

With `generator: staged` in `packs/medieval/layout.yaml`, eight tests
fail. Two only expect the name `grid`. The rest share one cause: a staged
house's lot is its footprint and nothing more. Three things therefore have
no open ground:

- open-air workplaces (market stall, town yard, woodyard);
- visits spent outside;
- wanders.

The plan checker reports "is open-air but has no open ground to speak of",
and the wander tests find no wanders at all. A rounds target, half of
street points perceiving someone at 12:30, also measured 31% against 40%.

This needs a design choice before the switch. For example, an open-air
building's lot could be its house rectangle with a smaller footprint, as
the well's is. The switch and the version raise wait on that choice.

## Open design for a later phase

**Grow districts over kept blocks after selection.** Choose the town's
houses first, then grow each district over the blocks that hold kept
houses to its exact count, as one connected region. Ground then follows
the blocks, and exact counts and connected ground come from one process
instead of three that are reconciled afterwards: ward districts, house
districts and drawn ground.

The cost: district character (house size, lane density) is set per ward
before houses exist. It would have to be set another way, or the houses
re-laid once districts are known.
