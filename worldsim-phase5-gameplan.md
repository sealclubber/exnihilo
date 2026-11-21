# World Sim — Phase 5 Gameplan

Nov 21, 2026 · @seal

Phase 5 puts the user in the town: an avatar that is spawned on a street, walks the street graph, enters buildings, and can see who is nearby. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Let the user be somewhere in the town: spawn an avatar on a street, walk it to any street point or building, go inside, and at every moment see who is nearby and who they are.

**Done when:** all acceptance tests below pass, and in Badanos you can spawn on a street at 07:45, watch the morning walk pass around you in real time, follow someone to their workplace, step inside and see who else is there.

## Context

Phases 1 to 4.5 are complete. Every resident has a plan for every day; their whereabouts are a pure function of game time; people who are walking or outside are drawn on the town map; and a world clock runs at a rate the user controls, in real time by default. Read `CLAUDE.md`, the README, and the `layout` and `life` modules before starting.

**The avatar follows the same rule as everyone else.** It is never stepped. Its state is either a resting place or a trip: a path, a departure time and a speed. Its position at any game time is arithmetic on that state. So pausing, changing the rate and jumping the clock all work for the avatar exactly as they do for residents.

**The avatar is the first thing in the world that the user decides.** It cannot be derived from a seed, so it is stored, like the clock. Nothing else in this phase is stored.

**Residents do not react yet.** They cannot see the avatar, and their plans do not change because of it. Making a resident stop and talk means overriding a plan, which belongs to the conversation phase. This phase is about presence and perception.

## Scope

**Build**

- Paths between any two positions on the street graph, not only between lots
- An `avatar` module in `core`: the avatar's state and the pure functions on it
- A nearby query in the `life` module
- Avatar settings in the pack
- Avatar storage, endpoints and change notices in `server`
- Avatar controls, a follow camera and an "around you" panel on the town map

**Do not change**

- Residents' plans. `LIFE_VERSION`, `LAYOUT_VERSION` and `GENERATOR_VERSION` stay as they are, and the Badanos baseline counts must not move.

**Do not build**

- Any reaction by residents to the avatar
- Conversation, or any LLM feature
- Building interiors, or movement inside a lot
- Travel between settlements; moving the avatar to another town is a fresh spawn
- Limits on what the avatar knows about a stranger; the panel may show a resident's full record for now
- An avatar body with stats, inventory or needs
- More than one avatar

## The avatar

**State.** One avatar per world. It is absent until first spawned. When present it is in one settlement and in one of three conditions:

| Condition | What is recorded |
| --- | --- |
| Standing on a street | The segment and the point on it |
| In a building | The building |
| Walking | A trip: the path, the game time of departure, the speed, and what it is heading for |

**Position** is a pure function in `core` of this state and a game time. A walk that has reached its arrival time counts as arrived: standing at the street point, or in the building, it was heading for. A game time before the departure gives the starting point.

**Actions.** Each takes the current game time and returns a new state.

- **Spawn** at a point in a settlement: the avatar stands at the nearest point on the nearest street segment.
- **Walk to a street point**: a trip along the shortest path from where the avatar is now.
- **Walk to a building**: a trip to that building's lot entrance, after which the avatar is in the building.
- **Stop**: the avatar stands where it is at this moment.
- **Leave a building**: the avatar stands at the lot's entrance point.
- A new walk ordered during a walk starts from the avatar's position at that moment.

**Speed** comes from the pack. Because movement is in game time, the avatar is as fast on screen as the clock's rate makes it, like everyone else.

**Paths between street positions.** The path function currently joins two lots. Generalise it to join any two positions on the graph, each being a segment and a point on it, with lots as the special case of their entrance. Both ends may lie on the same segment.

## Perception

**The nearby query.** Add to the `life` module a pure function: given a point, a radius and a game time, return every resident within that distance at that moment, nearest first. Each entry gives the person, the distance, and what they are doing: walking between two buildings, or outside at a building.

**What the avatar perceives** depends on where it is:

| Avatar is | It perceives |
| --- | --- |
| On a street, standing or walking | Residents walking or outside within the perception radius |
| In a building | Everyone at that building, inside or outside on its lot |

People inside a building are not perceived from the street, and people on the street are not perceived from inside.

The perception radius comes from the pack. The query has to answer quickly enough to be asked about once a real second for a town the size of Pombal, so it needs an index and must not scan every resident.

## Pack, server and viewer

**Pack.** A new `avatar.yaml`: walking speed in metres per second, and perception radius in metres. Both are placeholders. Raise the pack's version.

**Server**

