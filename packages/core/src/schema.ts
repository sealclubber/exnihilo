/**
 * The world format. Everything outside the AFMG importer reads these shapes
 * and nothing else. Types are derived from the schemas.
 *
 * Conventions:
 * - IDs are strings of the form `kind-number`.
 * - A missing optional value is absent, never zero or an empty string.
 * - Lists of entities are in ascending ID-number order.
 */
import { z } from 'zod';

export const ENTITY_KINDS = [
  'cell',
  'state',
  'province',
  'culture',
  'religion',
  'river',
  'route',
  'settlement',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

const idSchema = (kind: EntityKind) =>
  z.string().regex(new RegExp(`^${kind}-(0|[1-9][0-9]*)$`), `must be a ${kind} ID`);

export const CellIdSchema = idSchema('cell');
export const StateIdSchema = idSchema('state');
export const ProvinceIdSchema = idSchema('province');
export const CultureIdSchema = idSchema('culture');
export const ReligionIdSchema = idSchema('religion');
export const RiverIdSchema = idSchema('river');
export const RouteIdSchema = idSchema('route');
export const SettlementIdSchema = idSchema('settlement');

const text = z.string().min(1);
const count = z.int().nonnegative();

/** A map position as [x, y]. The y axis points down, so north is negative y. */
export const PointSchema = z.tuple([z.number(), z.number()]);
export type Point = z.infer<typeof PointSchema>;

/** Whole degrees clockwise from north, 0 to 359. */
export const BearingSchema = z.int().min(0).max(359);

export const WorldInfoSchema = z.strictObject({
  name: text,
  seed: text,
  currentYear: z.int(),
  eraName: text,
  source: z.strictObject({ tool: text, version: text }),
  width: z.number().positive(),
  height: z.number().positive(),
  /** One map unit covers `unitsPerMapUnit` of `unit`, e.g. 2 mi. */
  distanceScale: z.strictObject({ unitsPerMapUnit: z.number().positive(), unit: text }),
});
export type WorldInfo = z.infer<typeof WorldInfoSchema>;

export const CellSchema = z.strictObject({
  id: CellIdSchema,
  center: PointSchema,
  polygon: z.array(PointSchema).min(3),
  neighbourIds: z.array(CellIdSchema),
  /** 0 to 100. Below 20 is water. */
  height: z.number().min(0).max(100),
  isLand: z.boolean(),
  biome: text,
  riverId: RiverIdSchema.optional(),
  /** Cells to the nearest coast: positive on land, negative in water, 1 and -1 at the shore. */
  distanceToCoast: z.int(),
  ruralPopulation: count,
  stateId: StateIdSchema,
  provinceId: ProvinceIdSchema.optional(),
  cultureId: CultureIdSchema,
  religionId: ReligionIdSchema,
});
export type Cell = z.infer<typeof CellSchema>;

export const WarSchema = z.strictObject({
  name: text,
  startYear: z.int(),
  /** Absent while the war is ongoing. */
  endYear: z.int().optional(),
  attackerId: StateIdSchema,
  defenderId: StateIdSchema,
});
export type War = z.infer<typeof WarSchema>;

export const StateSchema = z.strictObject({
  id: StateIdSchema,
  name: text,
  fullName: text.optional(),
  governmentForm: text.optional(),
  capitalSettlementId: SettlementIdSchema.optional(),
  colour: text.optional(),
  neighbourIds: z.array(StateIdSchema),
  /** This state's stance toward each other state, lower case, keyed by state ID. */
  diplomacy: z.record(StateIdSchema, text),
  wars: z.array(WarSchema),
  /** True for the stand-in entity that holds unclaimed land. */
  isPlaceholder: z.boolean(),
});
export type State = z.infer<typeof StateSchema>;

export const ProvinceSchema = z.strictObject({
  id: ProvinceIdSchema,
  name: text,
  fullName: text,
  stateId: StateIdSchema,
  seatSettlementId: SettlementIdSchema.optional(),
});
export type Province = z.infer<typeof ProvinceSchema>;

/** The sample a culture's names are generated from. */
export const NameBaseSchema = z.strictObject({
  name: text,
  minLength: z.int().positive(),
  maxLength: z.int().positive(),
  /** Letters that may appear doubled in a generated name. Absent when there are none. */
  doubledLetters: text.optional(),
  /** Share of generated names that have more than one word, 0 to 1. */
  multiWordRate: z.number().min(0).max(1),
  sampleNames: z.array(text).min(1),
});
export type NameBase = z.infer<typeof NameBaseSchema>;

export const CultureSchema = z.strictObject({
  id: CultureIdSchema,
  name: text,
  nameBase: NameBaseSchema,
  originCultureIds: z.array(CultureIdSchema),
  isPlaceholder: z.boolean(),
});
export type Culture = z.infer<typeof CultureSchema>;

export const ReligionSchema = z.strictObject({
  id: ReligionIdSchema,
  name: text,
  type: text.optional(),
  form: text.optional(),
  deity: text.optional(),
  originReligionIds: z.array(ReligionIdSchema),
  isPlaceholder: z.boolean(),
});
export type Religion = z.infer<typeof ReligionSchema>;

export const RiverSchema = z.strictObject({
  id: RiverIdSchema,
  name: text,
  type: text,
  /** Ordered from source to mouth. */
  cellIds: z.array(CellIdSchema).min(1),
  parentRiverId: RiverIdSchema.optional(),
});
export type River = z.infer<typeof RiverSchema>;

export const RouteKindSchema = z.enum(['road', 'trail', 'sea-route']);
export type RouteKind = z.infer<typeof RouteKindSchema>;

export const RoutePointSchema = z.strictObject({
  position: PointSchema,
  cellId: CellIdSchema,
});

export const RouteSchema = z.strictObject({
  id: RouteIdSchema,
  name: text.optional(),
  kind: RouteKindSchema,
  points: z.array(RoutePointSchema).min(2),
});
export type Route = z.infer<typeof RouteSchema>;

export const SizeGroupSchema = z.enum(['village', 'town', 'city', 'fort', 'capital']);
export type SizeGroup = z.infer<typeof SizeGroupSchema>;

/** A neighbouring cell and the bearing to it from the settlement's cell. */
export const NeighbourLinkSchema = z.strictObject({
  cellId: CellIdSchema,
  bearing: BearingSchema,
});
export type NeighbourLink = z.infer<typeof NeighbourLinkSchema>;

export const SettlementFlagsSchema = z.strictObject({
  capital: z.boolean(),
  port: z.boolean(),
  citadel: z.boolean(),
  walls: z.boolean(),
  plaza: z.boolean(),
  temple: z.boolean(),
  shantyTown: z.boolean(),
});
export type SettlementFlags = z.infer<typeof SettlementFlagsSchema>;

export const SettlementRiverSchema = z.strictObject({
  id: RiverIdSchema,
  name: text,
  /** The upstream neighbour. Absent when the river rises in this cell. */
  arrivesFrom: NeighbourLinkSchema.optional(),
  /** The downstream neighbour. Absent when the river ends in this cell. */
  leavesToward: NeighbourLinkSchema.optional(),
});
export type SettlementRiver = z.infer<typeof SettlementRiverSchema>;

export const RouteExitSchema = z.strictObject({
  routeId: RouteIdSchema,
  name: text.optional(),
  kind: RouteKindSchema,
  towardCellId: CellIdSchema,
  bearing: BearingSchema,
});
export type RouteExit = z.infer<typeof RouteExitSchema>;

/**
 * The settlement brief: everything a later generator may know about a
 * settlement, complete on its own.
 */
export const SettlementBriefSchema = z.strictObject({
  id: SettlementIdSchema,
  name: text,
  position: PointSchema,
  cellId: CellIdSchema,
  /** Townspeople. */
  population: count,
  /** People in the surrounding countryside. */
  ruralPopulation: count,
  sizeGroup: SizeGroupSchema,
  state: z.strictObject({ id: StateIdSchema, name: text, fullName: text.optional() }),
  province: z.strictObject({ id: ProvinceIdSchema, name: text, fullName: text }).optional(),
  culture: z.strictObject({ id: CultureIdSchema, name: text }),
  religion: z.strictObject({ id: ReligionIdSchema, name: text }),
  flags: SettlementFlagsSchema,
  isProvinceSeat: z.boolean(),
  /** Names of goods produced, largest quantity first, lower case. */
  specialtyTags: z.array(text),
  river: SettlementRiverSchema.optional(),
  /** One entry per exit, ordered by the neighbouring cell's ID. */
  routes: z.array(RouteExitSchema),
  coast: z.strictObject({
    isCoastal: z.boolean(),
    /** Bearing toward open water. Present exactly when coastal. */
    waterBearing: BearingSchema.optional(),
  }),
  climate: z.strictObject({
    biome: text,
    height: z.number().min(0).max(100),
    /** Degrees Celsius. */
    temperature: z.number(),
  }),
  seed: z.int().min(0).max(0xffffffff),
});
export type SettlementBrief = z.infer<typeof SettlementBriefSchema>;

export const WorldSchema = z.strictObject({
  info: WorldInfoSchema,
  cells: z.array(CellSchema),
  states: z.array(StateSchema),
  provinces: z.array(ProvinceSchema),
  cultures: z.array(CultureSchema),
  religions: z.array(ReligionSchema),
  rivers: z.array(RiverSchema),
  routes: z.array(RouteSchema),
  settlements: z.array(SettlementBriefSchema),
});
export type World = z.infer<typeof WorldSchema>;

export const ImportWarningSchema = z.strictObject({
  code: text,
  entity: text,
  message: text,
});
export type ImportWarning = z.infer<typeof ImportWarningSchema>;

/** What the importer found that was missing or unexpected, without stopping. */
export const ImportReportSchema = z.strictObject({
  source: z.strictObject({ tool: text, version: text }),
  counts: z.strictObject({
    cells: count,
    states: count,
    provinces: count,
    cultures: count,
    religions: count,
    rivers: count,
    routes: count,
    settlements: count,
  }),
  warnings: z.array(ImportWarningSchema),
  /** Sections of the source file that were present but not read. */
  ignoredSections: z.array(text),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;
