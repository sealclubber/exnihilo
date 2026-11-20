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
  'layout',
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

export const SexSchema = z.enum(['female', 'male']);
export type Sex = z.infer<typeof SexSchema>;

const ManifestSchema = z.strictObject({
  name: id,
  version: z.union([text, z.number()]).transform(String),
  /**
   * A worker younger than this holds a job as an apprentice, unless the
   * occupation sets its own age. Left out, or 0, means no apprenticeships.
   */
  apprenticeUntil: wholeNumber.optional(),
  /** How an apprentice's job is shown, such as "Apprentice {occupation}". Needed when anyone can be an apprentice. */
  apprenticeLabel: text.optional(),
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
  /**
   * Where the work is done: a workplace type, or a landmark for an occupation
   * that exists only as a fixed post. An occupation has either this or `employer`.
   */
  workplace: id.optional(),
  /**
   * For work done in someone else's home: the status tiers whose households
   * employ such workers, with a weight per tier.
   */
  employer: z.strictObject({ tiers: z.record(id, z.number().positive()) }).optional(),
  weight,
  status: id,
  specialties: z.array(text).min(1).optional(),
  minPopulation: z.int().positive().optional(),
  /** Ages outside this range cannot hold the job. Left out means no limit. */
  minAge: wholeNumber.optional(),
  maxAge: wholeNumber.optional(),
  /** Only the listed sexes can hold the job. Left out means no limit. */
  sexes: z.array(SexSchema).min(1).optional(),
  /** A worker younger than this is an apprentice; 0 means the job has no apprenticeship. Left out means the pack-wide age. */
  apprenticeUntil: wholeNumber.optional(),
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
    /** Chance that an elder is the partner's parent rather than the head's. Left out means never. */
    elderOfPartnerShare: probability.optional(),
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

/** Where in a town a kind of district belongs. */
export const PlacementSchema = z.enum(['centre', 'middle', 'edge', 'waterside']);
export type Placement = z.infer<typeof PlacementSchema>;

const DistrictKindSchema = z.strictObject({
  id,
  name: text,
  /** Where the town's layout puts districts of this kind. */
  placement: PlacementSchema,
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

const metres = z.number().positive();
const LotSizeSchema = z.strictObject({ frontage: metres, depth: metres });
export type LotSize = z.infer<typeof LotSizeSchema>;

const LayoutSettingsSchema = z.strictObject({
  /** The full width of the roadway, per kind of street segment. */
  streetWidths: z.strictObject({ arterial: metres, street: metres, lane: metres, bridge: metres }),
  /** The land between streets: its length along the street and its depth. */
  block: z.strictObject({ length: metres, depth: metres }),
  /** The lot of a building type that has no entry of its own. */
  defaultLot: LotSizeSchema,
  /** Lot sizes by workplace, dwelling and landmark type. */
  lots: z.record(id, LotSizeSchema),
  /** The brief does not carry a river's width, so the pack supplies it. */
  riverWidth: metres,
  /** The lowest and highest acceptable residents per hectare of built area. */
  density: z
    .strictObject({ min: z.number().nonnegative(), max: metres })
    .refine((value) => value.min < value.max, 'min must be below max'),
  /** A waterside district must come within this distance of the water. */
  watersideReach: metres,
  /** Building types that are placed on the side of their district toward a route exit. */
  atExits: z.array(id).optional(),
});
export type LayoutSettings = z.infer<typeof LayoutSettingsSchema>;

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
  layout: LayoutSettingsSchema,
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

/** The lot a building of the given type gets. */
export function lotSizeOf(type: string, pack: SettingPack): LotSize {
  return pack.layout.lots[type] ?? pack.layout.defaultLot;
}

/** The age below which a holder of this occupation is an apprentice; 0 if it has no apprenticeship. */
export function apprenticeUntil(occupation: Occupation, pack: SettingPack): number {
  return occupation.apprenticeUntil ?? pack.pack.apprenticeUntil ?? 0;
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
    if ((occupation.workplace === undefined) === (occupation.employer === undefined)) {
      problems.push(
        `${where} has ${occupation.workplace === undefined ? 'neither a workplace nor an employer' : 'both a workplace and an employer'}; it needs exactly one`,
      );
    } else if (occupation.employer) {
      for (const tier of Object.keys(occupation.employer.tiers)) needTier(tier, `${where} employer`);
      if (Object.keys(occupation.employer.tiers).length === 0) problems.push(`${where} has an employer block that lists no status tier`);
      if (posts.has(occupation.id)) problems.push(`${where} is a landmark's fixed post, so it cannot also work in an employer's home`);
    } else if (occupation.workplace !== undefined && landmarks.has(occupation.workplace)) {
      if (occupation.weight !== 0) {
        problems.push(`${where} works at the landmark "${occupation.workplace}", so it is a fixed post and its weight must be 0`);
      }
      if (!posts.has(occupation.id)) {
        problems.push(`${where} works at the landmark "${occupation.workplace}", which has no post for it`);
      }
    } else if (occupation.workplace !== undefined && !workplaces.has(occupation.workplace)) {
      problems.push(`${where} names the workplace type "${occupation.workplace}", which does not exist`);
    }
    if (occupation.minAge !== undefined && occupation.maxAge !== undefined && occupation.minAge > occupation.maxAge) {
      problems.push(`${where} has a minAge of ${occupation.minAge} above its maxAge of ${occupation.maxAge}`);
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
  // Apprentices need a label to be shown by.
  const label = pack.pack.apprenticeLabel;
  if (label !== undefined && !label.includes('{occupation}')) {
    problems.push(`pack: apprenticeLabel "${label}" must contain {occupation}`);
  }
  if (label === undefined && occupations.some((occupation) => apprenticeUntil(occupation, pack) > 0)) {
    problems.push('pack: apprenticeLabel is needed because apprenticeUntil makes some workers apprentices');
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
    if (species.ages.elderGap.min < species.ages.parentMinAge) {
      problems.push(
        `${where} has an elderGap.min of ${species.ages.elderGap.min} below its parentMinAge of ${species.ages.parentMinAge}; an elder is a parent, so must be at least that much older`,
      );
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

  // Layout: every lot must fit in a block, since a block is where lots go.
  const buildingTypes = new Set(buildingTypeIds);
  for (const type of Object.keys(pack.layout.lots)) {
    if (!buildingTypes.has(type)) problems.push(`layout: lots has a size for "${type}", which is not a building type`);
  }
  for (const type of pack.layout.atExits ?? []) {
    if (!buildingTypes.has(type)) problems.push(`layout: atExits lists "${type}", which is not a building type`);
  }
  for (const [type, lot] of [['the default lot', pack.layout.defaultLot] as const, ...Object.entries(pack.layout.lots)]) {
    if (lot.frontage > pack.layout.block.length || lot.depth > pack.layout.block.depth) {
      problems.push(
        `layout: ${type === 'the default lot' ? type : `the lot of "${type}"`} is ${lot.frontage} by ${lot.depth}, which does not fit in a block of ${pack.layout.block.length} by ${pack.layout.block.depth}`,
      );
    }
  }

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
