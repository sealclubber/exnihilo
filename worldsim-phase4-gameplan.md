# World Sim — Phase 4 Gameplan

Nov 20, 2026 · @seal

Phase 4 gives every resident a day: they wake, walk to work, make a stop or two, come home and sleep, with rest days, on a clock the user can speed up, slow down and pause. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Give every resident a plan for every day and a position at every moment, and show the town living through its day on the town map under a clock the user controls.

**Done when:** all acceptance tests below pass, and in Badanos you can watch the morning walk to work in real time, speed it up, pause it, jump to the next morning, click any moving person to see who they are and what their day holds, and click any building to see who is inside.

## Context

Phases 1 to 3 are complete: a city of linked residents, households and buildings, laid out as a street graph with a lot and an entrance for every building, plus a shortest-path function. Read `CLAUDE.md`, the README, and the `city` and `layout` modules before starting.

**The one idea this phase rests on.** A resident's whereabouts are a pure function of game time. Nothing is stepped forward tick by tick.

- A **day plan** is derived from the person, the day number, the city, the layout, the pack and a seed.
- A **trip** inside a plan is a path, a departure time and a speed, so the position at any moment during it is arithmetic.
- Therefore `where is this person at time t` has one answer, computed on demand, for any `t`.

This is what makes the clock's rate irrelevant to the simulation. One game day can take 48 real minutes, 24 real hours or 5 seconds, and the user can pause or jump to another time, without anything going wrong: there is no accumulated state to corrupt and nobody can overshoot a destination.

**No distance limits.** A commute takes the game time its length requires. At the default rate, which is real time, people walk at walking pace; at faster rates they move quickly on screen. Homes and workplaces stay where the city generator put them.

**Everything here is derived.** Plans and positions are recomputed from their inputs and never stored. The only new stored state is the clock.

## Scope

**Build**

- A calendar and day plans, in a new `life` module in `core`
- Trips and the whereabouts queries
- Calendar, shifts, visits and walking speeds in the `medieval` pack
- A world clock in `server`, with rate control and persistence
- A way for the viewer to get trips and occupancy for a window of game time
- Moving residents, clock controls and person and building panels in the town map
- A command that prints a settlement's day as a text summary

**Do not change**

- The city generator or the layout generator. `GENERATOR_VERSION` and `LAYOUT_VERSION` stay as they are, and the Badanos baseline counts must not move.

**Do not build**

- An avatar, or anything the user controls inside the town
- Encounters, reactions, conversation or any interaction between residents
- Needs, moods, health, money or any state that carries over from day to day
- Friendships or any relationship beyond household and employment
- Seasons, weather, festivals or one-off events
- Activities for young children beyond being at home
- Building interiors, or positions inside a lot
- Any stored state other than the clock

## Time

**Game time** is a whole number of game seconds since the start of day 1 of the world's current year. A day is 24 hours of 60 minutes. Everything in `core` takes game time as an argument; `core` never reads a clock.

**The calendar** comes from the pack: the number of days in a week, their names, which are rest days, the number of days in a year, and the hours of sunrise and sunset. From a game time, `core` derives the day number, the day of the week, whether it is a rest day, the time of day, and whether it is light.

**The clock** lives in `server`. Its state is a game time, a rate and whether it is running.

- **Rate** is game seconds per real second. The pack lists the presets and the default. The default is 1, which is real time. The presets include faster rates, among them 30, which is 48 real minutes per game day.
- The server computes the current game time from an anchor (a real moment and the game time at that moment) and the rate. Changing the rate or pausing re-anchors, so game time never jumps.
- The user can also set the game time directly, to jump forward or back.
- The clock is stored in the world store whenever it is paused, re-anchored or set, and on shutdown. On start it is restored, paused.
- The real-time source is injectable so tests can drive it.

## Day plans

A day plan is an ordered list of activities that covers one person's day from midnight to midnight with no gaps and no overlaps.

| Activity | Where | Notes |
| --- | --- | --- |
| Sleep | Home |  |
| At home | Home | Awake |
| Work | Workplace | The person's workplace building, which may be their own home or an employer's home |
| Visit | Another building | A stop such as a market, a tavern or a place of worship |
| Travel | On the street graph | A trip from one building to the next: the path, the departure time, the arrival time |