- Store the avatar's state in the world store, written whenever it changes, and restore it on start.
- Endpoints to read the avatar, and for each action: spawn, walk to a street point, walk to a building, stop, leave.
- An endpoint for what the avatar perceives now.
- Notify the viewer of avatar changes the same way it is notified of clock changes.
- **Send the trip, not positions.** The viewer receives the avatar's state and moves it along its path itself, as it does for residents.

**Viewer, on the town map**

- **Spawn here:** an action on any point of the map that places the avatar on the nearest street.
- The avatar is drawn distinctly, with its perception radius shown around it.
- Clicking a street point or a lot while the avatar is present offers to walk there. Selecting and inspecting, as today, must remain possible without moving the avatar.
- A **follow** option keeps the map centred on the avatar, at a zoom where a street fills the view.
- An **around you** panel lists who the avatar perceives, nearest first, with name, age, occupation and what they are doing. Clicking an entry opens the existing person panel. In a building the panel lists its occupants and offers to leave.
- Residents the avatar perceives are highlighted on the map.
- From the person panel, an action to walk to where that person is now, and one to walk to their home or workplace.

Keep the plain look. The natural-looking town is a later phase.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Test timeouts.** One existing test, `the plan checker > reports each new rule when it is broken` in `life-places.test.ts`, took 5.9 seconds on a slower machine against the default limit of 5. Give the slow tests explicit timeouts with headroom.
2. **Paths between street positions.** Generalise the path function, keeping the lot-to-lot form working unchanged.
3. **Avatar state and functions.** Schemas, position at a time, and each action, in `core`.
4. **Nearby query.** With its index, in the `life` module.
5. **Pack.** `avatar.yaml` and its schema.
6. **Storage and endpoints.**
7. **Notices to the viewer.**
8. **Viewer.** Spawn, walk, follow, the around-you panel, entering and leaving.
9. **Timing.** Record the nearby query's cost for Badanos and Pombal in the README.
10. **Wrap up.** README and `CLAUDE.md`.

## Acceptance tests

All of these are automated and run against the Lomia fixture with the `medieval` pack. Every existing test keeps passing.

**Paths between street positions**

- The lot-to-lot results are identical to before.
- A path between two points on the same segment is the stretch between them.
- A path's length equals the distance walked along its segments.
- A path between positions on opposite banks of the river in Badanos includes the bridge.
- The path from a position to itself has length zero.

**Avatar**

- Spawning at any point puts the avatar on a street segment, at the nearest point of the nearest segment.
- During a walk the avatar's position lies on its path, and the distance covered equals speed times elapsed game time.
- At or after the arrival time the avatar is standing at its destination, or in the building it walked to.
- Position depends only on state and game time: asking in any order, or for earlier and later times, gives consistent answers.
- A stop during a walk leaves the avatar exactly where it was at that moment.
- A new walk ordered during a walk starts from the position at that moment, with no jump.
- Leaving a building puts the avatar at that lot's entrance point.
- An action that makes no sense in the current condition, such as leaving while on a street, is refused with a message saying why.

**Perception**

- For Badanos at 03:00, 07:50, 12:30 and 20:30 on a work day, and from at least 20 seeded points each, the nearby query returns exactly the residents that a brute-force check of everyone's whereabouts finds within the radius, in order of distance.
- From a street, nobody inside a building is perceived.
- In a building, the avatar perceives exactly that building's occupants.
- At 03:00 an avatar on a street perceives nobody other than residents who are walking or outside then.

**Storage**

- The avatar's state survives a restart.
- A world with no avatar reports none, and every endpoint other than spawn refuses politely.

**Unchanged**

- Residents' plans are byte-identical with and without an avatar present. `LIFE_VERSION` is still 2.
- `LAYOUT_VERSION`, `GENERATOR_VERSION` and the Badanos baseline counts.

**Pack edits take effect**

- Doubling the avatar's speed halves its walking time.
- Doubling the perception radius never removes anyone from what is perceived.
- A speed or radius of zero or less is rejected on load.

**Cost**

- A nearby query in Badanos takes under 10 milliseconds once its index is built. This is an estimate; report the figure, and the figure for Pombal.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **The avatar is never stepped.** No timer moves it. Its position comes from its state and the game time.
- **Residents are untouched.** Nothing in the `life` module may read the avatar. If a change would make a resident's plan depend on the avatar, stop and ask.
- **Stored state stays small.** The clock and the avatar are the only stored state that is not imported.
- **The avatar walks the graph.** It is always on a segment or in a building, never at a free point.
- **The client stays thin.** It moves the avatar along a path it was sent. It does not find paths or decide who is nearby.
- **Inspecting is not moving.** Existing click-to-inspect behaviour must not be lost or made to move the avatar by accident.
- **Report, don't relax.** The 10-millisecond figure is my estimate; report what you reach.

