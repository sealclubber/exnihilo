# Phase 6G findings: districts drawn after houses

Nov 26, 2026. Branch `6g-districts`, from `main` at `1ebf85f`.

**Status.** Step 1 is done. Step 2 (unowned sites) was reverted after its landmark rule failed; the amended Landmarks section of `sim-6g.md` replaces it, and is ported and measured. Step 3, the switch-over, is built. The 19 districts whose landmark blocks were cut off are fixed by counting landmark blocks in the chains' check. It is **stopped for review** on 15 districts whose plaza or castle ground is drawn apart from their blocks. The step 3 commit is work in progress: the old selection and Part B tests are not yet rewritten, so `npm run check` does not pass on it.

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

## Landmarks lead the ground (amended rule)

The first landmark rule (sites reserved by kind, each landmark taking a free site in its own ground) failed when measured: 35% of block landmarks would have needed a site in a touching district, against a limit of about 5%, and its second case needed a house selection never kept. Step 2 (`efcb18e`) is reverted, so sites are owned and placed as on main, and `LAYOUT_VERSION` is back to 12.

Under the amended rule, the districts stage makes the ground follow the landmarks, ported from `docs/prototypes/districts-after-houses-landmarks.test.ts` with `LM=2`:
- **Claim.** After bank sharing, each district claims its own landmarks' blocks, on any bank where it has a unit.
- **Grow toward them.** A block's score is its distance to the seed, or its distance to one of the unit's landmark blocks plus `landmarkPull` (0.5, in the pack) times that landmark's distance to the seed, whichever is less.
- **Release.** Blocks the unit cannot reach from its seed or bridgeheads are let go, and join a neighbour as leftovers do.
- **Protect.** Chains never hand over a landmark's block.
- **Fall back.** A town that is not exact is drawn again without the landmarks.

A landmark whose block ends in another district's ground stays where it is and keeps its district. The two fallback cases of the old rule are gone.

The six regression towns match the reference field for field. The exception is Borfino: the reference has no fall-back, and the port draws Borfino again without landmarks because it is not exact with them.

| Measure, all 546 towns | Sandbox (539, before fall-back) | Sandbox targets | Generator targets | Stop if |
| --- | --- | --- | --- | --- |
| Landmarks outside their district's ground | 414 of 4,289 (9.7%) | 427 of 4,339 (9.8%) | 436 of 4,339 (10.0%) | > 15% |
| Districts in more than one piece | 0 | 0 | 0 | any |
| Towns drawn again without landmarks | 4 | 4 (Meunglain, Borfino, Nobla, Tuvaaki) | the same 4 | |
| Towns not exact at the end | n/a | 1 (Borfino 26) | 1 (Borfino 22) | > 5 or 200 houses |
| Houses out after step 4 | | 1,507 (0.29%) | 1,373 (0.26%) | > 1% |
| Shared blocks | 1,261 | 1,273 (0.74%) | 1,212 (0.70%) | > 2% |
| Islands | | 0 | 0 | any |

My figures are after the fall-back, which moves a few of those four towns' landmarks back outside (Borfino: 5 outside with the claims, 10 without them). That, and the seven towns that share a name, account for the gap to 414 of 4,289. Every measure is inside its threshold.

## Step 3: the switch-over (stopped)

What is built:
- **Selection** keeps the town's houses by growth rank and nothing else. All of its district repair is deleted: block moves, chains, single houses and the non-touching fallback, along with `selection.rounds`.
- **The districts stage** runs after selection, with each district's target set to its buildings that need a house, and the landmarks leading.
- **Each kept house's district** is its block's district. A lent block's houses nearest the neighbour's ground are the neighbour's. In a town that isn't exact (Borfino), the short district takes the houses it lacks from the nearest touching district with houses to spare, the ones nearest its own ground; these are counted.
- **Fitting** places each district's buildings on its own houses, unchanged.
- **District ground** is the tiles of the blocks each district was drawn over, plus the plaza and the castle for their landmark's district.
- **A lent block stays wholly its owner's ground**, as the gameplan says ("the block stays the giver's ground"). Its lent houses' lots therefore stand in a neighbour's ground and are counted there. I first divided such tiles between the two districts, as the Part B code did. That left the lent share drawn apart from its own district, so I took it out.
- **Removed:** Part B (`grow.ts`, `banks.ts`, `afterSelection`) and the census lines that counted houses against forecast ground.

Census, all 682 settlements (`node scripts/staged-census.ts`):