Every plan is a pure function of the person, the day number, the city, the layout, the pack and the seed. Its random stream is derived from the seed, the person's ID and the day number, so a plan never depends on which other plans were computed, or in what order.

**The base routine** is wake, go to work, come home, sleep. It applies to everyone in the workforce on a work day.

- **Shift.** Each occupation has a shift from the pack: start, end and the days it applies. The person leaves home early enough to arrive for the start.
- **Personal offset.** Each person has a fixed habit, earlier or later by a few minutes, the same every day. Each day adds a smaller variation.
- **Working at home.** A person whose workplace is their own dwelling has no commute.
- **Apprentices** keep their workplace's shift.

**Rest days.** On a rest day nobody works unless their occupation works rest days. Those occupations use a rota from the pack, so that a share of their workers is on duty and the rest are off.

**Night work.** A shift may cross midnight. A person's whereabouts must be continuous from one day's plan to the next, including for night workers.

**Secondary stops** are visits defined in the pack: who makes them, on which kind of day, how likely, at what point in the day, for how long, and to which building types. A stop made on the way home from work goes between leaving work and arriving home. The destination is chosen among buildings of an allowed type, favouring nearer ones. If the settlement has no building of that type, the visit does not happen.

**People outside the workforce.**

- Someone keeping house is at home, with visits such as going to market.
- Elders are at home, with occasional visits.
- Children too young to work are at home.

**Sleep.** Everyone sleeps at home, at times set by the pack and shifted to fit their shift.

## Movement and queries

**Trips.** A trip follows the shortest path between two lots' entrances, using the existing path function. Its duration is the path's length divided by the person's walking speed, which comes from the pack by species and age. The position at a moment during the trip is the point that far along the path. A trip between two buildings on the same lot, or the same building, takes no time.

**Queries.** These pure functions in `core` are what the server, the viewer and later phases use:

| Question | Answer |
| --- | --- |
| What is this person's plan for this day? | The ordered activities |
| Where is this person at this time? | Their activity, and either the building they are in or their point and segment on the street |
| Who is in this building at this time? | The people inside, with their activity |
| Which trips overlap this window of time? | Each trip's person, path, departure and arrival, optionally limited to a region of the map |
| What does this settlement's day look like? | Counts per hour of people asleep, at home, at work, visiting and travelling |

**Cost.** Plans are computed on demand and may be cached in memory by settlement and day. The path function is called very often; prepare whatever lookup tables it needs once per layout.

## Pack additions

All values are placeholders, with the usual comments at the top of each file.

| File | Holds |
| --- | --- |
| `calendar.yaml` | Days per week and their names, the rest days, days per year, sunrise and sunset |
| `time.yaml` | The clock's rate presets and the default rate |
| `shifts.yaml` | Named shifts: start, end, whether worked on rest days, and for those the share on duty. One is the default |
| `occupations.yaml` | An optional `shift` per occupation, naming one from `shifts.yaml` |
| `visits.yaml` | Each kind of visit: who, which days, probability, point in the day, duration range, destination building types |
| `species.yaml` | Walking speed by age band, usual sleep hours, and the size of the personal and daily variations |

The first pack should include at least: a day shift as the default, an early shift for trades such as baking, an evening shift for taverns, a night shift for the watch, and rest-day duty for the watch, taverns and clergy. Visits should include at least a market stop for people keeping house, a tavern stop after work, and worship on rest days.

Raise the pack's version.

## Server and viewer

**Server**

- Endpoints to read the clock and to change it: run, pause, set the rate, set the game time.
- The viewer must learn of clock changes promptly. A WebSocket is the expected way; say so if you choose otherwise.
- **Send trips, not positions.** The server sends the trips that overlap a window of game time, and the viewer moves each dot along its path itself using the clock. This keeps motion smooth at any rate and keeps the client free of `core` logic.
- Endpoints for a person's plan, a person's whereabouts now, and a building's occupants now.

**Viewer, on the town map**

- Residents on the street drawn as moving dots.
- A clock showing the day name, whether it is a rest day, and the time, with a visible difference between day and night.
- Controls: pause and run, the rate presets, and jumps to the next morning, midday and evening.
- A count of people currently on the streets.
- Clicking a dot opens a person panel: who they are, what they are doing now, and today's plan as a timeline. A follow option keeps the map centred on them.
- Clicking a lot shows who is inside now, as well as who lives and works there.
- In the inspector's household view, each member's current activity.

