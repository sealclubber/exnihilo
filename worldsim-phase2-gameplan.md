# World Sim — Phase 2 Gameplan

Nov 19, 2026 · @seal

Phase 2 builds the first half of the city generator: from a settlement brief to a complete set of records for its people, households, buildings and districts, with no geometry. This document is written to be handed to Claude Code as the brief for that work.

## Goal

Given a settlement brief, generate every resident, household, building and district of that settlement as linked records, deterministically, and make the result inspectable from the command line and the browser.

**Done when:** all acceptance tests below pass, and opening Badanos in the viewer lets you browse its 9,607 residents by household, occupation and district.

## Context

Phase 1 is complete and running: an AFMG export is imported into our own world format, stored in SQLite, served over an API and drawn in a browser viewer. Each settlement has a settlement brief. Start by reading the existing code, tests and README, and follow the conventions already there. Where this document and the existing code disagree on a name or structure, keep the code's and say so.

Decisions that constrain this phase:

- **Inside-out generation.** People come first, buildings are derived from what people need, districts group the buildings. Nothing here has a shape or position.
- **The brief is the only world input.** The generator takes a brief, a setting pack and a seed. It never reads the world store or AFMG data.
- **Workforce, not economy.** A town's economy is seven workforce categories with percentage shares, then occupations inside each. No goods, prices or stock exist.
- **Setting pack.** Everything setting-specific lives in data files: categories, occupations, workplaces, landmarks, species. The generator code contains no occupation or building names.
- **Derived, not stored.** Generated records are recomputed on demand from brief, pack and seed. Nothing generated is written to the world store in this phase.
- **Exact totals.** The number of residents equals the brief's population exactly, for every settlement.

## Scope

**Build**

- The setting pack format, its validation, and a first pack named `medieval`
- The generator in `core`: brief, pack and seed in; city records out
- A name generator for people, behind an interface
- A command that generates one settlement and writes its records and a summary
- API endpoints for a settlement's summary and its records, paged
- A city inspector in the viewer

**Do not build**

- Streets, lots, positions, shapes or anything drawn as a map of the town
- Schedules, movement, needs or any behaviour over time
- Relationships beyond household kinship and employment
- History or biographies
- Building interiors
- Storage of generated records, or editing them in the browser
- Rural population: the people counted in the brief's rural figure are not generated

## Setting pack

A setting pack is a folder of hand-editable YAML files, validated on load. The first pack is `packs/medieval`. All numbers in it are placeholders chosen to be plausible; they will be tuned by hand later, so none may be hard-coded.

| File | Holds |
| --- | --- |
| `categories` | The seven workforce categories and their base shares |
| `modifiers` | Multipliers on category shares by size group and flag |
| `occupations` | Every job: ID, display name, category, workplace type, weight within its category, status tier, and optionally the specialty tags it belongs to and a minimum settlement population |
| `specialties` | For each specialty tag, how it should be treated; any tag can be marked as ignored |
| `workplaces` | Every building type: ID, display name, how many workers one building holds, whether the proprietor's household lives in it, and which kind of district it prefers |
| `dwellings` | Housing types by status tier, with how many households one building holds |
| `landmarks` | For each flag and status: the buildings it adds and the fixed posts it creates, with staffing per thousand residents |
| `species` | Per species: age bands, household size distribution, working ages, share of households with a member keeping house, and multipliers on categories and occupations, plus any occupations only that species has |
| `cultures` | Which species each culture belongs to, by culture name, with a default of human |
| `districts` | District kinds, how many residents one district holds, and naming patterns |

**Base shares**

| Category | Share | Covers |
| --- | --- | --- |
| Food | 15% | Preparing and selling food and drink |
| Utilities | 10% | Keeping the town running: water, light, fuel, waste, carting |
| Services | 20% | Work done for other residents, plus clergy and officials |
| Construction | 10% | Building and repair |
| Military | 5% | Garrison and civic order |
| Luxury | 5% | Goods and services beyond need |
| Trade | 35% | Goods made for sale elsewhere, and the people who move them |

**Starting modifiers.** Each multiplies a base share; shares are then scaled back to 100%.

| Condition | Effect |
| --- | --- |
| Size group village | Food x4, trade x0.4, services x0.6, luxury x0.2 |
| Size group fort | Military x6, trade x0.3, luxury x0.2 |
| Citadel | Military x2 |
| Walls | Military x1.3, construction x1.2 |
| Temple | Services x1.2 |
| Port | Trade x1.3 |
| Capital | Services x1.5, luxury x2, military x1.5 |
| Province seat | Services x1.2 |

