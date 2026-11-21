# World Sim — Phase 6B Gameplan

Nov 21, 2026 · @seal

Phase 6B gives residents reasons to be on the street: civic buildings to go to, errands that chain, work that is done on foot such as a watch patrol, and walks taken for their own sake. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Put people on the streets for reasons that make sense, so that crowds form where and when they would: at wells in the morning, around the market before dinner, on the main street when a shift ends, with the watch walking its beat day and night.

**Done when:** all acceptance tests below pass, the targets in the next section are met or reported on, and standing on a typical Badanos street at midday you see people pass.

## Context

Phases 1 to 6A are complete. Read `CLAUDE.md`, the README, and the `city`, `layout` and `life` modules before starting.

**How little walking there is.** Badanos, day 1, a work day, 9,607 residents:

| Measure | Today | Target |
| --- | --- | --- |
| People walking at 12:30 | 31, which is 0.3% | At least 2% of residents |
| People walking at 07:50, the morning peak | 867 | Not lower than today |
| People perceived from a typical street point at 12:30, within 30 m | 0 | At least 1 |
| Watchmen on the streets at 12:30 and at 03:00 | 0 and 0 | At least one at each, and at every hour of the day |
| Trips per resident per day | Record it in task 1 | At least double today's figure |

The targets are estimates of what a lived-in town needs. Meet them through sensible behaviour, never by inflating a probability until a number is reached.

**Why it is so quiet.** A resident's day is home, one workplace, and perhaps one stop. Nobody fetches water, nobody runs two errands in a row, nobody's work takes them through the streets, and nobody walks without a destination. This phase adds those four things.

**Emergence is the point.** Crowds must come from many individual plans coinciding, each sensible on its own. Nothing in this phase may place people somewhere in order to make it look busy.

**This phase changes the city on purpose.** New civic buildings and their staff alter the generated city, so `GENERATOR_VERSION` rises and the Badanos baseline is recorded afresh. Population and workforce category counts must still not move.

**Everything stays a pure function of game time.** A patrol, an errand chain and a stroll are all derived from the person, the day and a seed, like every plan before them.

## Scope

**Build**

- Civic buildings that a settlement gets by population, in the city generator and the pack
- Errands that chain several stops, and visits that happen more than once a day
- Working rounds: work done on foot through the streets, including watch patrols
- Strolls
- Being out on the street in front of a building, as distinct from in its yard
- Viewer support for all of the above on the town map and in the panels

**Do not build**

- Travellers, caravans, tourists, adventurers or vagrants: anyone without a household in the town. That is phase 6C.
- Goods, stock, money or any effect of an errand beyond the walk and the stay
- Crime, arrests or any reaction of the watch to anyone
- Reactions between residents, or to the avatar
- Carts, animals or anything on the street that is not a person
- Changes to the street graph, lots or the layout generator's method
- Organic streets or building shapes

## Changes

### 1. Civic buildings by population

**Rule.** Besides the landmarks its flags give it, a settlement gets civic buildings according to its size.

- Extend the pack's landmark rules so that a building can be granted per so many residents, with a minimum population below which the settlement has none. A building may be unstaffed.
- The city generator spreads such buildings across districts in proportion to their residents, so that every part of town has a well and no district has them all.
- Staffed civic buildings take their workers from occupation slots in the usual way. Category counts must not change; occupation counts inside a category may.
- Give each new type a lot size in `layout.yaml`, and mark it `openAir` or `alwaysOpen` where that applies.
- The first set, as placeholders: wells (many, unstaffed, open air, always open), a bathhouse, a public oven, a granary, an infirmary, a town hall for cities, a guild hall for a town's leading trade, and an adventurers' guild hall. The adventurers themselves arrive in phase 6C; in this phase the hall has its staff and the occasional resident with business there.
- Raise `GENERATOR_VERSION` to 3 and record a new Badanos baseline, with a note of what changed and why.

### 2. Errands that chain and repeat

**Rule.** A visit may have several stops in a row before the person goes home, and a visit may happen more than once in a day.

- A visit's definition may list a sequence of stops, each with its own destination types, duration and chance of being included. The person walks from each stop to the next.
- A visit may give a number of times per day, as a range. Each occurrence is placed at a different time and must not collide with anything else in the plan.
- Opening hours apply to every stop. A closed stop is skipped; if nothing is left, the visit does not happen.
- Placeholders for the pack: fetching water from the nearest well several times a day, by people keeping house, servants and older children; a marketing round of market, baker and butcher before the evening meal; a visit to the bathhouse.

### 3. Working rounds

**Rule.** Some work is done on foot. An occupation may have a round, and then part of each shift is spent walking a circuit that starts and ends at the workplace.