**Command.** One command prints a settlement's day as text: the hourly counts and the busiest segments.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Calendar.** Game time, the calendar schema and the functions that derive day, weekday, rest day and time of day.
2. **Pack.** The new files and fields, their schemas, and the first values.
3. **Plan records and invariants.** The activity and plan schemas, and a function that returns one line per broken rule for a plan.
4. **Base routine.** Plans for workers on a work day, with shifts, offsets and working at home.
5. **Everyone else.** People keeping house, elders and children.
6. **Rest days and rotas.**
7. **Night work and continuity across midnight.**
8. **Visits.**
9. **Queries.** Whereabouts, occupancy, trips in a window, and the day summary.
10. **Clock.** In `server`, with an injectable real-time source, rate changes, pause, set, and persistence.
11. **API and transport.**
12. **Viewer.**
13. **Command.**
14. **Whole-world run and timing.** Record the results in the README.
15. **Wrap up.** Update the README and `CLAUDE.md`.

## Acceptance tests

All of these are automated and run against the Lomia fixture with the `medieval` pack. Every existing test keeps passing.

**Plan invariants.** Checked for every resident of Badanos and Vereceldo on each of eight consecutive days, and for a seeded sample of residents in every other settlement on day 1.

- A plan covers the whole day with no gaps and no overlaps.
- Each activity begins where the previous one ended, and a travel activity joins two different buildings.
- A trip's duration equals its path length divided by the person's walking speed.
- A person's whereabouts at the end of one day equal their whereabouts at the start of the next.
- Work happens only at the person's own workplace, and only for people in the workforce.
- Every building in a plan exists, and every visit goes to a building type that visit allows.

**Behaviour**

- On a work day, at the midpoint of the default shift, at least 95% of the workers on that shift are in their workplace.
- On a rest day, nobody on a shift that does not work rest days is at work, and the share on duty in each rota occupation matches the pack.
- At 03:00 on any day, at least 95% of residents are asleep at home, and every night-shift worker on duty is at work.
- No child below the species' working age has a work activity.
- On a work day in Badanos, the busiest hour for travel falls within an hour of the start or the end of the default shift.
- On a work day in Badanos, the bridge carries more trips than the median segment.

**Determinism**

- The same inputs give an identical plan.
- A person's plan for a day is the same whether or not other people's plans, or other days, were computed first.
- Whereabouts depend only on game time: asking in a different order, or after jumping the clock back and forth, gives the same answers.

**Clock**, using the injected real-time source

- At rate 30, two real seconds advance game time by 60 seconds. At rate 1, by 2 seconds.
- While paused, game time does not advance.
- Changing the rate does not change the current game time.
- Setting the game time takes effect immediately, forward or back.
- After a restart the clock holds the stored game time and is paused.

**Pack edits take effect**

- Moving a shift's start an hour later moves its workers' arrivals an hour later.
- With no rest days in a copy of the pack, workers work every day.
- Doubling walking speed halves every trip's duration.
- A shift that ends before it starts without being marked as crossing midnight, or a visit naming a missing building type, is rejected on load.

**Independence from the layout generator**

- The `life` module imports the layout format and the path function, and nothing from the grid generator.

**Cost**

- Planning one day for all 9,607 residents of Badanos takes under 3 seconds on one core. This is an estimate; report the figure.
- Report the time to plan one day for Pombal's 47,603 residents.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **Nothing is stepped.** There is no tick that moves people. If you find yourself updating a person's position from their previous position, stop: position comes from the plan and the game time.
- **No day-to-day state.** A plan may depend on the day number and on the previous day's plan only as far as continuity across midnight requires. Nothing accumulates.
- **`core` never reads a clock.** Game time is always an argument.
- **The client stays thin.** It moves dots along paths it was sent and draws a clock. It does not plan, choose or decide.
- **Every number is in the pack**: hours, probabilities, durations, speeds, variations and rates.
- **Setting content is the user's.** Which occupations work nights or rest days, and at what age people do what, are pack values. Choose plausible placeholders and say they are placeholders.
- **Report, don't relax.** The 95% thresholds and the 3-second limit are my estimates. If one cannot be met, report what was reached and why before changing it.