**Specialty tags.** The brief lists the goods a settlement is known for, largest first. The generator uses at most the first three, weighted toward the first. Occupations carrying a matching tag fill most of the trade category; general trade occupations such as merchant and carter fill the rest. The Lomia fixture contains 49 distinct tags, and the `medieval` pack must handle every one of them, either with occupations or by marking it ignored. Leave a comment in the pack listing any tags you chose to ignore so the user can review them.

**Size of the first pack.** Aim for roughly 80 to 120 occupations and 30 to 50 workplace types. Include one non-human species, `dwarf`, used only by tests: masons and miners weighted up, and a `runesmith` occupation no other species has.

## Generation pipeline

The generator is one pure function in `core`. Each step draws randomness only from its own sub-seed, derived from the settlement seed and the step's name, so changing one step does not reshuffle the others.

1. **Households and people.** Create households until the residents total the brief's population exactly. Each household gets a size from the species' distribution and members with an age, a sex and a role: head, partner, child, elder, or lodger. Adjust the last household so the total is exact.
2. **Names.** Give every person a given name and every household a family name through the name generator interface. The default implementation builds names from the culture's name base. AFMG name bases are lists of place names, so these personal names are placeholders; the interface exists so per-culture name lists can replace them later.
3. **Workforce.** Classify every person as not working (too young, too old, or unable), keeping house, or in the workforce, using the species' parameters.
4. **Category shares.** Start from the base shares, apply every modifier that matches the brief, apply species multipliers weighted by the settlement's species mix, scale to 100%, then apportion the workforce across categories by the largest-remainder method so the counts sum exactly.
5. **Fixed posts.** Create the posts that landmarks require. Each post takes a slot from its own category's count.
6. **Occupation slots.** Inside each category, apportion the remaining count across occupations by weight, again by largest remainder. In the trade category, apply the specialty tags. Skip occupations whose minimum population is not met.
7. **Assigning slots.** Give household heads their occupations first. Other working members of a household take a slot in the head's occupation when one is free, with a probability from the pack, and otherwise take any free slot. Every slot is filled and every worker has exactly one.
8. **Status.** Give each household a status tier from its head's occupation, with a little seeded variation.
9. **Workplaces.** For each occupation's workplace type, create enough buildings for its workers given the type's capacity, and assign each worker to one. Add landmark buildings.
10. **Dwellings.** Give every household a home. If the head's workplace type houses its proprietor, the household lives there. Otherwise place it in a dwelling of its status tier, filling shared buildings up to capacity.
11. **Districts.** Create districts by population, give each a kind and a name, and assign every building to one using workplace preferences and household status. A shanty town flag creates a district for the poorest households.
12. **Summary.** Count residents by workforce state, category, occupation, status and district.

After the last step, run every invariant from the acceptance tests as an internal check and fail loudly if any is broken.

## Output records

The result is one object per settlement holding four lists and a summary. Every record has a stable ID that includes the settlement's number, such as `person-641-000123`, and lists are in ID order.

| Record | Fields |
| --- | --- |
| Person | ID, given name, family name, age, sex, species, culture, household, role in household, workforce state, occupation if any, workplace if any |
| Household | ID, family name, members, head, status tier, dwelling |
| Building | ID, type, whether it is a workplace, dwelling, both, or landmark, district, households living in it, people working in it |
| District | ID, name, kind, buildings |
| Summary | Totals by workforce state, category, occupation, status tier and district; the final category shares after modifiers; the generator version; the pack name and version; the seed |

Links go both ways and must agree: a person names their household, and the household lists that person.

The generator carries a version number, recorded in the summary and raised whenever its output for the same inputs would change.

## Inspector

The result has to be easy to look at, because the pack will be tuned by eye.

- **Command.** Generate one settlement by ID and write its records as JSON plus a readable text summary. An option overrides the seed.
- **API.** One endpoint returns a settlement's summary. Others return its people, households, buildings and districts in pages, with filters by district, occupation and category. Generation happens on request and may be cached in memory.
- **Viewer.** The settlement panel gains an "Open city" action leading to an inspector with: the summary as counts and simple bars; a list of districts; a searchable list of households; and a household view showing its members, their ages, occupations and workplaces, and its home. Clicking a workplace shows who works there.