- A round is a sequence of legs and stops inside the shift. Its definition in the pack gives: how much of the shift is spent on rounds, how many stops, how long each stop lasts, how far it ranges (the worker's district, or the whole town), and what a stop is.
- **A stop is either a building of given types or a point on a street.** A carter's stops are yards, warehouses and the market. A watchman's stops are points along his beat.
- A stop at a street point is a new kind of stay: at a segment and a point, outside, with no building. Whereabouts, the outside-stays query and the nearby query must all handle it.
- Rounds differ from day to day and from person to person, seeded as plans are.
- A worker on a round is at work. The rule that work happens only at one's own workplace becomes: at one's own workplace, or on a round from it.
- Placeholders for the pack: the watch on patrol across the whole town by day and by night; carters and porters delivering between yards, workshops and the market; pedlars working the streets; water carriers between wells and houses; a lamplighter round at sunset and sunrise if the pack has such an occupation or you add one.
- Close the gap in the watch between 18:00 and 22:00 by adjusting its shifts in the pack.

### 4. Strolls

**Rule.** A visit may be a stroll: a walk with no destination that leaves home, passes through one or more street points or public places, and returns.

- Its definition gives who, when, how likely, and how long a walk, like any visit.
- A stroll favours public places such as a market square or the waterside where the town has them.
- Placeholders: an evening walk on work days and a longer afternoon walk on rest days.

### 5. Out on the street

**Rule.** A visit marked outside may say where: on the lot's open ground, as now, or on the street in front of the building.

- Someone out on the street is at a point on the building's entrance segment, close to the entrance, and moves about a short stretch of it in the same way a wander works on a lot.
- In the `medieval` pack, children playing and elders sitting out are on the street in front of their home. With footprints against the frontage, the yard is behind the house and out of sight.

### 6. Viewer

- A person on a round is drawn like any walker and coloured by role; the person panel shows the round as part of the day's timeline, with its stops.
- Wells and the other new buildings show their occupants and opening state like any building.
- The day summary command reports walking by hour and the busiest segments, so that the targets can be read from it.

### Versions

`GENERATOR_VERSION` to 3, `LIFE_VERSION` to 4, and the pack's version raised. `LAYOUT_VERSION` changes only if the layout for the same city would differ.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Baseline.** Record for Badanos on day 1 and day 7: people walking by hour, trips per resident, the median number perceived from 100 seeded street points at 12:30, and the ten busiest segments.
2. **Cost tests.** The test that Badanos plans a day in under 1 second failed on a slower machine at 1.4 seconds. Give cost tests limits with real headroom, or make them compare against a measured reference, so they catch a regression without failing on a slow day.
3. **Civic buildings.** Change 1: pack rules, generator, lot sizes, new baseline.
4. **Chains and repeats.** Change 2.
5. **Street stops.** The new kind of stay, through records, whereabouts, the queries and the invariants.
6. **Rounds.** Change 3, starting with the watch.
7. **Strolls.** Change 4.
8. **Out on the street.** Change 5.
9. **Pack.** All the placeholders named above, with comments.
10. **Viewer.** Change 6.
11. **Measure.** Repeat task 1's measurements and set them beside the baseline and the targets in the README.
12. **Whole-world run, timing and wrap up.** README and `CLAUDE.md`.

## Acceptance tests

All of these are automated. Every existing test keeps passing, apart from those that pin the old baseline, which are updated with an explanation.

**City**

- Population, workforce and the seven category counts are unchanged in Badanos and in every settlement.
- Each civic building type appears in the numbers its pack rule gives, and not below its minimum population.
- Buildings spread by population are present in every district that has residents, where the settlement has at least as many as it has districts.
- All 682 settlements still generate and lay out with every invariant holding.

**Plans**, over the same residents and days as before

- Every existing plan invariant holds, with work allowed on a round.
- A chain's stops are visited in order, each open on arrival, with a walk between each pair.
- Occurrences of a repeated visit do not overlap each other or anything else.
- A round starts and ends at the worker's workplace and lies inside the shift.
- A street stop's point lies on the segment it names.
- A stroll starts and ends at home.
- Whereabouts are still a pure function of game time, and the nearby query still matches a brute-force check exactly, including people at street stops.

**Targets**, Badanos, day 1

| Measure | Baseline | Required |
| --- | --- | --- |
| Walking at 12:30 | 31 | At least 2% of residents |
| Walking at 07:50 | 867 | At least 867 |
| Median perceived from 100 seeded street points at 12:30 | 0 | At least 1 |
| Watchmen on the streets, checked on the hour through 24 hours | 0 at every hour | At least 1 at every hour |
| Trips per resident per day | From task 1 | At least double |

If a target cannot be met with behaviour that is sensible for a town, report the figure reached and what limits it. Do not raise a probability past what you would believe.

**Emergence**

- No plan depends on another person's plan.
- In Badanos the busiest segments at 12:30 include ones bordering the market, and at least one well has several people at it at some point in the morning.
- On the rest day the pattern differs from the work day: less walking at the shift hours and more in the afternoon.

**Pack behaviour**

- A pack with none of the new fields produces the same plans as `LIFE_VERSION` 3 for the same city.
- Removing an occupation's round returns its workers to their workplace for the whole shift.
- Setting wells to one per very many residents removes them, and water-fetching visits with them.
- A round whose stops name a missing building type, or a chain with no stops, is rejected on load.

**Cost**

- Report the time to plan one day for Badanos and for Pombal, before and after. More than three times slower needs an explanation.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **Crowds are consequences.** Never place, spawn or steer people to make somewhere look busy. If a place is busy, it is because many plans led there.
- **Believable before busy.** Every probability and count must be one you would defend for a town like this. The targets are a check on the design, not a quota.
- **No plan reads another plan.** Rounds and errands are derived from the person, the day and the town, never from where others are.
- **Still nothing stepped, still no day-to-day state.**
- **Setting knowledge stays in the pack.** Code knows that rounds, chains and strolls exist. Which occupations patrol and who fetches water are pack entries.
- **The watch leaves everyone alone.** A patrol is a presence on the street. It reacts to nothing.
- **The baseline changes once, deliberately.** Record what moved and why. Population and category counts do not move at all.

