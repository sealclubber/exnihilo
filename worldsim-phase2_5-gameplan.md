# World Sim — Phase 2.5 Gameplan

Nov 19, 2026 · @seal

Phase 2.5 is a patch to the city generator: it makes households, working ages and workplaces hang together before anything is built on top of them. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Make a generated city internally coherent: parents are old enough for their children, kinship is explicit, the pack controls who may hold which job, families and live-in workers share a workplace, and servants work in the homes of the households that employ them.

**Done when:** all acceptance tests below pass, the generator version is 2, and Badanos still has exactly the same category and occupation counts as before.

## Context

Generator version 1 meets every phase 2 acceptance test. These measurements of Badanos (`settlement-641`, default seed) show what the phase 2 brief never specified:

| Measured in Badanos | Cause in the code |
| --- | --- |
| 160 of 3,958 children were born when their mother was under 15; the youngest mother was 9 | In step 1 a child's age is limited by the head's age only; the partner can be up to 9 years younger |
| 380 workers are under 16 and hold full jobs, including a 13-year-old armourer; 21 of them are in the military | The pack has a working age for the species but nothing per occupation |
| 769 household members share their head's occupation, but only 36 work in the head's own workplace | Step 7 copies the occupation; step 9 then deals workers out to buildings in turn |
| 311 servants work in 39 "great house" buildings in which nobody lives, while 39 wealthy and noble households live in mansions | `servant` names a workplace type of its own |
| The inspector's Military filter lists a leatherworker's household | The filter matches any member, but the row shows the head |

People also have only a role relative to the head. An elder is not recorded as anyone's parent, which later phases (history, conversation) will need.

**On setting content.** The setting is pre-modern and the user decides how harsh it is. This patch does not remove child labour or raise any age on principle. It gives the pack the dials and fixes the cases where the code ignored a dial the pack already had.

## Scope

**Change**

- Pipeline steps 1, 7, 9 and 10 in `packages/core/src/city/generate.ts`
- Person and building records, and the invariants
- The pack schema and the `medieval` pack
- The inspector's household list and household view
- Tests and README

**Do not change**

- Category shares, modifiers, fixed posts or occupation slot counts: steps 3 to 6 stay as they are
- The settlement brief or anything in the importer
- Anything outside the city generator, its API views and the inspector

**Do not build**

- Relationships between households, such as cousins, friends or rivals
- Any geometry, schedule or behaviour
- New specialty occupations; the user will decide separately what to do with the ignored `slaves` tag

## Changes

### 1. Parent ages

**Rule.** A child is at least `parentMinAge` years younger than every parent living in the household, not only the head.

- In step 1, limit a child's age by the younger of head and partner, and offer the child role only when that younger age allows it.
- No new pack field. `parentMinAge` in `species.yaml` is the user's dial and keeps whatever value it has.

### 2. Explicit kinship

**Rule.** Every family tie inside a household is recorded on both people.

- Person gains `partnerId` (optional), `parentIds` (none, one or two) and `childIds`.
- Head and partner are each other's partner. A child is the child of the head, and of the partner when there is one.
- An elder is the parent of the head, or of the partner when a seeded choice says so and the elder is at least `elderGap.min` older than the partner. Two elders who are parents of the same person and of opposite sex are each other's partner.
- An elder who is the partner's parent has a family name of their own. Lodgers have no kin.
- Add this as its own pipeline step with its own random stream, before names.

### 3. Who may hold which job

**Rule.** The pack decides, per occupation, who is eligible and who counts as an apprentice. The code enforces it and never supplies an age of its own.

| New pack field | Where | Meaning | When absent |
| --- | --- | --- | --- |
| `minAge`, `maxAge` | An occupation | Ages outside this range cannot hold the job | No limit |
| `sexes` | An occupation | Only the listed sexes can hold the job | No limit |
| `apprenticeUntil` | An occupation, with a pack-wide default in `pack.yaml` | A worker younger than this holds the job as an apprentice; 0 means the job has no apprenticeship | Pack-wide default |
| `apprenticeLabel` | `pack.yaml` | Display pattern, such as "Apprentice {occupation}" | Required |

- Person gains an optional `apprentice` flag.
- Slot counts do not change. Step 7 must fill exactly the same slots while giving nobody a job they are not eligible for. Heads still draw first, and other members still follow the head's occupation with the pack's probability, wherever eligibility allows.
- If the slots cannot be filled under the pack's limits, fail with a message naming the settlement, the occupation and the shortfall.
- An apprentice is never the proprietor of a workplace, and in step 8 an apprentice's job sets the household's status only when no other member works.
- In the `medieval` pack: set `apprenticeUntil` to 0 for unskilled jobs; give `minAge` to posts of authority, to learned professions and to the military, as placeholders with a comment saying so. Set `sexes` on nothing; leave one commented example showing the syntax.

### 4. Shared workplaces

**Rule.** A household member or lodger who has the same occupation as the head works in the head's workplace, as far as its capacity allows.

