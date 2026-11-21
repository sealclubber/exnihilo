# World Sim — Phase 4.5 Gameplan

Nov 21, 2026 · @seal

Phase 4.5 is a patch to daily life: places keep opening hours, an occupation can be split across shifts, and people can be seen outside when they are not walking somewhere. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Make a town's day coherent and visibly inhabited: nobody visits a place with no one there to serve them, the watch covers day and night, evenings have somewhere to go, and people who are outside but not walking can be seen on the map.

**Done when:** all acceptance tests below pass, and Badanos shows people at the market, children outside their homes and taverns in use after dark.

## Context

Phase 4 meets every acceptance test. These measurements of Badanos (`settlement-641`, default seed, day 1, a work day) show what its brief never specified:

| Measured | Cause |
| --- | --- |
| A night watchman finishes at 06:00 and visits a tavern whose staff work 15:00 to 23:00 | A visit checks that the building type exists, not that anyone is there |
| About 850 people go to market on the rest day, when stallholders do not work | The same |
| All 97 watchmen work the night shift; none is on duty by day | An occupation has exactly one shift |
| At 20:00 nobody is visiting anywhere and nobody is on the streets | The only tavern visit happens straight after work, so it is over by about 19:00 |
| No child is ever outside | Children were scoped out of phase 4 |
| At 12:30, 31 people are visible on the map out of 9,607 | Only people who are walking are drawn |

**Why the streets look empty.** The last row is the main reason, and it is a modelling gap, not a layout problem. In a town like this much of life happens outside: at market stalls, in yards, on doorsteps. Today a person is either walking or invisible inside a lot. This patch adds a third state, being outside at a place, and draws it.

## Scope

**Change**

- The `life` module: plans, queries and invariants
- The pack schema and the `medieval` pack
- The API views and the town map
- Tests, README and `CLAUDE.md`

**Do not change**

- The city generator or the layout generator. `GENERATOR_VERSION` and `LAYOUT_VERSION` stay as they are and the Badanos baseline counts must not move.
- The principle that whereabouts are a pure function of game time

**Do not build**

- Visits to particular people, such as friends or relatives; that needs relationships
- Capacity limits on visitors, queues or crowding
- Positions inside a building, or building footprints
- An avatar or any interaction between residents
- Shifts that rotate from week to week

## Changes

### 1. Opening hours

**Rule.** A building is open at a moment when at least one of the people who work there is on shift then. A visit goes only to a place that is open when the visitor arrives, and ends no later than it closes.

- Openness is worked out from shifts and rest-day duty, never from the workers' own plans. That keeps it a function of game time and avoids plans depending on each other.
- A building type may be marked `alwaysOpen` in the pack, for public places such as a market square that need no one in attendance.
- If closing time would cut a visit below its minimum duration, the visitor chooses another open destination, and if there is none the visit does not happen.
- Add queries for whether a building is open at a time, and for its opening hours on a day.

### 2. An occupation split across shifts

**Rule.** An occupation's `shift` is either one shift, as now, or a list of shifts with shares that sum to 1.

- Each worker gets one of the listed shifts and keeps it every day. Within a settlement the shares are met exactly, by the largest-remainder method, and who gets which is seeded.
- In the `medieval` pack, split the watch between day and night as a placeholder.

### 3. Being outside

**Rule.** A stay is either inside or outside. People who are outside are at a point on the map and are drawn.

- A building type may be marked `openAir` in the pack: market stalls, a market square, docks, yards. Everyone staying there, worker or visitor, is outside.
- A visit may be marked `outside` in the pack, which puts the visitor outside whatever the building type.
- An outside stay carries a point inside the building's lot. The point is derived from the person, the building and the stay, and does not move during the stay.
- Whereabouts for an outside stay include the point. The day summary gains a count of people outside.
- **Send stays, not positions.** Alongside trips, the server sends the outside stays that overlap a window of game time: who, where, from when, until when.

### 4. Home as a destination, and children

**Rule.** A visit's destinations may include `home`, meaning the person's own dwelling. Together with `outside` this means outside their own home, with no walk to get there.

