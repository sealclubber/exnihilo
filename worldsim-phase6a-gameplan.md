# World Sim — Phase 6A Gameplan

Nov 21, 2026 · @seal

Phase 6A makes the town map read correctly: buildings look like buildings, people outside move about, roles can be told apart at a glance, and the panes get out of the way. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Make what is already simulated legible: a lot shows a building and the open ground around it, people who are outside move about on that ground, a person's role can be read from their colour, the thing under the cursor is marked, and every pane can be folded away.

**Done when:** all acceptance tests below pass, and in Badanos at midday you can tell at a glance which people are in a yard and which are on the street, pick out the watch by colour, and fold every pane away to leave the map clear.

## Context

Phases 1 to 5 are complete. Read `CLAUDE.md`, the README, and the `layout`, `life` and `avatar` modules before starting.

**Why the town reads wrongly today.** A lot is drawn as a filled rectangle, so it looks like a building, and a person who is outside on that lot looks like someone standing inside a building. They also never move. About a thousand people are outside at midday in Badanos, and nearly all of them appear as still dots in boxes.

**Where this phase sits.** Look and feel is split into four phases:

| Phase | Subject | In this document |
| --- | --- | --- |
| 6A | Reading the map: panes, hover, colour, simple footprints, moving about outside | Yes |
| 6B | Reasons to walk: civic buildings, errands, working rounds such as watch patrols, strolls | No |
| 6C | Arrivals: travellers and caravans through the exits, people who go away and come back | No |
| 6D | A natural town: organic streets and building shapes | No |

This phase changes how things are shown and adds the smallest pieces of data that needs. It does not give anyone a new reason to go anywhere.

**Style.** Minimalist, function over form: a small palette, thin lines, flat fills, no textures or decoration. Every mark on the map should tell the user something.

## Scope

**Build**

- Collapsible panes throughout the viewer
- A hover marker for people and lots
- Colour by role, defined in the pack, with a legend
- Building footprints in the layout format, filled in simply by the existing generator
- Movement on the lot for people who are outside
- A drawing pass on the town map in the minimalist style

**Do not change**

- Who goes where and when. Every trip and every stay's building and times stay exactly as they are.
- The city generator. `GENERATOR_VERSION` stays 2 and the Badanos baseline counts must not move.
- The street graph, the lots and their entrances.

**Do not build**

- Watch patrols or any other working round; that is phase 6B
- New building types, new visits or new occupations
- Travellers, caravans or anyone who is not a resident
- Organic streets, irregular lots or realistic building shapes
- People drawn inside buildings
- Sprites, icons for people, textures or animation beyond movement

## Changes

### 1. Collapsible panes

- Every pane in the viewer can be collapsed and expanded from its header: the settlement panel, the inspector and its household list, the person panel, the building panel, the around-you panel, the clock controls and the new legend.
- A collapsed pane shows one line: its title and a short summary, such as "Around you: 4".
- The map uses the space that collapsed panes give up.
- Each pane's state is remembered across reloads. One control collapses or expands everything.

### 2. Hover marker

- A box is drawn around the person under the cursor, with a small label giving their name and occupation. The same goes for the avatar.
- A lot under the cursor is outlined, with its building's name.
- The target for a person is generous, since dots are small. When several people are in range, the nearest to the cursor wins.
- Hovering an entry in the around-you panel or a household list marks that person on the map, and the reverse.
- Hovering never selects, moves the avatar, or changes anything.

### 3. Colour by role

- A new pack file, `display.yaml`, gives a colour to each workforce category, to people keeping house, to people not working, and optionally to single occupations, which take priority over their category.
- In the `medieval` pack the military category is red, so the watch stands out. The other colours are muted and distinct. All are placeholders.
- A collapsible legend lists the colours in use.
- Colour must not be the only cue between a person walking and a person staying outside; keep a difference in shape or outline as today.

### 4. Building footprints

- **Format.** A lot gains `footprints`: zero or more polygons inside the lot, each a building's outline. Add this to the layout format's rules: footprints lie inside their lot and do not overlap each other; everything in the lot that is not footprint is open ground.
- **Simple generator.** The grid generator gives each lot one rectangular footprint against its street frontage. How much of the lot it covers comes from the pack, with a default and per-type overrides. Building types marked `openAir` get no footprint, or a small one where the pack says so.
- A lot's entrance is unchanged.
- Raise `LAYOUT_VERSION` to 2. Junctions, segments, lots and entrances must be identical to version 1.

### 5. Moving about outside