| Measure | Result | Stop if |
| --- | --- | --- |
| Settlements keeping every invariant | 682 of 682 | |
| Towns not exact (houses given from a neighbour's ground) | 1, Borfino, 22 houses | > 5 or 200 houses |
| Houses out after step 4 | 1,373 (0.26%) | > 1% |
| Shared blocks | 1,212 (0.70%) | > 2% |
| Districts spanning a river | 148 | record |
| Islands | 0 | any |
| Landmarks whose block ended in another district | 436 of 4,339 (10.05%) | > 15% |
| Towns drawn again without landmarks | 4: Meunglain, Borfino, Nobla, Tuvaaki | |
| Town lots outside their own district's ground | 2,722 of 523,259 (0.52%) | |
| **Town districts in more than one piece, bridge links counted as joins** | **39 of 2,078** | any |

Most of the 3.76% of lots outside their ground across all settlements are in villages, where the measure's 0.02 m pull toward a lot's middle meets the village generator's own 0.02 m; the fix for that (0.005) is on `6f-ground-districts` and was never on main.

**The pieces, by cause**, at block level with bridges counted as joins (the stage's own terms):
- **No district has two pieces with houses.**
- **19 districts have a landmark block standing alone**, all with the district's own landmark on it: Ruha, Sangeyri (2), Courceauligy, Burrealca, Chargis, Higones, Merenetsto, Ririm, Ikauna, Perston, Vehka, Borcillon, Tivet, Blokki, Hedavendare (2), Chanarena and Bonach.
  - **How it happens.** The district claimed the block and grew to it, and then the chains handed away the blocks that joined it. A hand-over is refused if it leaves the giver in more pieces, but that check counts only pieces holding houses, and a landmark block holds none.
  - **The evidence.** In Hedavendare and Chanarena, running the stage with chains off leaves each of those landmark blocks joined to its district.
  - **Why the sandbox missed it.** The reference counts pieces the same way, so it reported 0.
- **The other 20 of the census's 39** are joined at block level but drawn apart. I have not traced them. One possibility is the census's guess of which piece a bridge ends in, by nearest middle. Another is a tile corner lost where neighbouring districts' ground is kept a finger's breadth apart.

**Options (for your decision; not built).**
1. **Count landmark blocks as pieces in the chains' check.** A hand-over is refused if it leaves the giver in more pieces counting houses or its own landmarks. This is one condition in step 4, not a new pass. It may cost some exactness, and the fall-back would then catch more towns.
2. **Accept these pieces.** The landmark keeps its district and the census counts a piece, which needs the threshold changed.

I'd take option 1, and trace the 20 drawn-only pieces as part of the same step.

## Step 3, continued: landmark blocks in the chains' check; the drawn-only pieces

**The chains' check.** A piece now counts in the chains' piece check if it holds houses or one of the unit's own landmark blocks (option 1 above). The stage's own count of districts in pieces counts a district's landmark blocks the same way.

Stage census, all 546 towns, sandbox targets:

| Measure | Sandbox | Port |
| --- | --- | --- |
| Districts in pieces | 0 | 0 |
| Towns drawn again without landmarks | Meunglain, Borfino, Nobla, Tuvaaki | the same four |
| Shared blocks | 1,307 | 1,307 |

The port's shared-block figure is counted as the sandbox counted, before any redraw and once per name. Counted my usual way (all 546 towns, after the redraws) it is 1,319.

**The 20 pieces seen only in the drawn ground. Not all span a river: 5 do and 15 do not.** Of the 15, 14 are a town's **centre** district. Karlen and both of Pombal's affected districts show the same thing:

| Town | District | The stray piece |
| --- | --- | --- |
| Karlen | `district-8-001` | the castle ward, drawn for the citadel's district |
| Pombal | `district-5-001` | the castle ward, drawn for the citadel's district |
| Pombal | `district-5-003` | the plaza, drawn for the market square's district |

The rest of each district's ground is one piece of blocks.

**Why.** The plaza and the castle are not blocks, so the districts stage leaves them alone, as the gameplan says ("whatever stands in them stays as it is"). Their ground is still drawn for the district of the landmark standing there. Nothing makes that district's blocks reach the special ward, so its tile is drawn apart from the rest. The 5 river-spanning districts are probably the census's nearest-middle bridge guess, but I have not traced them, because the instruction was to stop if the 20 were not all river-spanning.

**Renders.** `docs/renders/<town>-districts-6g.svg` (this branch) and `<town>-districts-main.svg` (main at `1ebf85f`), for Karlen, Pombal, Badanos and Cevilefon. Every district has its own colour, its ground outlined and its number written in it. In Karlen the castle (labelled 001), in the middle of the walled town, belongs to a district whose blocks lie elsewhere.

They show two more things the census does not measure:
- **Empty fringe.** The leftover pass gives every empty block to a touching district, so a few outer districts take a ring of empty ground round the whole town.
- **Ragged borders.** Growth in turns and the chains leave interlocking, saw-toothed borders.

Main's districts are worse: ribbons one block wide, and a district strung round another.

**For your decision.** One option is that the district of the landmark on the plaza or in the castle claims a block beside that ward when seeded, as it claims its landmark blocks. Another is that the special ward's ground goes to the district of most of the blocks around it, while the landmark keeps its district; that would count as a landmark outside its ground.

## Not yet run

Steps 4 and 5, so no renders and no house-character figure yet; `scripts/landmark-sites.ts`, which measured the old rule, is removed. Branch `6f-ground-districts` is not deleted; that waits until the phase is in.