The pack is read from disk at server start. A restart is an acceptable way to pick up pack edits in this phase.

## Tasks

Work in this order. Each task ends with its tests passing before the next begins.

1. **Read phase 1.** Read the code, tests and README. Note the brief's actual field names and whether the culture's name base content is available to `core`; if it is not, extend the importer and world format so it is.
2. **Pack format.** Write the schemas and loader for a setting pack, with tests for valid and invalid packs. Loading from disk belongs in `server`; `core` receives a parsed pack.
3. **The `medieval` pack.** Write the data files, including the `dwarf` test species.
4. **Record types.** Write the schemas and types for people, households, buildings, districts and the summary.
5. **Pipeline steps 1 to 3.** Households, people, names and workforce, with tests.
6. **Pipeline steps 4 to 8.** Shares, fixed posts, occupations, assignment and status, with tests.
7. **Pipeline steps 9 to 12.** Workplaces, dwellings, districts and summary, with tests, then the internal invariant check.
8. **Command and API.**
9. **Inspector.**
10. **Whole-world run.** Generate all 682 settlements in a test, fix what breaks, and record the total time in the README.
11. **Review.** Update the README with how to generate a city, where the pack lives and how to edit it.

## Acceptance tests

All of these are automated and run against the Lomia fixture with the `medieval` pack.

**Invariants, checked for every one of the 682 settlements**

- The number of people equals the brief's population exactly. The total across Lomia is 2,935,089.
- Every person belongs to exactly one household, and every household lives in exactly one building.
- Every person in the workforce has exactly one occupation and one workplace; nobody outside the workforce has either.
- Category counts sum to the workforce, and occupation counts inside a category sum to that category.
- Every ID referenced by a record exists, and links agree in both directions.
- Every occupation, workplace type and district kind used exists in the pack.
- No workplace holds more workers than its capacity, and no dwelling more households than its capacity.
- The workforce is between 35% and 60% of the population.
- Every specialty tag in the brief is either used or marked ignored in the pack.

**Determinism**

- The same brief, pack and seed give byte-identical output on repeated runs.
- A different seed gives different people but the same population and the same category counts.

**Named settlements**

| Settlement | Check |
| --- | --- |
| Badanos (`settlement-641`), city, 9,607, no flags, province seat | Exactly 9,607 people. Leather and arms occupations are the two largest groups in the trade category. No citadel, temple, wall or dock buildings. A county administration building with officials exists |
| Pombal (`settlement-5`), capital, 47,603, port, citadel, walls, plaza, temple | Has a citadel with a garrison, a temple with clergy, docks with dock workers, gatehouses and a market square. Its military share is higher than Badanos's |
| Sunde (`settlement-2`), capital with shanty town | Has a shanty district whose households are all in the lowest status tier |
| Flupines (`settlement-143`), fort, 497 | Military is its largest category |
| Vereceldo (`settlement-455`), village, 253, the smallest settlement | Exactly 253 people. Food is its largest category. Generation succeeds with a single district |
| Jungsund (`settlement-33`), port town, 7,979 | Its trade share is higher than a town of the same size group without a port |

**Species**

- With a test culture mapping that assigns Vengrian to `dwarf`, Badanos has a higher share of masons than under the default mapping, and at least one runesmith.
- Under the default mapping, no settlement in Lomia has a runesmith.

**Pack edits take effect**

- Raising a category's base share in a copy of the pack raises that category's count in Badanos.
- A pack with a share table that cannot be scaled to 100%, or an occupation naming a missing workplace type, is rejected on load with a message naming the problem.

## Rules

- **`core` stays pure.** No file, network or clock access, and no randomness except from seeds passed in.
- **No setting knowledge in code.** If the generator needs to know that a tanner exists, the design is wrong. Code knows categories, flags and record shapes; the pack knows everything else.
- **No hard-coded numbers.** Every share, weight, capacity, rate and probability comes from the pack.
- **One sub-seed per step.** Never share a random stream between pipeline steps.
- **Exactness over realism.** Totals must match exactly. Where a realistic distribution and an exact total conflict, keep the total and adjust the last items.
- **Generated data is not stored.** Do not add generated records to the world store.
- **Tests come with the code.** Each task's tests are written in the same change as the task.
- **Stay inside the scope.** If something in the "Do not build" list seems necessary, stop and ask.
- **Ask, don't guess.** If a rule here cannot be satisfied for some settlement in Lomia, report the settlement and the reason before weakening the rule.

