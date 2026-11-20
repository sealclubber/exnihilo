/**
 * The records the city generator produces. Nothing here has a shape or a
 * position: a city is people, households, buildings and districts, linked by
 * ID in both directions.
 *
 * IDs carry the settlement's number and are zero-padded so that text order is
 * ID order: person-641-000123.
 */
import { z } from 'zod';
import { CategoryIdSchema } from '../pack/schema.ts';
import { CultureIdSchema, SettlementIdSchema } from '../schema.ts';

const recordId = (kind: string, digits: number) =>
  z.string().regex(new RegExp(`^${kind}-(0|[1-9][0-9]*)-[0-9]{${digits}}$`), `must be a ${kind} ID`);

export const PersonIdSchema = recordId('person', 6);
export const HouseholdIdSchema = recordId('household', 6);
export const BuildingIdSchema = recordId('building', 6);
export const DistrictIdSchema = recordId('district', 3);

const text = z.string().min(1);
const count = z.int().nonnegative();

export const SexSchema = z.enum(['female', 'male']);
export type Sex = z.infer<typeof SexSchema>;

export const HouseholdRoleSchema = z.enum(['head', 'partner', 'child', 'elder', 'lodger']);
export type HouseholdRole = z.infer<typeof HouseholdRoleSchema>;

export const WorkforceStateSchema = z.enum(['working', 'keeping-house', 'not-working']);
export type WorkforceState = z.infer<typeof WorkforceStateSchema>;

export const PersonSchema = z.strictObject({
  id: PersonIdSchema,
  givenName: text,
  familyName: text,
  age: count,
  sex: SexSchema,
  species: text,
  cultureId: CultureIdSchema,
  householdId: HouseholdIdSchema,
  role: HouseholdRoleSchema,
  workforceState: WorkforceStateSchema,
  /** Present exactly when the person is working. */
  occupationId: text.optional(),
  workplaceId: BuildingIdSchema.optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const HouseholdSchema = z.strictObject({
  id: HouseholdIdSchema,
  familyName: text,
  memberIds: z.array(PersonIdSchema).min(1),
  headId: PersonIdSchema,
  statusTier: text,
  dwellingId: BuildingIdSchema,
});
export type Household = z.infer<typeof HouseholdSchema>;

export const BuildingKindSchema = z.enum(['workplace', 'dwelling', 'both', 'landmark']);
export type BuildingKind = z.infer<typeof BuildingKindSchema>;

export const BuildingSchema = z.strictObject({
  id: BuildingIdSchema,
  /** A workplace, dwelling or landmark type from the setting pack. */
  type: text,
  kind: BuildingKindSchema,
  districtId: DistrictIdSchema,
  householdIds: z.array(HouseholdIdSchema),
  workerIds: z.array(PersonIdSchema),
});
export type Building = z.infer<typeof BuildingSchema>;

export const DistrictSchema = z.strictObject({
  id: DistrictIdSchema,
  name: text,
  kind: text,
  buildingIds: z.array(BuildingIdSchema),
});
export type District = z.infer<typeof DistrictSchema>;

const categoryNumbers = z.strictObject(
  Object.fromEntries(CategoryIdSchema.options.map((category) => [category, z.number().nonnegative()])) as Record<
    z.infer<typeof CategoryIdSchema>,
    z.ZodNumber
  >,
);

export const CitySummarySchema = z.strictObject({
  settlementId: SettlementIdSchema,
  settlementName: text,
  population: count,
  households: count,
  buildings: count,
  districts: count,
  /** Residents by workforce state. */
  workforce: z.strictObject({ working: count, keepingHouse: count, notWorking: count }),
  /** Workers by category. */
  categories: categoryNumbers,
  /** The category shares after every modifier, as fractions that sum to 1. */
  shares: categoryNumbers,
  /** Workers by occupation, for occupations that have any. */
  occupations: z.record(text, count),
  statusTiers: z.record(text, z.strictObject({ households: count, residents: count })),
  districtTotals: z.record(
    DistrictIdSchema,
    z.strictObject({ residents: count, households: count, buildings: count, workers: count }),
  ),
  generatorVersion: z.int().positive(),
  pack: z.strictObject({ name: text, version: text }),
  seed: z.int().min(0).max(0xffffffff),
});
export type CitySummary = z.infer<typeof CitySummarySchema>;

export const CitySchema = z.strictObject({
  people: z.array(PersonSchema),
  households: z.array(HouseholdSchema),
  buildings: z.array(BuildingSchema),
  districts: z.array(DistrictSchema),
  summary: CitySummarySchema,
});
export type City = z.infer<typeof CitySchema>;
