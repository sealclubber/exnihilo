# World Sim — Phase 6C Gameplan

Nov 21, 2026 · @seal

Phase 6C brings people to town who do not live there: merchants, tourists, adventurers and people passing through, arriving and leaving by the roads, plus a small number of vagrants who live on the streets. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Make a town a place people come to and pass through. Travellers arrive by the roads and the sea, find lodging, go about their business and leave; a town with something to see draws tourists and grows a quarter that serves them; and a few people with no home sleep where they can.

**Done when:** all acceptance tests below pass, and in Badanos you can watch a party come in along the Pusztaszian trail from Pusztaszi, walk to an inn, spend a day in town and leave toward Veszfetaros, while in Pombal the visitors' quarter is busy every day.

## Context

Phases 1 to 6B.5 are complete. Read `CLAUDE.md`, the README, and the `city`, `layout`, `life` and `avatar` modules before starting.

**The first people who are not residents.** Until now everyone in a town belongs to a household there, and the town holds exactly the brief's population. This phase adds people outside that count. They are called **outsiders** here, in two groups:

| Group | Who | How long they are around |
| --- | --- | --- |
| Travellers | Merchants, tourists, adventurers and mercenaries, people passing through | Hours to days, then they leave |
| Vagrants | People with no household or dwelling | Always; they live on the streets |

**Residents are untouched.** A town's residents, households and the counts pinned by the baseline do not change because outsiders exist. Outsiders are never added to the population.

**Outsiders obey the same rule as everyone.** Who is in town on a given day, and where each of them is at a given moment, is a pure function of the settlement, the day and a seed. Nothing is stepped and nothing is remembered.

- A traveller's whole visit is derived from the day they arrive: their party, where they came from, how long they stay, where they lodge, and when and how they leave.
- So the people in town on a day are the arrivals of that day plus those of earlier days whose stay has not ended. That set can be computed for any day without computing the days before it.
- Vagrants are a fixed, seeded set per settlement.

**Where they come from matters.** The brief knows which way each route leaves town but not where it goes. This phase teaches it, because "a merchant from Pusztaszi" is worth far more than "a merchant", now and when residents can be talked to.

## Scope

**Build**

- Where each route leads, in the settlement brief
- A town's draw, computed from its brief by pack rules
- Lodging, and a visitors' quarter in towns whose draw is high enough, in the city generator
- An `outsiders` module in `core`: travellers and vagrants, their records and their days
- Outsiders in every whereabouts query, in perception, and on the town map
- A fix to how civic buildings are spaced inside a district

**Do not change**

- Residents' identities, households, jobs or homes. Population and category counts must not move.
- The rule that the watch reacts to nobody

**Do not build**

- Travel between settlements as a simulation; a traveller appears at an exit and disappears at one
- Goods, money, trade or prices; a merchant is a person with a purpose, not a cargo
- Carts, animals or ships as objects
- Crime, begging as a mechanic, charity or any interaction between outsiders and residents
- Lodging capacity, full inns or being turned away
- Residents who travel away from town
- Reactions to the avatar

## Changes

### 1. Where each route leads

**Rule.** Each route exit in the brief says which settlement is next along that route in that direction, where there is one.

- This is importer work. Follow the route from the settlement's cell and record the first settlement reached: its ID, name, size group, population, culture and state names, and the distance along the route.
- A sea route leads to the next port on it. A route that reaches no settlement leaves the field absent.
- Nothing else in the brief changes.

### 2. A town's draw

**Rule.** A settlement's draw is a number computed from its brief by rules in the pack. It says how much the place attracts visitors who have no business there.

- A new pack file, `travellers.yaml`, gives the terms: a weight per flag and status (capital, port, temple, citadel, plaza, walls, province seat), a term for sheer population, a term for specialties, and a floor.
- Below the floor a settlement draws no tourists at all. A village of a hundred people with nothing to see gets none; a very large town with no features still gets some, from its population term.
- The function returns the number and its breakdown by term, so the viewer can show why.

### 3. Lodging and a visitors' quarter

**Rule.** A town expecting travellers has inns, and a town whose draw passes a threshold has a quarter that serves visitors.

