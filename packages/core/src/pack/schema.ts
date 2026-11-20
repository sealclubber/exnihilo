/**
 * The setting pack format. A pack holds everything setting-specific that the
 * city generator needs: categories, occupations, buildings, species and
 * districts. The generator code itself names no occupation or building.
 *
 * A pack arrives here already parsed, as one object with a key per file.
 * Reading the files from disk is the server's job.
 */
import { z } from 'zod';
import { SizeGroupSchema } from '../schema.ts';

/** The seven workforce categories. These, and the conditions below, are what the code knows. */
export const CATEGORY_IDS = ['food', 'utilities', 'services', 'construction', 'military', 'luxury', 'trade'] as const;
export const CategoryIdSchema = z.enum(CATEGORY_IDS);
export type CategoryId = z.infer<typeof CategoryIdSchema>;

/** Facts about a settlement that a pack can react to: the brief's seven flags, and being a province seat. */
export const CONDITIONS = ['capital', 'port', 'citadel', 'walls', 'plaza', 'temple', 'shantyTown', 'provinceSeat'] as const;
export const ConditionSchema = z.enum(CONDITIONS);
export type Condition = z.infer<typeof ConditionSchema>;

export const PACK_FILES = [
  'pack',
  'categories',
  'modifiers',
  'occupations',
  'specialties',
  'workplaces',
  'dwellings',
  'landmarks',
  'species',
  'cultures',
  'districts',
] as const;
export type PackFile = (typeof PACK_FILES)[number];

const id = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lower-case ID such as "master-builder"');
const text = z.string().min(1);
const weight = z.number().nonnegative();
const probability = z.number().min(0).max(1);
const wholeNumber = z.int().nonnegative();
const range = z
  .strictObject({ min: z.int(), max: z.int() })
  .refine((value) => value.min <= value.max, 'min must not be greater than max');

const ManifestSchema = z.strictObject({
  name: id,
  version: z.union([text, z.number()]).transform(String),
  /** Lowest tier first. */
  statusTiers: z.array(z.strictObject({ id, name: text })).min(1),
  households: z.strictObject({
    /** Chance that a working member takes a free slot in the head's occupation. */
    followHeadOccupation: probability,
    /** Chances that a household sits one tier above or below its head's occupation. */
    statusShiftUp: probability,
    statusShiftDown: probability,
    /** The tier of a household in which nobody works. */
    statusWithoutWorker: id,
  }),
});

const CategorySchema = z.strictObject({ id: CategoryIdSchema, name: text, share: weight });

const MultipliersSchema = z.partialRecord(CategoryIdSchema, weight);

const ModifiersSchema = z.strictObject({
  sizeGroups: z.partialRecord(SizeGroupSchema, MultipliersSchema),
  conditions: z.partialRecord(ConditionSchema, MultipliersSchema),
});

const OccupationSchema = z.strictObject({
  id,
  name: text,
  category: CategoryIdSchema,
  /** A workplace type, or a landmark for an occupation that exists only as a fixed post. */
  workplace: id,
  weight,
  status: id,
  specialties: z.array(text).min(1).optional(),
  minPopulation: z.int().positive().optional(),
});
export type Occupation = z.infer<typeof OccupationSchema>;

const SpecialtiesSchema = z.strictObject({
  /** How many of a settlement's tags are used, counted after ignored tags are dropped. */
  maxTags: wholeNumber,
  /** Relative weight of the first, second, third... used tag. */
  rankWeights: z.array(z.number().positive()),
  /** Share of the trade category's ordinary slots that go to occupations carrying a used tag. */
  tradeShare: probability,
  tags: z.record(text, z.strictObject({ ignore: z.boolean().optional(), note: text.optional() })),
});

const WorkplaceSchema = z.strictObject({
  id,
  name: text,
  /** Workers one building holds. */
  capacity: z.int().positive(),
  proprietorLivesIn: z.boolean(),
  district: id,
});
export type WorkplaceType = z.infer<typeof WorkplaceSchema>;

const DwellingSchema = z.strictObject({
  id,
  name: text,
  status: id,
  /** Households one building holds. */
  households: z.int().positive(),
  /** Relative frequency among the dwelling types of the same tier. */
  weight: z.number().positive(),
});
export type DwellingType = z.infer<typeof DwellingSchema>;

