# Phase 6G findings: districts drawn after houses

Nov 26, 2026. Branch `6g-districts`, from `main` at `1ebf85f`.

**Status.** Step 1 is done. Step 2 (unowned sites) was reverted after its landmark rule failed; the amended Landmarks section of `sim-6g.md` replaces it, and is now ported and measured (below). Nothing is wired in yet; the generator still uses selection's repair. Step 3, the switch-over, is next.

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

## Not yet run

Steps 3 to 5, so no renders and no house-character figure yet; `scripts/landmark-sites.ts`, which measured the old rule, is removed. Branch `6f-ground-districts` is not deleted; that waits until the phase is in.
