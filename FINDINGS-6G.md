# Phase 6G findings: districts drawn after houses

Nov 26, 2026. Branch `6g-districts`, from `main` at `1ebf85f`.

**Status.** Steps 1 and 2 are done and committed. Step 3 (switch over) stopped before any code: the landmark rule misses its threshold by a wide margin, and one of its cases cannot work as written. Nothing is wired in yet; the generator still uses selection's repair.

## Step 1: the districts stage, ported (`staged/districting.ts`)

`drawDistricts` is a pure function ported from the `version 3` section of the reference. It is not wired in. It has the five steps (seed, share among banks, grow in turns, chains, exact) and no randomness. Its numbers are in the pack (`layout.staged.districts.drawn`, pack 0.19.0). `scripts/districting-census.ts` runs it beside the current pipeline on every town of 1,000 people or more.

Lomia has **546** such towns, not 539. Seven names are shared by two towns each (Migry, Ville, Bryan, Charoy, Viazhech, Feins, Vaakka). The reference looks towns up by name and keys its results by name, so it counted 539. Counted the same way, the port gives the sandbox's figures exactly:

| Measure | Sandbox (539) | Port, counted as the sandbox (539) | Port, all 546, sandbox targets | Port, all 546, generator targets | Stop if |
| --- | --- | --- | --- | --- | --- |
| Houses | 513,236 | 513,236 | 518,468 | 518,468 | |
| Districts in more than one piece | 0 | 0 | 0 | 0 | > 5 |
| Towns not exact after step 5 | 1 (Borfino 26) | 1 (Borfino 26) | 1 (Borfino 26) | 1 (Borfino 22) | > 5 or 200 houses |
| Houses out after step 4 | 1,425 | 1,425 | 1,445 (0.28%) | 1,364 (0.26%) | > 1% |
| Shared blocks | 1,220 | 1,220 | 1,230 (0.71%) | 1,203 (0.70%) | > 2% |
| Houses lent | 2,021 | 2,021 | 2,042 | 2,011 | |
| Districts spanning a river | 146 | 146 | 150 | 148 | record |
| Islands | 0 | 0 | 0 | 0 | any |

- **Sandbox targets** are the reference's: each district's buildings scaled to the kept total.
- **Generator targets** are each district's buildings that need a house, which is what the switch-over will use.
- **"Houses out after step 4"** is measured against the targets before rounding, as the sandbox's 1,425 was. Against the whole-number targets it is 1,430 for all 546 towns.
- **Regression towns.** The six towns run through the reference itself (Karlen, Ruha, Haurinen, Pombal, Borfino, Badanos) match it field for field. Karlen, Haurinen and Borfino are pinned in `test/staged-districting.test.ts`.

## Step 2: landmark sites unowned

A block landmark's site is now reserved by its kind, for no district. The kind is the site's template and the place it looks for: plaza, harbour or road.

- **Where sites go.** Sites go among the town's innermost blocks with room (the existing `within` rule), `apart` metres from every other site.
- **What was removed.**
  - The district's own forecast wards as the place to look.
  - The nearer spacing allowed within one district: `apartWithin` is gone from the pack.

`LAYOUT_VERSION` 13. The staged town and layout tests pass.

Unowning the sites moves some landmarks, and so changes which houses selection keeps. On the three pinned towns, with the sandbox targets:

| Town | Houses out after step 4 (before → after) | Not exact after step 5 (before → after) |
| --- | --- | --- |
| Karlen | 5 → 4 | 0 → 0 |
| Haurinen | 4 → 3 | 0 → 0 |
| Borfino | 73 → 46 | 26 → 0 |

So the known failure no longer fails. The pins in `test/staged-districting.test.ts` now hold the figures after step 2. I have not re-run the full census after step 2; the gameplan asks for it after steps 1, 3 and 4.

Ward landmarks (plaza, castle) are unchanged. Slot landmarks (tavern, chapel, well, oven) already stand on ordinary houses and reserve nothing. Gatehouses stand at gates.

## Stop: the landmark rule (step 3)

I measured the rule before building it, on every 4th town (137 towns, 1,265 block landmarks). The districts stage ran beside the generator with generator targets. Each landmark then took a free site of its kind in its own district's ground; failing that, case 1 (a site in a touching district); failing that, case 2 (an ordinary house). The script is `scripts/landmark-sites.ts`.

| What counts as one kind of site | Own ground | Case 1: touching district | Case 2: ordinary house |
| --- | --- | --- | --- |
| Template and place (as built) | 624 (49%) | **442 (35%)** | 199 (16%) |
| Template only | 665 (53%) | 417 (33%) | 183 (14%) |
| Any block site | 865 (68%) | 293 (23%) | 107 (8%) |

The gameplan says to stop if case 1 is above about 5%. It is 35% as built, and 23% even when any landmark may take any block site. The worst towns:

| Town | Block landmarks on an ordinary house (case 2) |
| --- | --- |
| Pombal | 25 of 58 |
| Karpeysk | 19 of 37 |
| Guignesto | 16 of 32 |
| Rabe | 15 of 34 |

**Why.** The sites cluster near the plaza and the main roads among the inner blocks, because that is where the reservation rule puts them. Every district owns landmarks, but the districts are now drawn from seeds spread across the town. An outer district's landmarks have no site in its own ground, and often none next door.

**Case 2 cannot work as written.** A landmark on an ordinary house needs one more house than selection kept. Selection keeps exactly as many houses as there are buildings that need one, so no house is spare. The ordinary building it displaces has nowhere to go, and the site it left stands empty in another district's ground. This is a gap in the rule, independent of the 5%.

**What would fit the numbers (for your decision; not built).**
1. **Let a landmark take the free site of its kind nearest its district's seed, anywhere in town.** The building keeps its district and stands in another's ground, and the census counts those lots as outside their own ground. Each kind has exactly as many sites as landmarks, because each site was reserved for one, so a site always exists and case 2 never happens. About a third of block landmarks would stand outside their district.
2. **Give each landmark's site to its owner inside the districts stage.** The stage would pre-claim the site, as it does a bridgehead. That is ownership at reservation again, and the sites lie far from many owners' seeds, so it would likely bring back districts in pieces.
3. **Reserve sites per district after the districts stage.** This cannot fit the current order: rows are laid around reserved blocks before selection, and selection before the districts.

I'd take option 1: it is the only one that keeps every count exact with no new pass.

## Not yet run

Steps 3 to 5, so no renders and no house-character figure yet. Branch `6f-ground-districts` is not deleted; that waits until the phase is in.