/** A number that is either fixed or grows with the settlement. */
const CountSchema = z.union([
  z.strictObject({ fixed: wholeNumber }),
  z.strictObject({ perThousand: z.number().positive(), min: wholeNumber.optional(), max: wholeNumber.optional() }),
]);
export type CountSpec = z.infer<typeof CountSchema>;

const LandmarkSchema = z.strictObject({
  id,
  name: text,
  when: ConditionSchema,
  district: id,
  /** How many of these buildings the settlement gets. */
  count: CountSchema,
  /** Fixed posts, shared out among the buildings. */
  posts: z.array(z.strictObject({ occupation: id, count: CountSchema })),
});
export type Landmark = z.infer<typeof LandmarkSchema>;

const AgeBandsSchema = z
  .array(z.strictObject({ min: wholeNumber, max: wholeNumber, weight: z.number().positive() }))
  .min(1);

const SpeciesSchema = z.strictObject({
  name: text,
  household: z.strictObject({
    /** Relative frequency of each household size. */
    sizes: z.record(z.string().regex(/^[1-9][0-9]*$/, 'must be a household size'), weight),
    partnerProbability: probability,
    /** Relative frequency of each role among members beyond the head and partner. */
    otherRoles: z.strictObject({ child: weight, elder: weight, lodger: weight }),
    maxElders: wholeNumber,
  }),
  ages: z.strictObject({
    head: AgeBandsSchema,
    lodger: AgeBandsSchema,
    /** Partner's age relative to the head's. */
    partnerGap: range,
    minPartnerAge: wholeNumber,
    /** Youngest age at which someone can have had a child. */
    parentMinAge: z.int().positive(),
    /** Oldest child still living at home. */
    childMaxAge: wholeNumber,
    /** An elder's age relative to the head's. */
    elderGap: range,
    maxAge: z.int().positive(),
  }),
  sexes: z.strictObject({ headMaleShare: probability, maleShare: probability }),
  workforce: z.strictObject({
    workingAges: range,
    /** Share of all residents who are in the workforce. Met exactly, so it does not vary with the seed. */
    share: probability,
    /** Share of people of working age who cannot work. */
    unableShare: probability,
    /** Share of households of two or more with a member keeping house. */
    keepingHouseShare: probability,
  }),
  multipliers: z.strictObject({
    categories: MultipliersSchema.optional(),
    occupations: z.record(id, weight).optional(),
  }),
  /** Occupations only this species has. */
  occupations: z.array(OccupationSchema).optional(),
});
export type Species = z.infer<typeof SpeciesSchema>;

const CulturesSchema = z.strictObject({
  default: id,
  /** Species by culture name. */
  cultures: z.record(text, id),
});

const DistrictKindSchema = z.strictObject({
  id,
  name: text,
  /** Relative frequency. Left out for a kind that has `when`. */
  weight: weight.optional(),
  /** A kind with a condition adds exactly one district to settlements that meet it. */
  when: ConditionSchema.optional(),
  /** The status tiers whose dwellings this kind takes. */
  statuses: z.array(id),
  /** Name patterns. {settlement} and any {key} of `words` are filled in. */
  names: z.array(text).min(1),
});
export type DistrictKind = z.infer<typeof DistrictKindSchema>;

const DistrictsSchema = z.strictObject({
  residentsPerDistrict: z.int().positive(),
  words: z.record(id, z.array(text).min(1)),
  /** The first kind listed is the one a single-district settlement gets. */
  kinds: z.array(DistrictKindSchema).min(1),
});

const RawPackSchema = z.strictObject({
  pack: ManifestSchema,
  categories: z.array(CategorySchema),
  modifiers: ModifiersSchema,
  occupations: z.array(OccupationSchema).min(1),
  specialties: SpecialtiesSchema,
  workplaces: z.array(WorkplaceSchema).min(1),
  dwellings: z.array(DwellingSchema).min(1),
  landmarks: z.array(LandmarkSchema),
  species: z.record(id, SpeciesSchema),
  cultures: CulturesSchema,
  districts: DistrictsSchema,
});

export type SettingPack = z.infer<typeof RawPackSchema>;

