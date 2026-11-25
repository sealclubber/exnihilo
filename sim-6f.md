# Phase 6F Gameplan — Districts After Selection, and Switching On

Nov 24, 2026 · @seal

## Goal

Two things, in this order: make the staged generator the pack's default, and then replace the way districts get their houses so that it needs no reconciling. Part A is small and unblocks everything. Part B is a rework of one stage.

**Where things stand** at `7d318c0`, from `PROBLEM-6E-districts.md` and the census over all 682 settlements:

| Measure | Value |
| --- | --- |
| Settlements keeping every layout invariant | 682 of 682 |
| Lots outside their own district's ground | 3,049 of 540,856 (0.56%), in 371 settlements |
| Districts in more than one piece | 284 of 2,229, in 192 settlements |
| Still in pieces when bridge links count as joins | 108 |
| Settlements using the non-touching fallback | 17, for 1,372 houses |

The pack still says `generator: grid`. With `staged`, eight tests fail: two expect the name `grid`, and the rest share one cause, described in Part A.

Villages (under 1,000 residents) are a separate generator, specified in the Villages section of the Town Layout design doc. They are not part of this phase, and nothing here should be built for them.

## Part A: open ground, then switch on

**The fault.** In a staged layout a house's lot is its footprint and nothing more, so nothing has open ground. Open-air workplaces (market stall, town yard, woodyard) fail the plan check, visits spent outside have nowhere to be, and no one wanders.

**The fix.** Open ground comes from three places the generator already makes.

1. **Open-air buildings.** A building type the pack marks as open-air keeps its house rectangle as its lot and gets a small footprint or none, as the well does. The rest of the lot is its open ground.
2. **Courtyards.** Record each block's courtyard in the layout as a place belonging to that block, with the lots that back onto it. A building with no open ground of its own uses its block's courtyard for outside stays and wanders.
3. **Public ground.** A building in a block with no courtyard uses the nearest of: the plaza, the quay, the way in front of its entrance.

A wander stays inside the open ground it starts in. Courtyards with a passage are reachable from the street; one without is reached only through its own houses.

**Then switch.**

- Set `generator: staged` in the pack, fix the two tests that expect the name, raise the pack version.
- One rounds target reads 31% against 40% (street points perceiving someone at 12:30). Re-measure after the fix above. The 40% was tuned on the grid; if staged still falls short, report the figure and the reason, and do not bend the generator to it.
- Render the seven test towns from the ordinary renderer and commit them.
- Settlements under 1,000 residents use the staged generator for now, as they do today. Do not improve them.

## Part B: districts after selection, per bank

**The problem, as the 6E write-up put it.** There are three answers to "which district is this?", made at different stages: wards get a district before any house exists, houses get one in selection, and ground gets one when the layout is written. Every district fault was a disagreement between two of them. The fix is one answer, made once, after the town knows which houses exist.

**New order.**

1. **Character plan (was district growth).** Keep growing districts over wards before houses exist, but only as a forecast of which kind of district each ward will be. It sets ward character (house scale, lane frequency) and nothing else. Rename it so nobody mistakes it for the districts.
2. **Blocks, rows, landmarks, selection.** Unchanged. The town-wide selection decides which houses exist.
3. **Banks.** Group the blocks that hold kept houses into banks: connected sets under block adjacency, where water is never crossed. A town with no river is one bank. Each bank has a fixed number of kept houses.
4. **Share districts among banks.** Take districts in placement order, centre first, and banks in order of distance from the plaza. Fill the first bank with districts until it is full. The district that overflows continues on the next bank and is the only one that spans; its two parts must be joined by a bridge link. A town with *b* banks therefore has at most *b* − 1 spanning districts. Landmarks pull their owner: a district that owns the plaza, castle or a block landmark is shared to the bank where that landmark stands.
5. **Grow each district over kept blocks, within its bank.** One district at a time, in placement order.
   - *Seed.* The block the placement rules prefer among unclaimed blocks: the plaza's district at the plaza, a landmark's owner at its landmark, harbour on the water, poorer districts farther out, and otherwise beside ground already claimed, favouring blocks whose ward was forecast as this kind.
   - *Grow.* Claim unclaimed neighbouring blocks, nearest first, until the district has its count. Highways, main streets and the wall cost extra to cross, so they tend to become borders.
   - *No orphans.* Before claiming a block, check what it would cut off. If it would leave a pocket of unclaimed blocks smaller than what this district still needs, claim the pocket too. If the pocket is larger, prefer another block.
   - *Exact count.* The last block claimed is usually too big. The district takes only the houses it needs from it, a run along one side, and the next district starts from the rest. A block may so be shared by two districts; no house is dropped or added.
   - *Last on a bank.* The final district takes whatever remains.
6. **Ground.** A district's ground is the tiles of its blocks; a shared block's tile is divided between its two districts along the line between their houses. No vote and no re-owning.

**What this removes from `selection.ts`.** Block moves across borders, chains, thickening, `reachHouses`, both single-house passes and the counted fallback. Delete them; do not keep them as a second path.

**What is true by construction, and what is only measured.**

| Property | Status |
| --- | --- |
| Every district has exactly its count; no house dropped or added | By construction |
| Every lot lies in its own district's ground | By construction |
| No fallback | By construction; the code is gone |
| A district is one piece per bank | Expected, not guaranteed: the last district on a bank can be left in pieces. Measured. |
| At most *b* − 1 districts span banks | By construction |

The invariants stay as they are now: only that grounds do not overlap. Do not add a connectedness rule back. If the numbers below are missed, report them; do not add a repair pass.

**One accepted cost.** A ward's character is forecast before the real districts exist, so a few wards at district borders will have houses sized for the neighbouring kind. Fitting already pairs buildings to houses by size within a district, so this is cosmetic. Report how many wards end up in a district of a different kind from their forecast.

## Tests, order of work, report

**Tests**

| Test | Now | Passes when |
| --- | --- | --- |
| Pack default | `grid` | `staged`, with the full check green (Part A) |
| Open ground | none | Every open-air workplace has open ground; outside visits and wanders occur in Badanos on a work day |
| Exact counts | pass | Every district exact and every building placed, all 682 |
| Lots outside their own district's ground | 3,049 | 0 |
| Fallback houses | 1,372 | 0, and the fallback code removed |
| Districts in more than one piece on a bank | 284 by the old measure | Under 40 across Lomia (*estimate*; report the figure and the settlements) |
| Spanning districts | not measured | At most banks − 1 in every settlement, each joined by a bridge link |
| Landmarks | some stand apart | Plaza, castle and every block landmark stand in their owner's ground |
| Other invariants, life, cost | pass | Still pass; Pombal's generation time reported before and after |
| Determinism | pass | Byte-identical layouts from the same inputs |

**Order of work.** Stop and report after each.

1. Part A: open ground, the switch, renders. Merge when the full check is green.
2. Part B steps 1 to 4: the forecast renamed, banks, districts shared among banks. No behaviour change yet; report the bank table for Pombal, Inillanue, Ruha and Montica.
3. Part B steps 5 and 6 behind a pack setting, with the census run both ways.
4. Remove the old path and the setting; update `PROBLEM-6E-districts.md` to say what replaced it.

**Report back with** the census table before and after; the settlements with a district in pieces and why; wards whose forecast kind differs from their final district; renders of Pombal, Cevilefon, Karlen and Inillanue with districts tinted; and anything in the growth rules that had to change.