- In step 9, place each head together with the co-residents who share the head's occupation, then fill the remaining places with everyone else.
- The number of buildings per type and the capacity limit stay as they are. Members who do not fit go to another building of the type.

### 5. Work in an employer's home

**Rule.** Some occupations have no workplace building of their own; the worker is attached to a household and works where it lives.

- An occupation has either `workplace` or a new `employer` block, never both. The block lists the status tiers that employ such workers and a weight per tier.
- After dwellings are assigned, share these workers out among eligible households by weight, using its own random stream. If no household of a listed tier exists, use the highest tier present. Nobody is employed by their own household.
- Person gains `employerHouseholdId`; their `workplaceId` is that household's dwelling. A dwelling with workers has kind `both`. Workplace capacity does not apply to these workers.
- In the `medieval` pack, convert `servant` to this form and remove the `great-house` workplace type.

### 6. Inspector

- Under a category or occupation filter, a household row shows the member who matched, not the head.
- The household view shows kinship (partner of, child of, parent of), the apprentice label, and for an employer household the people who work in its home.
- A servant's workplace links to the employing household.

### Versions

Raise `GENERATOR_VERSION` to 2 and the pack's `version` to 0.2.0.

## Tasks

Work in this order. Each task ends with `npm run check` passing before the next begins.

1. **Baseline.** Before changing any code, generate Badanos with the default seed and save its category and occupation counts as expected values for a test.
2. **Schemas.** Add the new pack fields and record fields, each optional so that a pack without them means "no restriction".
3. **Parent ages.** Change 1, with a test.
4. **Kinship.** Change 2, with tests for symmetry.
5. **Eligibility and apprentices.** Change 3, including the failure message.
6. **Shared workplaces.** Change 4.
7. **Employer households.** Change 5.
8. **Invariants.** Add every new rule to `invariants.ts`, and adjust any existing rule that assumed a worker's building is a workplace type.
9. **Pack.** Edit the `medieval` pack and the comments at the top of each changed file.
10. **API and inspector.** Change 6.
11. **Whole-world run.** Generate all 682 settlements. If any cannot satisfy the pack's limits, report which and why before changing a limit.
12. **Wrap up.** Raise both versions, and update the README's pack table and timing.

## Acceptance tests

All of these are automated. Every existing test keeps passing.

**Values that must not move** (Badanos, default seed)

| Quantity | Value |
| --- | --- |
| Residents | 9,607 |
| Workforce | 4,419 |
| Food | 637 |
| Utilities | 425 |
| Services | 1,020 |
| Construction | 425 |
| Military | 213 |
| Luxury | 212 |
| Trade | 1,487 |
| Tanner, servant, weaponsmith, leatherworker, armourer | 418, 311, 255, 251, 191 |

Every occupation count equals the baseline saved in task 1.

**New invariants, checked for every one of the 682 settlements**

- Every child is at least `parentMinAge` younger than each person in its `parentIds`.
- Kinship agrees in both directions: a parent lists the child and the child lists the parent; partners name each other. Nobody is their own kin, and lodgers have none.
- Nobody holds an occupation outside its `minAge`, `maxAge` or `sexes`.
- A worker is flagged as an apprentice exactly when younger than the job's `apprenticeUntil`.
- No apprentice is the proprietor of a workplace.
- Every worker in an `employer` occupation has an employing household other than their own, and works in that household's dwelling.
- No workplace type exceeds its capacity.

**Badanos, before and after**

| Measure | Version 1 | Required |
| --- | --- | --- |
| Children with a co-resident parent less than `parentMinAge` older | 160 with a mother under 15 at the birth | 0 |
| Workers below their occupation's `minAge` | Not expressible | 0 |
| Household members sharing the head's occupation who also share the head's workplace | 36 of 769 | At least 70%; if capacity makes this unreachable, report the figure reached and why |
| Servants working in the dwelling of an employing household | 0 of 311 | All |
| Buildings of type `great-house` | 39 | 0 |

**Pack behaviour**

- A pack with none of the new fields generates cities with no apprentices and no eligibility limits, and passes every invariant.
- Giving an occupation a `minAge` in a copy of the pack removes every younger holder of it in Badanos without changing its count.
- A `sexes` limit in a copy of the pack is respected.
- Limits that cannot be met, such as a `minAge` above the species' oldest working age on a common job, fail with a message naming the occupation.
- An occupation with both `workplace` and `employer`, or neither, is rejected on load.

**Determinism**

- The same brief, pack and seed give byte-identical output on repeated runs.

## Rules

`CLAUDE.md` in the repository root holds the standing rules. These are specific to this patch:

- **Ages and eligibility come from the pack only.** Do not add a default age, a floor or a sex restriction in code, and do not set `sexes` on any occupation in the `medieval` pack.
- **New randomness gets a new stream.** Kinship and employer assignment each use their own `stepRng` name.
- **Counts are fixed points.** If a change would alter a category or occupation count, the change is wrong.
- **Setting content stays the user's.** Leave the `slaves` tag as it is, ignored and listed for review.
- **Report, don't relax.** If a required figure cannot be reached, say what was reached and what limits it before changing the pack or the test.