**Rule.** A person who is outside moves about the open ground of the lot. Their position is still a pure function of game time.

- An outside stay gains a **wander**: a seeded sequence of points on the lot's open ground with the times at which the person is at each, covering the whole stay. Between points the person moves in a straight line at a slow pace; at a point they pause. Position at a time is interpolation.
- Pace and pause lengths come from the pack, in `species.yaml` beside walking speed. A pace of zero means standing still, which is how a person asleep outside would be shown.
- No part of a wander passes through a footprint or leaves the lot.
- A lot with no open ground keeps the person at a fixed point at its frontage.
- Whereabouts, the outside-stays query and the nearby query all use the wandering position.
- **Send the wander, not positions.** The server sends each outside stay's points and times; the viewer interpolates.
- Raise `LIFE_VERSION` to 3.

### 6. Drawing

- Open ground is drawn faintly and footprints solidly, so a building and its yard can be told apart at any zoom at which lots are visible.
- Streets, water and bridges keep their meaning and lose any heaviness: thin lines and flat fills.
- People stay simple shapes. Size holds steady enough across zoom levels to remain clickable.
- The avatar and its perception radius stay distinct from residents.
- Night is shown without making anything unreadable.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Footprints in the format.** Schema, rules, invariants and `LAYOUT_VERSION`.
2. **Footprints in the generator and the pack.**
3. **Wander.** Records, generation, position at a time, invariants and `LIFE_VERSION`.
4. **Queries.** Whereabouts, outside stays and nearby on the wandering position, with the brute-force comparison from phase 5 still exact.
5. **Pack colours.** `display.yaml` and its schema.
6. **API.** Footprints, wanders and colours reach the viewer.
7. **Drawing pass.** Change 6, with footprints, open ground and moving people.
8. **Hover marker.**
9. **Collapsible panes and legend.**
10. **Timing.** Record layout, planning and nearby costs again in the README.
11. **Wrap up.** README and `CLAUDE.md`, including the two version changes and the new format rule.

## Acceptance tests

All of these are automated. Viewer behaviour is tested in a headless browser, as in earlier phases. Every existing test keeps passing.

**Footprints**, for every one of the 682 settlements

- Every footprint lies inside its lot, and footprints on a lot do not overlap.
- Junctions, segments, lots and entrances are identical to `LAYOUT_VERSION` 1.
- A building type marked `openAir` has open ground on its lot.
- Changing a coverage value in a copy of the pack changes footprint area and nothing else.

**Wander**, over the same residents and days as the plan invariants

- Every outside stay has a wander covering exactly the stay's time.
- At every sampled moment the person is inside the lot and outside every footprint.
- Between any two moments the distance moved is no more than the pack's pace times the time elapsed.
- The same inputs give the same wander, whatever else was computed first.
- With a pace of zero in a copy of the pack, nobody outside moves.

**Unchanged behaviour**

- For every resident of Badanos over eight days, the sequence of activities, their buildings and their times, and every trip, are identical to `LIFE_VERSION` 2.
- `GENERATOR_VERSION` and the Badanos baseline counts.
- The nearby query still matches a brute-force check exactly, now using wandering positions.

**Viewer**

- Each pane collapses and expands, shows its summary line when collapsed, and keeps its state after a reload.
- With every pane collapsed the map occupies at least 90% of the window's width.
- Moving the cursor onto a person shows the marker and label for that person and for no one else; moving it away removes them.
- Hovering a list entry marks the same person on the map.
- Hovering changes no selection and does not move the avatar.
- A watchman is drawn in the pack's military colour, and changing that colour in a copy of the pack changes it on the map.
- The legend lists every colour in use and no others.
- A person outside is drawn on open ground, never on a footprint, and their drawn position changes over a minute of game time.

**Cost**

- The town map holds 30 frames a second in Badanos at midday with everything drawn. This is an estimate; report the figure, and the figure for Pombal.

## Rules

`CLAUDE.md` holds the standing rules. These are specific to this phase:

- **Show, don't change.** If a change here alters where anyone goes or when, it is out of scope.
- **Still nothing stepped.** A wander is derived from the person and the stay. No timer moves anyone.
- **Footprints are format, not decoration.** They go through the layout format and its invariants, so that a later generator can supply better ones.
- **Colours live in the pack.** Code knows categories and workforce states, not which one is red.
- **Function over form.** Add nothing to the map that does not carry information. When in doubt, leave it out and say what you left out.
- **The client stays thin.** It interpolates along points it was sent and draws.
- **Report, don't relax.** The frame-rate figure is my estimate; report what you reach.