- Add an inn building type, with a household living in it. Its count follows the number of travellers the pack's rules expect per day, so extend the count rule to allow that. Innkeepers work at inns; add the few supporting occupations an inn needs.
- Add a district kind for visitors, created only when the draw reaches the pack's threshold. The pack says where it sits and which building types belong to it; those types fall back to the centre in a town without the quarter.
- Seed the quarter with a small, neutral set of placeholder types: inns, a playhouse, a gaming house. **The user will add their own types and names for this quarter.** Build the mechanism so that doing so is a pack edit.
- Category counts must not change. Occupation counts inside a category may, and the baseline is recorded afresh with a note.

### 4. Travellers

**Rule.** Each day a number of parties arrive, by kind, according to pack rules. Each party's whole visit is derived from its arrival day.

- **Kinds** are pack entries. Each gives: how many arrive per day and what that depends on (population, the number and kind of route exits, the draw, the day of the week), party size, length of stay, hours of arrival, where they lodge, what they do in town, and how they leave.
- **Placeholders:** merchants, tourists, adventurers, mercenaries, and people passing through. Tourists depend on the draw. Adventurers and mercenaries lodge at the adventurers' guild hall or an inn and spend their time there and in taverns. People passing through may not lodge at all, and leave by a different exit when the town has more than one.
- **A traveller** has an ID, a kind, a party, a name, an age and sex, an origin, an arrival time and exit, a departure time and exit, and a lodging if any.
- **Origin** comes from change 1: the settlement the entry route leads from. Where the brief gives none, the origin is the route itself.
- **A day in town** is a plan like a resident's: they enter at an exit junction, walk to their lodging, make visits defined in the pack for their kind, sleep at their lodging, and on their last day walk to an exit and are gone. Opening hours apply to them as to anyone.
- **A party moves together.** Its members share one plan.
- **Who is in town on a day** is every party whose stay covers that day. It must be computable for any day directly.

### 5. Vagrants

**Rule.** A settlement above a minimum size has a small, fixed number of people with no household and no dwelling.

- Their number is a share of the population from the pack. The set is seeded per settlement and is the same every day.
- **At night** each sleeps at a point on the street, standing still. The pack says which places are allowed: lanes, the ends of bridges, and streets at the town's edge. A vagrant keeps a spot for a run of days and then may move.
- **By day** they drift between public places: outside chapels and taverns, at wells, in the market square, using the existing forms of being outside and of strolling.
- They never lodge and never work. The watch does nothing about them.

### 6. One population for every query

- Whereabouts, occupants, trips and outside stays in a window, the nearby query and the day summary all include outsiders, marked as such.
- The avatar perceives outsiders exactly as it perceives residents.
- Residents' plans must be identical whether or not outsiders are computed.

### 7. Viewer

- Outsiders are drawn with their own colours from `display.yaml`, one per traveller kind and one for vagrants, and appear in the legend.
- Hovering one shows their kind and where they are from.
- An outsider's panel shows kind, party, origin, when they arrived and when they leave, lodging, and today's plan.
- A collapsible **In town today** pane lists outsiders by kind with counts.
- An inn's panel lists its guests.
- The settlement panel shows the draw with its breakdown, and where each route leads.

### 8. Spacing civic buildings

In Badanos four of Mill Row's six wells open onto the same stretch of street. The rule from phase 6B.5 that keeps spread buildings apart inside a district must also cover civic buildings.

### Versions

`GENERATOR_VERSION` to 5, `LAYOUT_VERSION` to 4, `LIFE_VERSION` to 5, and the pack's version raised.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Baseline.** Record for Badanos, Pombal and Vereceldo: people on the streets by hour, and phase 6B's target figures.
2. **Spacing civic buildings.** Change 8, first, as it is independent.
3. **Where routes lead.** Change 1, in the importer and the brief.
4. **Draw.** Change 2.
5. **Lodging and the visitors' quarter.** Change 3, with the new baseline.
6. **Outsider records and the travellers' pack file.**
7. **Arrivals and who is in town.** The pure functions of settlement and day.
8. **Travellers' days.** Entering, lodging, visits, leaving.
9. **Vagrants.** Change 5.
10. **Queries and perception.** Change 6.
11. **Viewer.** Change 7.
12. **Measure.** Repeat task 1 with outsiders and set the figures side by side in the README, with the ten settlements of highest draw and how many settlements get a visitors' quarter.
13. **Whole-world run, timing and wrap up.** README and `CLAUDE.md`.