/** Raised when a pack is malformed. Lists every problem found, not just the first. */
export class PackError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`the setting pack is not valid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'PackError';
    this.problems = problems;
  }
}

/**
 * Checks a parsed pack, one key per file, and returns it typed. Beyond the
 * shape of each file this checks that the files agree with each other.
 */
export function parsePack(raw: unknown): SettingPack {
  const shaped = RawPackSchema.safeParse(raw);
  if (!shaped.success) {
    throw new PackError(
      shaped.error.issues.map((issue) => {
        const [file, ...rest] = issue.path;
        return `${String(file ?? 'pack')}${rest.length > 0 ? ` at ${rest.join('.')}` : ''}: ${issue.message}`;
      }),
    );
  }
  const pack = shaped.data;
  const problems = crossCheck(pack);
  if (problems.length > 0) throw new PackError(problems);
  return pack;
}

/** Every occupation a pack defines, including those only one species has. */
export function allOccupations(pack: SettingPack): Occupation[] {
  return [...pack.occupations, ...Object.values(pack.species).flatMap((species) => species.occupations ?? [])];
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of ids) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

function crossCheck(pack: SettingPack): string[] {
  const problems: string[] = [];
  const tiers = new Set(pack.pack.statusTiers.map((tier) => tier.id));
  const kinds = new Set(pack.districts.kinds.map((kind) => kind.id));
  const workplaces = new Set(pack.workplaces.map((type) => type.id));
  const landmarks = new Map(pack.landmarks.map((landmark) => [landmark.id, landmark]));
  const occupations = allOccupations(pack);
  const occupationById = new Map(occupations.map((occupation) => [occupation.id, occupation]));

  const needTier = (tier: string, where: string) => {
    if (!tiers.has(tier)) problems.push(`${where} names the status tier "${tier}", which pack.statusTiers does not list`);
  };
  const needKind = (kind: string, where: string) => {
    if (!kinds.has(kind)) problems.push(`${where} names the district kind "${kind}", which districts does not list`);
  };

  for (const repeated of duplicates(pack.pack.statusTiers.map((tier) => tier.id))) {
    problems.push(`pack: the status tier "${repeated}" is listed more than once`);
  }
  needTier(pack.pack.households.statusWithoutWorker, 'pack: households.statusWithoutWorker');

  // Categories: exactly the seven, with shares that can be scaled to 100%.
  for (const category of CATEGORY_IDS) {
    const found = pack.categories.filter((entry) => entry.id === category).length;
    if (found !== 1) problems.push(`categories: "${category}" must be listed exactly once, but is listed ${found} times`);
  }
  if (pack.categories.reduce((sum, category) => sum + category.share, 0) <= 0) {
    problems.push('categories: the shares cannot be scaled to 100% because they add up to zero');
  }

  // Building types share one namespace, because a building record names its type by ID alone.
  const buildingTypeIds = [
    ...pack.workplaces.map((type) => type.id),
    ...pack.dwellings.map((type) => type.id),
    ...pack.landmarks.map((type) => type.id),
  ];
  for (const repeated of duplicates(buildingTypeIds)) {
    problems.push(`the building type "${repeated}" is defined more than once across workplaces, dwellings and landmarks`);
  }
  for (const type of pack.workplaces) needKind(type.district, `workplaces: "${type.id}"`);
  for (const type of pack.dwellings) needTier(type.status, `dwellings: "${type.id}"`);
  for (const tier of tiers) {
    if (!pack.dwellings.some((type) => type.status === tier)) {
      problems.push(`dwellings: no dwelling type exists for the status tier "${tier}"`);
    }
  }

  // Occupations
  for (const repeated of duplicates(occupations.map((occupation) => occupation.id))) {
    problems.push(`occupations: "${repeated}" is defined more than once`);
  }
  const posts = new Map<string, string>();
  for (const landmark of pack.landmarks) {
    needKind(landmark.district, `landmarks: "${landmark.id}"`);
    for (const post of landmark.posts) {
      const occupation = occupationById.get(post.occupation);
      if (!occupation) {
        problems.push(`landmarks: "${landmark.id}" has a post for the occupation "${post.occupation}", which does not exist`);
      } else if (occupation.workplace !== landmark.id) {
        problems.push(
          `landmarks: "${landmark.id}" has a post for "${post.occupation}", whose workplace is "${occupation.workplace}" rather than this landmark`,
        );
      }
      if (posts.has(post.occupation)) {
        problems.push(`landmarks: the occupation "${post.occupation}" is a post more than once`);
      }
      posts.set(post.occupation, landmark.id);
    }
  }
  for (const occupation of occupations) {
    const where = `occupations: "${occupation.id}"`;
    needTier(occupation.status, where);
    if (landmarks.has(occupation.workplace)) {
      if (occupation.weight !== 0) {
        problems.push(`${where} works at the landmark "${occupation.workplace}", so it is a fixed post and its weight must be 0`);
      }
      if (!posts.has(occupation.id)) {
        problems.push(`${where} works at the landmark "${occupation.workplace}", which has no post for it`);
      }
    } else if (!workplaces.has(occupation.workplace)) {
      problems.push(`${where} names the workplace type "${occupation.workplace}", which does not exist`);
    }
    if (occupation.specialties && occupation.category !== 'trade') {
      problems.push(`${where} carries specialty tags but is not in the trade category`);
    }
    for (const tag of occupation.specialties ?? []) {
      if (!(tag in pack.specialties.tags)) {
        problems.push(`${where} carries the specialty tag "${tag}", which specialties does not list`);
      }
    }
  }
  // Every category needs an occupation that any settlement can use, or its workers would have nowhere to go.
  for (const category of CATEGORY_IDS) {
    const usable = pack.occupations.some(
      (occupation) =>
        occupation.category === category &&
        occupation.weight > 0 &&
        occupation.minPopulation === undefined &&
        occupation.specialties === undefined,
    );
    if (!usable) {
      problems.push(
        `occupations: the category "${category}" has no occupation with a weight, no minimum population and no specialty tags`,
      );
    }
  }

  // Specialties
  if (pack.specialties.rankWeights.length < pack.specialties.maxTags) {
    problems.push(`specialties: rankWeights has ${pack.specialties.rankWeights.length} entries but maxTags is ${pack.specialties.maxTags}`);
  }
  for (const [tag, treatment] of Object.entries(pack.specialties.tags)) {
    if (treatment.ignore) continue;
    const usable = pack.occupations.some(
      (occupation) => occupation.weight > 0 && occupation.minPopulation === undefined && occupation.specialties?.includes(tag),
    );
    if (!usable) {
      problems.push(`specialties: the tag "${tag}" is not ignored, but no occupation without a minimum population carries it`);
    }
  }

  // Species and cultures
  if (Object.keys(pack.species).length === 0) problems.push('species: at least one species is needed');
  for (const [speciesId, species] of Object.entries(pack.species)) {
    const where = `species: "${speciesId}"`;
    if (Object.values(species.household.sizes).reduce((sum, value) => sum + value, 0) <= 0) {
      problems.push(`${where} has household sizes whose weights add up to zero`);
    }
    for (const role of ['head', 'lodger'] as const) {
      for (const band of species.ages[role]) {
        if (band.min > band.max) problems.push(`${where} has a ${role} age band from ${band.min} to ${band.max}`);
        if (band.max > species.ages.maxAge) problems.push(`${where} has a ${role} age band above its maximum age`);
      }
    }
    for (const occupation of Object.keys(species.multipliers.occupations ?? {})) {
      if (!occupationById.has(occupation)) {
        problems.push(`${where} has a multiplier for the occupation "${occupation}", which does not exist`);
      }
    }
  }
  const needSpecies = (speciesId: string, where: string) => {
    if (!(speciesId in pack.species)) problems.push(`cultures: ${where} names the species "${speciesId}", which does not exist`);
  };
  needSpecies(pack.cultures.default, 'the default');
  for (const [culture, speciesId] of Object.entries(pack.cultures.cultures)) needSpecies(speciesId, `"${culture}"`);

  // Districts
  for (const repeated of duplicates(pack.districts.kinds.map((kind) => kind.id))) {
    problems.push(`districts: the kind "${repeated}" is defined more than once`);
  }
  const first = pack.districts.kinds[0];
  if (first && (first.when !== undefined || !first.weight)) {
    problems.push('districts: the first kind must have a weight and no condition, because every settlement gets one');
  }
  for (const kind of pack.districts.kinds) {
    const where = `districts: "${kind.id}"`;
    if (kind.when === undefined && kind.weight === undefined) problems.push(`${where} needs either a weight or a condition`);
    if (kind.when !== undefined && kind.weight !== undefined) problems.push(`${where} has both a weight and a condition`);
    for (const tier of kind.statuses) needTier(tier, where);
    for (const pattern of kind.names) {
      for (const [, key] of pattern.matchAll(/\{([^}]*)\}/g)) {
        if (key !== 'settlement' && !(key as string in pack.districts.words)) {
          problems.push(`${where} has the name pattern "${pattern}", but districts.words has no "${key}"`);
        }
      }
    }
  }

  return problems;
}