- Add placeholder visits to the pack: children of playing age outside their home in the morning and afternoon, and elders outside their home in the early evening.
- Children below the playing age stay inside, as now.

### 5. More visits

Pack entries only, as placeholders:

- A tavern visit in the evening, made from home.
- A rest-day afternoon visit to the market square, where the settlement has one.
- A visit may name `weekdays` from the calendar to limit it to those days. Use this to make the market busier on Marketday.

### 6. Town map

- People outside are drawn at their points, and look different from people walking.
- Clicking one opens the same person panel as for a walker.
- A building's panel shows whether it is open now and its hours today.
- The count of people shows walking and outside separately.

### Versions

Daily life has no version constant yet. Add `LIFE_VERSION` beside the life records, set it to 2, record it in `CLAUDE.md` with the other two, and raise the pack's version.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Baseline.** Before changing code, record for Badanos on day 1 and day 7 the hourly counts and the number of visits per kind, as a reference for the before-and-after table.
2. **Schemas.** The new pack fields and record fields, each optional so that a pack without them behaves as phase 4 does.
3. **Split shifts.** Change 2.
4. **Opening hours.** Change 1, with the two queries.
5. **Outside stays.** Change 3.
6. **Home as a destination.** Change 4.
7. **Pack.** The flags, the split watch, and the new visits, with comments.
8. **Invariants.** Add every new rule to the plan checker.
9. **API and town map.** Change 6.
10. **Whole-world run and timing.**
11. **Wrap up.** Versions, README and `CLAUDE.md`.

## Acceptance tests

All of these are automated. Every existing test keeps passing.

**New plan invariants**, checked over the same residents and days as the existing ones

- Every visit's destination is open when the visitor arrives, and the visit ends by closing time.
- A worker in a split occupation has the same shift every day, and within each settlement the shares are met exactly.
- A stay is outside exactly when its building type is open-air or its visit is marked outside.
- An outside stay's point lies inside its building's lot and is the same for the whole stay.
- A visit to `home` involves no travel.

**Badanos, before and after**

| Measure | Phase 4 | Required |
| --- | --- | --- |
| Visits arriving at a closed place, over a week | Present, for example a watchman at a tavern at 06:16 | 0 |
| Watchmen at work at 12:30 on a work day | 0 of 97 | The day share from the pack |
| Watchmen at work at 03:00 after a work day | 97 of 97 | The night share from the pack |
| People on a visit at 20:30 on a work day | 0 | More than 0, all in open places; report the figure |
| Children outside at 15:00 on a work day | 0 | More than 0; report the figure |
| Anyone outside during their own sleeping hours | n/a | 0 |
| People visible on the map at 12:30 on a work day, walking or outside | 31 | At least 300. This is an estimate; report the figure |
| Market visits on the rest day | About 850, to closed stalls | Only to places that are open or always open |

**Unchanged**

- `GENERATOR_VERSION`, `LAYOUT_VERSION` and the Badanos baseline counts.
- Whereabouts are still a pure function of game time: the determinism tests from phase 4 pass as they are.

**Pack behaviour**

- A pack with none of the new fields produces the same plans as phase 4.
- Marking a building type `alwaysOpen` lets it be visited at night.
- Removing `openAir` from a type removes its outside stays.
- Shift shares that do not sum to 1, or a visit naming a weekday the calendar lacks, are rejected on load with a message naming the entry. `home` is accepted as a destination in any visit.

**Cost**

- Planning one day for Badanos stays under 1 second. Phase 4 took about 0.12; report the new figure.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this patch:

- **Openness comes from shifts, not plans.** One person's plan must never depend on another person's plan.
- **Still nothing stepped, still no day-to-day state.** An outside point is derived, not remembered.
- **Flags live in the pack.** Code must not know which building types are open-air or always open.
- **Placeholders stay placeholders.** Ages for play, visit probabilities and shift shares are first guesses; say so in the pack's comments.
- **Report, don't relax.** The figure of 300 visible people is my estimate. If the pack's placeholders give fewer, report the number and what drives it before changing the test or inflating a probability.