## Acceptance tests

All of these are automated. Every existing test keeps passing, apart from those that pin a baseline this phase changes, which are updated with an explanation.

**Routes**

- From Badanos the Pusztaszian trail leads to Pusztaszi at bearing 227 and to Veszfetaros at bearing 61.
- Across Lomia, every settlement a route leads to exists, and if a route leads from A to B then the same route leads from B to A.
- Apart from the new field, every brief is identical to before.

**Draw**

- A made-up village of 100 residents with no flags and no specialty is below the floor and receives no tourist on any of 30 days.
- A made-up town of 40,000 residents with no flags is above the floor and receives tourists.
- Adding any flag to a brief never lowers its draw.
- In Lomia, Pombal's draw is higher than Badanos's, which is higher than Vereceldo's.

**City**, for every one of the 682 settlements

- Population and the seven category counts are unchanged.
- A settlement that expects travellers has at least one inn.
- A settlement has a visitors' quarter exactly when its draw reaches the threshold.
- Every city and layout invariant holds.
- Inside a district, no two civic buildings of a spread type open onto the same segment while another segment of the district has none.

**Travellers**

- The arrivals of a day are identical however they are asked for, and whatever was computed first.
- The people in town on a day equal, by brute force, every party from earlier days whose stay covers it plus that day's arrivals.
- Every traveller enters at an exit junction and leaves at one, walking on the street graph, and is nowhere before arriving or after leaving.
- Members of a party are in the same place at every moment.
- A traveller's origin is the settlement their entry route leads from, where the brief names one.
- In a town with more than one exit, people passing through leave by a different exit from the one they entered.
- A traveller's plan passes the same invariants as a resident's for the time they are in town, including continuity across midnight and opening hours.

**Vagrants**

- Their number is the pack's share of the population, and the set is the same on every day.
- At 03:00 every vagrant is at a street point of a kind the pack allows, standing still.
- No vagrant is ever inside a dwelling or an inn.
- A settlement below the pack's minimum size has none.

**Residents are untouched**

- Every resident's plan in Badanos over eight days is identical with and without outsiders computed.

**Queries**

- The nearby query matches a brute-force check exactly with outsiders present.
- The day summary reports outsiders separately from residents.

**Magnitudes.** These are estimates; report the figures.

| Settlement | Travellers in town on a typical work day |
| --- | --- |
| Badanos, 9,607 residents, one trail, no flags | Between 0.5% and 3% of its residents |
| Pombal, 47,603 residents, capital and port | A higher share than Badanos |
| Vereceldo, 253 residents | No tourists, and at most a handful of others |

**Pack behaviour**

- Removing a traveller kind in a copy of the pack removes those travellers and nobody else.
- Doubling a kind's rate roughly doubles its arrivals averaged over 30 days.
- A vagrant share of 0 gives none.
- A kind that names a missing lodging type, or a visit, is rejected on load.

**Viewer**, in a headless browser

- An outsider shows kind and origin on hover, and has a panel.
- The In town today pane lists outsiders by kind and collapses like the others.
- The legend includes the outsider colours in use.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **Outsiders are never residents.** They are not in the city's people, households or counts. The baseline's population figures do not move.
- **A visit is derived from its arrival day.** No list of who is currently in town is kept anywhere. Asking about day 40 must not require computing days 1 to 39.
- **Still nothing stepped.** A party walking in from an exit is a trip like any other.
- **Only the importer learns where routes lead.** The generator still reads nothing but the brief.
- **Setting content is the user's.** The visitors' quarter ships with neutral placeholders. Do not add, name or omit entertainment types on your own judgement beyond those listed; the user will fill it in.
- **The watch leaves everyone alone,** vagrants included.
- **Believable before busy.** Arrival rates must be ones you would defend for a town of that size on that road. The magnitudes above are a check, not a quota.
- **Report, don't relax.**

