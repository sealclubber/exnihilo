/**
 * The setting pack format. A pack holds everything setting-specific that the
 * city generator needs: categories, occupations, buildings, species and
 * districts. The generator code itself names no occupation or building.
 *
 * A pack arrives here already parsed, as one object with a key per file.
 * Reading the files from disk is the server's job.
 */
import { z } from 'zod';
import { RouteKindSchema, SizeGroupSchema } from '../schema.ts';

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
  'calendar',
  'time',
  'shifts',
  'visits',
  'avatar',
  'display',
  'rounds',
  'travellers',
] as const;
export type PackFile = (typeof PACK_FILES)[number];
/** Files a pack may leave out. Without one, the pack behaves as it did before the file existed. */
export const OPTIONAL_PACK_FILES: readonly PackFile[] = ['travellers'];

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

export const WorkforceStateSchema = z.enum(['working', 'keeping-house', 'not-working']);
export type WorkforceState = z.infer<typeof WorkforceStateSchema>;

export const SECONDS_PER_DAY = 86_400;

/** A time of day written as "HH:MM", read as seconds since midnight. */
const clockTime = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be a time of day such as "06:30"')
  .transform((text) => Number(text.slice(0, 2)) * 3600 + Number(text.slice(3)) * 60);
const minutes = z.number().nonnegative();

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
  /** How a building is named that is both a home and a workplace, such as "{workplace} and home". Left out, it has its type's name alone. */
  homeAndWorkLabel: text.optional(),
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
  /**
   * The hours worked: one shift by name, or several with the share of the
   * occupation's workers on each. Left out means the default shift.
   */
  /** A round this work is done on, by name: part of each shift is then spent on foot. */
  round: id.optional(),
  shift: z.union([id, z.array(z.strictObject({ shift: id, share: probability })).min(1)]).optional(),
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

/** What a building type can say about being visited and being out of doors. */
const placeFlags = {
  /** Everyone staying here, worker or visitor, is outside. */
  openAir: z.boolean().optional(),
  /** Open at every hour, with nobody needed in attendance. */
  alwaysOpen: z.boolean().optional(),
};

const WorkplaceSchema = z.strictObject({
  id,
  name: text,
  /** Workers one building holds. */
  capacity: z.int().positive(),
  proprietorLivesIn: z.boolean(),
  district: id,
  /**
   * Share the buildings out among the districts in proportion to their residents, as for a civic building,
   * instead of putting them all in the kind of district the type prefers. For what people use every day.
   */
  spread: z.boolean().optional(),
  ...placeFlags,
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
  /** One for every so many residents. */
  z.strictObject({ perResidents: z.number().positive(), min: wholeNumber.optional(), max: wholeNumber.optional() }),
  /** One for every so many travellers expected to arrive in a day, by the rules of the pack's travellers file; none where none are expected. */
  z.strictObject({ perTravellers: z.number().positive(), min: wholeNumber.optional(), max: wholeNumber.optional() }),
]);
export type CountSpec = z.infer<typeof CountSchema>;

const LandmarkSchema = z.strictObject({
  id,
  name: text,
  /** The flag or status that grants the building. Left out, every settlement of at least `minPopulation` has it. */
  when: ConditionSchema.optional(),
  /** The settlement has none of these below this many residents. */
  minPopulation: z.int().positive().optional(),
  /** The kind of district the building prefers. Not needed when the buildings are spread. */
  district: id.optional(),
  /** Spread the buildings across the districts in proportion to their residents, so that every part of town has one. */
  spread: z.boolean().optional(),
  /** How many of these buildings the settlement gets. */
  count: CountSchema,
  /** At least this many for each route exit of the brief, whatever the count comes to. For buildings that stand at the ways out of town. */
  perExit: wholeNumber.optional(),
  /** Fixed posts, shared out among the buildings. */
  posts: z.array(z.strictObject({ occupation: id, count: CountSchema })),
  /**
   * The household of whoever holds the first post listed lives in the building, as a proprietor's does in a
   * workplace. Each building then gets one holder of each post in turn before any gets a second.
   */
  proprietorLivesIn: z.boolean().optional(),
  ...placeFlags,
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
  /** How the species lives its day. */
  life: z.strictObject({
    /** Walking speed by age: each entry covers ages up to and including `upToAge`; the last has none and covers the rest. */
    walkingSpeed: z.array(z.strictObject({ upToAge: wholeNumber.optional(), metresPerSecond: z.number().positive() })).min(1),
    /** Usual sleeping hours. A worker's are moved as far as their shift requires. */
    sleep: z.strictObject({ from: clockTime, to: clockTime }),
    /** How far a person's own habit moves their times, and how far each day moves them again. */
    variation: z.strictObject({ personalMinutes: minutes, dailyMinutes: minutes }),
    /** The least time awake at home before leaving for work, and after work before sleep. */
    minutesBeforeLeaving: minutes,
    minutesBeforeBed: minutes,
    /**
     * How a person who is outside moves about the open ground of the lot: the pace in metres per second, and
     * how long they pause between moves. A pace of zero, or leaving this out, means standing still.
     */
    outside: z.strictObject({ pace: z.number().nonnegative(), pauseMinutes: z.strictObject({ min: minutes, max: minutes }) }).optional(),
  }),
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
  /** Instead of a weight or a condition: the kind adds exactly one district to settlements whose draw (travellers file) reaches this. */
  whenDraw: z.number().positive().optional(),
  /**
   * Building types that belong to this kind: where the settlement has a district of it they stand there, whatever
   * district their own entry prefers and whether or not they are spread; where it has none they go where their own
   * entry says.
   */
  types: z.array(id).optional(),
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
  /**
   * Where each status tier prefers to live: district kinds in order of preference. A dwelling goes to the first
   * entry that the settlement has; an entry may be a list of kinds ranked alike. A tier left out goes to any kind
   * whose `statuses` include it.
   */
  tierDistricts: z.record(id, z.array(z.union([id, z.array(id).min(1)])).min(1)).optional(),
  /**
   * Housing near work: the share of dwellings placed in the district where the head of the household works,
   * instead of where the tier prefers, with values of its own for some kinds of district. A kind given 0 is
   * closed: nobody is moved there for this reason.
   */
  housingNearWork: z.strictObject({ share: probability, kinds: z.record(id, probability).optional() }).optional(),
});

const metres = z.number().positive();
const LotSizeSchema = z.strictObject({ frontage: metres, depth: metres });
export type LotSize = z.infer<typeof LotSizeSchema>;

export const LayoutGeneratorSchema = z.enum(['grid', 'staged']);
export type LayoutGenerator = z.infer<typeof LayoutGeneratorSchema>;

const span = z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() });

/**
 * The numbers of the `staged` generator of phase 6E: the town is made in stages on one shared mesh, each stage
 * final. Every value started as the approved prototype's.
 */
const share = z.number().positive();
const StagedSettingsSchema = z.strictObject({
  /** Roadway widths: a highway, a main street, the border between two wards, a lane inside a ward. */
  widths: z.strictObject({ highway: metres, mainStreet: metres, wardBorder: metres, lane: metres }),
  /**
   * The town's radius is that of a circle of `perBuilding` square metres for each building. Highways, the river and
   * the coast are drawn out to `reach` times that radius, and at least `least` metres.
   */
  extent: z.strictObject({ perBuilding: metres, reach: share, least: metres }),
  /**
   * A river: its width, and `portWidth` times that through a river port with no coast. It passes the centre at a
   * distance drawn from `distance`, as a share of the town's radius; a river port draws from `portDistance`. The
   * centre is never nearer the bank than the plaza's reach and a highway's width. Each
   * half has one bend, pushed aside by a share of the half's length drawn from `bend`. Its ends lie `beyond` times
   * the reach out. A river that rises here starts a share of the radius drawn from `source` from the centre, and is laid as if it
   * came from opposite the way it leaves, turned by a number of degrees drawn from `sourceTurn`.
   */
  river: z.strictObject({ width: metres, portWidth: share, distance: span, portDistance: span, bend: span, beyond: share, source: span, sourceTurn: span }),
  /**
   * A coast: the shore lies a share of the radius drawn from `distance` from the centre. `knots` points along it
   * are moved in and out by about `depth` metres, and no more than `depthShare` of that distance, evened over
   * `smoothing` knots, so that there are broad bays and headlands only. Where a land route leaves within 90 degrees
   * of the water's bearing, the shore on that side runs out to sea so as to pass `clearAngle` degrees clear of
   * it, though never more steeply than `steepest` metres out for each metre along.
   */
  coast: z.strictObject({ distance: span, knots: wholeNumber.min(4), depth: z.number().nonnegative(), depthShare: probability, smoothing: z.number().nonnegative(), clearAngle: z.number().nonnegative(), steepest: z.number().nonnegative() }),
  /**
   * Highways: two exits more than `through` degrees apart are one road through the centre. A highway strays aside
   * by `wander` times the reach and is evened in steps of `step` metres. It keeps `waterClear` metres from a
   * river it runs beside, being moved `waterPush` times that far out where it came nearer, and an exit that would
   * fall in the water is turned by up to `exitShift` degrees. Which way a highway leaves the centre is read
   * `armProbe` metres along it.
   */
  highways: z.strictObject({ through: z.number().min(90).max(180), wander: z.number().nonnegative(), step: metres, waterClear: metres, waterPush: share, exitShift: z.number().nonnegative(), armProbe: metres }),
  /**
   * Bridges stand only where a route crosses the river or the town is astride it: where the river passes within
   * `astrideWithin` times the town's radius of the centre. `counts` gives the number by the town's buildings: the
   * first entry whose `below` exceeds them, the last having none. A bridge's ends lie `landing` metres beyond the
   * water. The main crossing is looked for every `step` metres of river within `search` times the radius of the
   * centre, scoring `square` for a river square to the way and losing `near` for each metre from the centre. The
   * road runs straight for `lead` metres either side of the main bridge: `single` where it is the only one,
   * otherwise `share` of the distance from the centre held between `min` and `max`; where the centre is less
   * than `leadSlack` metres further off than that, the road runs straight to the bridge. A road is dead straight
   * for `straight` metres from a bridge's end: `main` at the main bridge, `side` at the others. Further bridges
   * stand a share of the radius drawn from `apart` along the bank from the next, and at least `apartLeast`
   * metres. Beside the river the highway splits to them `splitBefore` metres short of the end of its lead,
   * straight for `approach` metres at each, and rejoins; astride it each one's road runs `run` metres on and then
   * to the nearest road within `joinWithin` times the radius, a metre along the bank counting `veer` more. Where
   * the town is astride and no route crosses, the main bridge's road runs on `beyond` times the radius into the
   * far bank as a main street.
   */
  bridges: z.strictObject({
    counts: z.array(z.strictObject({ below: wholeNumber.optional(), bridges: wholeNumber.min(1) })).min(1),
    astrideWithin: share,
    landing: metres,
    step: metres,
    search: share,
    square: z.number().nonnegative(),
    near: z.number().nonnegative(),
    lead: z.strictObject({ single: metres, share: share, min: metres, max: metres }),
    leadSlack: z.number().nonnegative(),
    straight: z.strictObject({ main: metres, side: metres }),
    apart: span,
    apartLeast: metres,
    splitBefore: z.number().nonnegative(),
    approach: metres,
    run: metres,
    joinWithin: share,
    veer: z.number().nonnegative(),
    beyond: share,
  }),
  /**
   * The wall of a town flagged for one: a rounded ring about the centre enclosing `perBuilding` square metres for
   * `share` of the town's buildings. It is `long` times as long as wide, along the road, where at most two roads
   * leave the centre, and `round` times otherwise. Each entry of `wobble` swells and narrows it `waves` times round
   * by `size` of its radius. Towers stand about every `towers.spacing` metres, at least `towers.least` of them,
   * each moved along by up to `towers.jitter` of a spacing; the wall runs straight between them and ends at a
   * bank. A length shorter than `shortest` metres is left out. Where less than `dropFarBelow` of the ring's area
   * lies across a river, the far part is left out and the river closes that side.
   */
  wall: z.strictObject({
    share: probability,
    perBuilding: metres,
    long: z.number().min(1),
    round: z.number().min(1),
    wobble: z.array(z.strictObject({ waves: wholeNumber.min(1), size: probability })),
    towers: z.strictObject({ spacing: metres, least: wholeNumber.min(3), jitter: z.number().min(0).max(0.45) }),
    shortest: z.number().nonnegative(),
    dropFarBelow: probability,
  }),
  /**
   * The plaza of a town flagged for one, where the highways meet: `perBuilding` square metres for each building,
   * between `min` and `max`, and never more than `groundShare` of the ground the town's buildings need, so that
   * a village's is a green and not a parade ground. It has `sides` corners, each up to `jitter` nearer or further.
   */
  plaza: z.strictObject({ perBuilding: z.number().nonnegative(), min: metres, max: metres, groundShare: probability, sides: wholeNumber.min(3), jitter: z.number().min(0).max(0.3) }),
  /**
   * The castle of a town flagged for a citadel, sized as the plaza is. It stands in the widest gap between the
   * roads that leave the centre, `offPlaza` metres clear of the plaza and then `step` metres further out at a time
   * until it fits: inside the wall and `fromWall` metres from it, `fromWater` from water, `fromRoad` from the edge
   * of any road. Where no gap between roads has room, every `turn` degrees round is tried.
   */
  castle: z.strictObject({
    perBuilding: z.number().nonnegative(),
    min: metres,
    max: metres,
    groundShare: probability,
    sides: wholeNumber.min(3),
    jitter: z.number().min(0).max(0.3),
    offPlaza: z.number().nonnegative(),
    step: metres,
    fromWall: z.number().nonnegative(),
    fromWater: z.number().nonnegative(),
    fromRoad: z.number().nonnegative(),
    turn: z.number().positive().max(180),
  }),
  /**
   * How far the mesh reaches. Land is taken cheapest first until there is `factor` times the ground the town's
   * buildings need, where a metre from the nearest highway costs `highway` and a metre from the centre `centre`:
   * `single` where at most two roads leave the centre, `several` otherwise. Smooth noise of up to `noise.size`
   * times the radius, in patches about `noise.scale` metres across, is added. Land is looked at out to `extent`
   * radii, on squares of which there are about `raster.across` along that span and none finer than
   * `raster.finest` metres. Hollows narrower than twice `close` metres are filled. Ground within `fromWater.cost`
   * metres of water is never taken, and none is kept within `fromWater.edge`.
   */
  ground: z.strictObject({
    factor: z.number().min(1),
    extent: share,
    raster: z.strictObject({ across: wholeNumber.min(20), finest: metres }),
    single: z.strictObject({ highway: z.number().nonnegative(), centre: z.number().nonnegative(), close: z.number().nonnegative() }),
    several: z.strictObject({ highway: z.number().nonnegative(), centre: z.number().nonnegative(), close: z.number().nonnegative() }),
    noise: z.strictObject({ size: z.number().nonnegative(), scale: metres }),
    fromWater: z.strictObject({ cost: z.number().nonnegative(), edge: z.number().nonnegative() }),
  }),
  /**
   * The mesh of wards. Seed points are scattered `spacing` times the radius apart, between `min` and `max`
   * metres: `tries` points are thrown and one is kept if no other is within a share of the spacing drawn from
   * `apart`. Seeds within `clearOfLines` spacings of a highway, the river or the wall are removed, and pairs are
   * set either side of each such line, half a spacing times a draw from `pairs.offset` out, a spacing times a
   * draw from `pairs.every` along, within `pairs.within` radii of the centre, so that the line falls on the
   * border between cells. A seed within `tooNear` spacings of an earlier one is removed. A cell is a ward if its
   * middle is within `keep` spacings of the ground.
   */
  mesh: z.strictObject({
    spacing: share,
    min: metres,
    max: metres,
    tries: wholeNumber.min(1),
    apart: span,
    clearOfLines: z.number().nonnegative(),
    pairs: z.strictObject({ offset: span, every: span, within: share }),
    tooNear: z.number().nonnegative(),
    keep: z.number().nonnegative(),
  }),
  /**
   * Main streets follow cell borders out from the highways. A border may carry one if its middle is within
   * `edgeMargin` metres of the ground and it is at least `shortest` metres long; a border within `highwayIs`,
   * `wallIs` or `riverIs` spacings of such a line is that line and not a street. A street starts at a corner
   * within `startWithin` spacings of a highway and no nearer than `startsApart` spacings to a street already
   * laid, takes the straightest way on, and stops where the turn's cosine would fall under `straightest`. One of
   * fewer than `least` points is not kept. Each is then evened `smoothing` times, moving the corners it passes
   * through. A town of fewer than `skipBelow` buildings has none.
   */
  mainStreets: z.strictObject({
    edgeMargin: z.number().nonnegative(),
    shortest: z.number().nonnegative(),
    highwayIs: z.number().nonnegative(),
    wallIs: z.number().nonnegative(),
    riverIs: z.number().nonnegative(),
    startWithin: z.number().nonnegative(),
    startsApart: z.number().nonnegative(),
    straightest: z.number().min(-1).max(1),
    least: wholeNumber.min(2),
    smoothing: wholeNumber,
    skipBelow: wholeNumber,
  }),
  /**
   * A ward is its cell less everything laid before, moved in by half a ward border. A highway takes its width and
   * `highwayVerge` metres either side, a main street its width and `mainStreetVerge`; water takes `fromWater`
   * metres beyond its edge, the wall `fromWall` either side, the plaza `roundPlaza` and the castle `roundCastle`
   * beyond half a border. A piece under `least` square metres is no ward.
   */
  wards: z.strictObject({
    highwayVerge: z.number().nonnegative(),
    mainStreetVerge: z.number().nonnegative(),
    fromWater: z.number().nonnegative(),
    fromWall: z.number().nonnegative(),
    roundPlaza: z.number().nonnegative(),
    roundCastle: z.number().nonnegative(),
    least: z.number().nonnegative(),
  }),
  /**
   * Blocks. A ward is cut across its long axis, a share of the way along drawn from `cut`, by a lane turned
   * `turn` radians either way (one standard deviation), and its pieces cut again, until each is under a size drawn
   * from `area` in square metres, times the ward's scale; the limit drifts by a factor drawn from `drift` at each
   * cut. A ward's scale varies about 1 by `wardScale.spread` (the standard deviation of its logarithm), held
   * between `wardScale.min` and `wardScale.max`. A piece under `least` square metres is no block.
   */
  blocks: z.strictObject({
    area: span,
    cut: span,
    turn: z.number().nonnegative(),
    drift: span,
    wardScale: z.strictObject({ spread: z.number().nonnegative(), min: share, max: share }),
    least: z.number().nonnegative(),
  }),
  /**
   * Rows of houses along each edge of a block, longest edge first. An edge is one side of the block's outline
   * evened to within `simplify` metres, and carries a row if it is at least `edgeLeast` long. A house is a
   * rectangle on the edge: its width is drawn about `width.median` times the ward's scale (`width.spread` is the
   * standard deviation of its logarithm), between `width.min` and `width.max`; where less than `endLeast` metres
   * of the edge would be left it takes them too, and the row stops `stopShort` metres from the end. Its depth is
   * drawn from `depth`, times the root of the ward's scale and a factor drawn from `depth.vary`. A block whose
   * narrow side is under `court.least` metres has one row right through; otherwise depth is at most `court.share`
   * of the narrow side, so that a courtyard remains. With chance `wing.chance` a house at least `wing.bodyLeast`
   * wide in a courtyard block has a rear wing, `wing.width` of its width and `wing.depth` metres deep, at one end.
   * With chance `passage.chance` a courtyard block has one passage `passage.width` wide through a row, on an edge
   * at least `passage.edgeLeast` long and `passage.after` of the way along it, `passage.depth` times as deep as
   * the row. A house keeps `inset` metres inside its block and `gap` from any other house or passage. One that
   * does not fit is tried `setBack` metres back, then narrower or shallower, down to `keep` of its intended
   * area, a side of `narrowest` metres and `leastArea` square metres; failing that the row moves `step` metres
   * on and leaves yard.
   */
  rows: z.strictObject({
    simplify: z.number().nonnegative(),
    edgeLeast: metres,
    endLeast: z.number().nonnegative(),
    stopShort: z.number().nonnegative(),
    width: z.strictObject({ median: metres, spread: z.number().nonnegative(), min: metres, max: metres }),
    depth: z.strictObject({ min: metres, max: metres, vary: span }),
    court: z.strictObject({ least: metres, share: probability }),
    wing: z.strictObject({ bodyLeast: metres, width: span, depth: span }),
    passage: z.strictObject({ width: metres, after: probability, edgeLeast: metres, depth: share }),
    inset: z.number().nonnegative(),
    gap: z.number().nonnegative(),
    setBack: z.number().nonnegative(),
    keep: probability,
    narrowest: metres,
    leastArea: z.number().nonnegative(),
    step: metres,
  }),
  /**
   * Landmarks: building types that claim their ground before ordinary houses are laid. `types` names each one's
   * reservation: a `ward` (the castle or the plaza, named by `ward`), a `block`, a `slot` in a row or a courtyard,
   * or a `gate`. A block landmark's footprint is a `template`, and `place` says which block it prefers: the one
   * nearest the `plaza`, a highway or main street (`road`) or the `harbour`. `templates` are footprints made of
   * rectangles, each written [x0, y0, x1, y1] in a frame that runs from -0.5 to 0.5 along the footprint's length
   * and across its width; a footprint is at most `length` by `width` metres and at most `lengthShare` and
   * `widthShare` of its block's long and narrow sides. `block` says which blocks can be reserved: of an area in
   * `area`, at least `long` by `short` metres, in a ward whose growth rank is within the inner `inner` of the
   * town's (or, where the town has districts, among the innermost blocks of the landmark's own district that have
   * room for `within` of its buildings), and `apart` metres from any other reserved block, or `apartWithin` from
   * one of its own district; `jitter` metres of chance are added to the
   * distance that ranks them. A footprint is tried at each of `scales` in turn until it fits whole, `margin`
   * metres inside its block, and is not built under `leastArea` square metres.
   */
  landmarks: z.strictObject({
    types: z.record(
      id,
      z.strictObject({
        reservation: z.enum(['ward', 'block', 'slot', 'gate']),
        ward: z.enum(['castle', 'plaza']).optional(),
        template: id.optional(),
        place: z.enum(['plaza', 'road', 'harbour']).optional(),
        /** For a slot: the building is a small thing in the open, this many metres a side, and the rest of its place open ground. */
        open: metres.optional(),
      }),
    ),
    templates: z.record(
      id,
      z.strictObject({
        length: metres,
        width: metres,
        lengthShare: probability,
        widthShare: probability,
        parts: z.array(z.tuple([z.number().min(-0.5).max(0.5), z.number().min(-0.5).max(0.5), z.number().min(-0.5).max(0.5), z.number().min(-0.5).max(0.5)])).min(1),
      }),
    ),
    block: z.strictObject({
      area: span,
      long: metres,
      short: metres,
      inner: probability,
      within: z.number().positive(),
      apart: z.number().nonnegative(),
      apartWithin: z.number().nonnegative(),
      jitter: z.number().nonnegative(),
      scales: z.array(z.number().positive().max(1)).min(1),
      margin: z.number().nonnegative(),
      leastArea: z.number().nonnegative(),
    }),
  }),
  /**
   * Districts on wards. A ward's room for houses is its area over `perHouse` square metres times the scale of
   * its district's houses. Each of the city's districts starts from a seed ward chosen by its kind's placement: the wards of the
   * town proper (the innermost that hold `town` times its buildings) are ranked by growth, and `bands` gives the
   * share of that ranking each placement looks in; a waterside district starts nearest the water. Districts then
   * grow over neighbouring wards, nearest first, where crossing a highway, a main street, the river or the wall
   * adds `barriers` metres and a ward's growth rank counts `inward` times, so that inner ground is claimed first,
   * until each has room for `room` times its buildings (by placement; `roomDefault` otherwise). The wards left
   * over go to whichever district is nearest.
   */
  districts: z.strictObject({
    perHouse: metres,
    inward: z.number().nonnegative(),
    town: z.number().min(1),
    bands: z.record(z.enum(['centre', 'middle', 'edge', 'waterside']), z.tuple([probability, probability])),
    room: z.record(z.enum(['centre', 'middle', 'edge', 'waterside']), z.number().min(1)),
    roomDefault: z.number().min(1),
    barriers: z.strictObject({ highway: z.number().nonnegative(), mainStreet: z.number().nonnegative(), river: z.number().nonnegative(), wall: z.number().nonnegative() }),
    /**
     * true grows the districts over the kept blocks after selection, bank by bank (phase 6F, Part B), in place of
     * the districts selection settles at the borders. Left out, selection's.
     */
    afterSelection: z.boolean().optional(),
    /**
     * Districts drawn over the kept houses, block by block (phase 6G, `staged/districting.ts`). Each district is
     * seeded at a block and shared among the banks: while a bank's districts want more than `over` houses beyond
     * what it holds, one crosses a bridge, whole if its count is within `whole` of what must move, else split,
     * and a district already crossing carries more unless that would leave under `nearLeast` houses on the near
     * bank; at most `rounds` times. The districts then grow in turns, and blocks left over join a neighbour, in at
     * most `fills` passes. A district short by `chainAt` or more is passed blocks along a chain of neighbours from
     * one with that surplus: a block holding at most `chainOver` more houses than wanted, the `chainTries`
     * largest tried, in at most `chainSteps` steps; then single houses make the counts exact, in at most
     * `exactSteps`. Each district first claims its own landmarks' blocks and grows toward them, a block's way from a
     * landmark counting its own and `landmarkPull` times the landmark's way from the seed. Left out, the districts are the forecast's, repaired by selection.
     */
    drawn: z
      .strictObject({
        over: wholeNumber,
        whole: wholeNumber,
        nearLeast: wholeNumber,
        rounds: wholeNumber,
        fills: wholeNumber,
        chainAt: wholeNumber.min(1),
        chainOver: wholeNumber,
        chainTries: wholeNumber.min(1),
        chainSteps: wholeNumber,
        exactSteps: wholeNumber,
        landmarkPull: z.number().nonnegative(),
      })
      .optional(),
  }),
  /**
   * Ward character, by the kind of district a ward belongs to: `scale` multiplies the size of its houses and
   * blocks, `blocks` its blocks alone (under 1, more lanes), and `wing` and `passage` are the chances of a rear
   * wing and of a courtyard passage. `default` is for a kind not listed and for wards in no district.
   */
  character: z.strictObject({
    default: z.strictObject({ scale: share, blocks: share, wing: probability, passage: probability }),
    kinds: z.record(id, z.strictObject({ scale: share.optional(), blocks: share.optional(), wing: probability.optional(), passage: probability.optional() })),
  }),
  /**
   * Choosing the town's houses from those made. Each house is scored by the growth rank of its ground. In each
   * district the innermost `solid` of its count are always kept; beyond them a score is raised by its excess
   * times a draw from an exponential of mean `luck`, so that further out keeping a house is more and more a
   * matter of chance. A house inside the wall has its score multiplied by `insideWall` and is not left to chance.
   * Where a town has too few houses in all, ground is taken again `moreGround` times as large, up to `tries` times.
   */
  selection: z.strictObject({ solid: probability, luck: z.number().nonnegative(), insideWall: probability, rounds: wholeNumber.min(1), moreGround: z.number().min(1), tries: wholeNumber }),
  /**
   * Which building goes where. Within a district the buildings are sorted by the area of their pack lot and the
   * kept houses by the area of their footprint, and paired largest to largest: pack lot sizes are targets, not
   * exact sizes. Buildings with lots alike then change places so that trades gather along a street and spread
   * types stand apart. A type listed in `onRoads` then changes places with one of a like lot so as to front a
   * highway or main street: its front within `roadWithin` metres of one.
   */
  fitting: z.strictObject({ onRoads: z.array(id), roadWithin: metres }),
  /**
   * The harbour of a port: a quay `length` metres long and `width` wide, `inset` metres inland of the water's
   * edge, and no longer than `lengthShare` times the town's radius. On a coast it has `piers.count` piers,
   * `piers.length` long and `piers.width` wide, the outermost `piers.first` of the quay's length from its ends;
   * on a river, jetties no longer than `jettyShare` of the river's width. The road to it strays `wander` metres,
   * and no more than `wanderShare` of its length. A river wharf keeps `clearOfBridge` metres from any bridge. A
   * settlement with a sea route but no port flag has a landing `jetty.landing` metres long with one jetty
   * `jetty.length` long.
   */
  harbour: z.strictObject({
    quay: z.strictObject({ length: metres, lengthShare: share, width: metres, inset: metres }),
    piers: z.strictObject({ count: wholeNumber.min(1), length: metres, width: metres, first: z.number().min(0).max(0.5) }),
    jetty: z.strictObject({ landing: metres, length: metres }),
    jettyShare: probability,
    wander: z.number().nonnegative(),
    wanderShare: probability,
    clearOfBridge: metres,
  }),
});
export type StagedSettings = z.infer<typeof StagedSettingsSchema>;

/**
 * The numbers of the village generator, for a settlement under `below` residents: no mesh, wards or wall ring; the
 * road leads, and buildings are placed one at a time (phase 6E, Villages).
 */
const VillageSettingsSchema = z.strictObject({
  below: z.int().positive(),
  /** Residents per hectare of lots a village's layout must keep within, in place of the town's limits: a village's plots have gardens. Left out, the town's. */
  density: z.strictObject({ min: z.number().nonnegative(), max: z.number().positive() }).optional(),
  /** A road's and a lane's full width. */
  widths: z.strictObject({ road: metres, lane: metres }),
  /** How far out roads and water are drawn. */
  reach: metres,
  /** The built stretch of the through road reaches about `base` metres plus `perBuilding` for each building each way; it is also the village's radius. */
  cap: z.strictObject({ base: metres, perBuilding: metres }),
  /** A stream, drawn as the staged generator draws its river, the radius being the cap. `least` is the least distance from the centre to its bank. */
  river: z.strictObject({ width: metres, portWidth: share, distance: span, portDistance: span, bend: span, beyond: share, source: span, sourceTurn: span, least: metres }),
  /** A calm shore, drawn as the staged generator draws its coast, the radius being the cap. */
  coast: z.strictObject({ distance: span, knots: z.int().min(4).multipleOf(2), depth: metres, depthShare: share, smoothing: z.number().nonnegative(), clearAngle: z.number().min(0).max(90), steepest: metres }),
  /** Two exits more than `through` degrees apart are one road through the centre. A road strays aside by `wander` times the reach, and is evened in steps of `step` metres. */
  road: z.strictObject({ through: z.number().min(0).max(180), wander: share, step: metres }),
  /** A bridge reaches `beyond` metres onto each bank past the water. */
  bridge: z.strictObject({ beyond: metres }),
  /** A plot stands `gap` metres back from the edge of the way it fronts. */
  gap: z.number().nonnegative(),
  /**
   * Lanes that fork off the road near the centre, from `from` buildings: as many as the first entry of `counts`
   * whose `below` the village is under. Each leaves a road arm `start` metres from the centre (further, by
   * `startGrowth` times, for each round of arms already forked), at `angle` degrees, `length` metres long, straying
   * `stray` metres. A share `loop` come back to the road `loopReach` times their length farther out, bowed
   * `loopOut` metres aside. A fork that cannot be laid clear of water and the anchors is tried `tries` times.
   */
  forks: z.strictObject({
    from: wholeNumber,
    counts: z.array(z.strictObject({ below: wholeNumber.optional(), forks: wholeNumber })).min(1),
    start: span,
    startGrowth: z.number().nonnegative(),
    angle: span,
    length: span,
    stray: z.number().nonnegative(),
    loop: probability,
    loopOut: span,
    loopReach: share,
    tries: wholeNumber,
  }),
  /**
   * Thickening, never lengthening: when frontage runs out a lane is added. `candidates` are tried, each leaving a
   * lane or the road within the cap, square to it or straight on from a lane's end (turned by about `turn` or
   * `endTurn` radians), `length` metres long, straying `stray`; or, where two lanes end within `loopWithin` metres of
   * each other, a lane joining the ends. None may reach farther from the centre than `reach` times the cap
   * (`crossroadsReach` at a crossroads, and no more than `walledReach` in a village with a palisade), nor end more
   * than `beyond` times that. One that meets another way more than `joinAfter` metres along stops there and joins
   * it; one that ends within `joinWithin` of a way is carried on to it. It is refused if shorter than `shortest`,
   * within `alongside` metres of another way along its body, or nearer than `baseClear` to the way it leaves beyond
   * its first stretch, or if it crosses water or an anchor, or passes within `greenClear` of the green. Within its
   * first `displaceWithin` metres it may cut through the plots lining the way it leaves: they are taken away and
   * their buildings placed again, each costing `displaceCost` of its score; beyond, it may cross no plot.
   * Free frontage is counted as plots `box.width` by `box.depth` every `box.step` metres along both sides; the kept
   * lane has the most, times `joinBonus` for a join, less `nearness` for each metre of its middle from the centre,
   * plus up to `luck`, and at least `least`. Where none will do, any lane at all is tried once more, and then the
   * reach grows by `grow`, at most `relax` times running; after that the village cannot be laid out.
   */
  thicken: z.strictObject({
    candidates: wholeNumber.min(1),
    reach: share,
    crossroadsReach: share,
    walledReach: share,
    beyond: share,
    length: span,
    stray: z.number().nonnegative(),
    turn: z.number().nonnegative(),
    endTurn: z.number().nonnegative(),
    loopWithin: metres,
    joinAfter: metres,
    joinWithin: metres,
    shortest: metres,
    alongside: metres,
    baseClear: metres,
    greenClear: metres,
    displaceWithin: metres,
    displaceCost: z.number().nonnegative(),
    box: z.strictObject({ width: metres, depth: metres, step: metres }),
    joinBonus: share,
    nearness: z.number().nonnegative(),
    luck: z.number().nonnegative(),
    least: z.number().nonnegative(),
    grow: share,
    relax: wholeNumber.min(1),
  }),
  /**
   * A village flagged `walls` has a palisade, fitted after all plots: a near-circle round every plot and anchor at
   * least `clear` metres inside it, its shorter axis no less than `round` of its longer, wobbling by `wobble` (two
   * waves round it), grown by `grow` at a time until it fits, at most to `most` times its first size, drawn with
   * `points` points and `width` metres thick. It has a gap where a road passes, `gate` metres either side of the
   * roadway; a lane's tail beyond it is cut off.
   */
  palisade: z.strictObject({ clear: metres, round: probability, wobble: z.tuple([z.number().nonnegative(), z.number().nonnegative()]), grow: share, most: share, points: z.int().min(12), width: metres, gate: z.number().nonnegative() }),
  /**
   * Fields, last, outside the village's envelope: the palisade grown by `envelope.palisade`, or the plots grown by
   * `envelope.grow` and shrunk by `envelope.shrink`. They reach `band` metres (`largeBand` from `largeFrom`
   * buildings) beyond the farthest plot, keep `waterClear` from water and `greenClear` from the green, and are cut
   * only by the roads, `roadClear` beyond the roadway. Within `strips.within` of the envelope they are long strips,
   * `strips.width` wide and at most `strips.length` long; farther out, closes of about `closes.area` square metres;
   * beyond `commons.beyond` of the envelope, commons of about `commons.area`. Fields are parted by `gap` metres, and
   * none is under `least` square metres. A share `wood.share` of those beyond `wood.beyond` are woodland, a tree to
   * every `wood.perTree` square metres, `wood.radius` across. Furrows run along a field `furrow` metres apart. A
   * share `trees.share` of plots have a tree at a back corner, `trees.radius`; a landing has `boats.count` boats,
   * `boats.length` by `boats.width`, out `boats.out` and along `boats.along` from it. All of it is drawing.
   */
  fields: z.strictObject({
    envelope: z.strictObject({ palisade: metres, grow: metres, shrink: metres }),
    band: metres,
    largeBand: metres,
    largeFrom: wholeNumber,
    waterClear: z.number().nonnegative(),
    greenClear: z.number().nonnegative(),
    roadClear: z.number().nonnegative(),
    strips: z.strictObject({ within: metres, width: span, length: metres }),
    closes: z.strictObject({ area: span }),
    commons: z.strictObject({ beyond: metres, area: span }),
    gap: metres,
    least: metres,
    wood: z.strictObject({ share: probability, beyond: metres, perTree: metres, radius: span }),
    furrow: metres,
    trees: z.strictObject({ share: probability, radius: span }),
    boats: z.strictObject({ count: wholeNumber, length: metres, width: metres, out: span, along: metres }),
  }),
  /** At a crossroads, from the forks' `from`, a curved lane joins each two neighbouring arms no more than `widest` degrees apart, `radius` metres out on the one and that times `spread` on the other, bowed out by `bulge`. */
  links: z.strictObject({ radius: span, spread: span, bulge: span, widest: z.number().min(0).max(180) }),
  /**
   * Plots, laid outward from the centre along both sides of every way. A plot is `width` by `depth` metres
   * (`largeDepth` from `largeFrom` buildings, so that a larger village is no more spread out than it must be), wider
   * the larger its building's lot, by `jitter` of the span at most; the next is `spacing` metres along. Its house
   * stands at the front, `house.setBack` back, `house.width` by `house.depth` (a share `turned` gable-on), at least
   * `house.margin` from the plot's sides. A plot wider than `farmstead.wider` is a farmstead by chance
   * `farmstead.share`: a barn behind the house and perhaps a shed at the back, drawing only. From `row.from`
   * buildings, plots within `row.within` metres of the centre are `row.width` wide and `row.plot` deep, their houses `row.depth` deep
   * and joined into a terraced row; they go to buildings whose lot is at most `row.most` metres wide. The next
   * plot goes to the way nearest the centre, the distance along a road weighted by `roadWeight` and a lane's raised
   * by `lanePenalty`. A road is built no farther than the cap each way, a lane no farther than `laneReach` times
   * the cap from the centre. Ways are walked in steps of `step` metres where a plot does not fit.
   */
  plots: z.strictObject({
    width: span,
    depth: span,
    largeDepth: span,
    largeFrom: wholeNumber,
    jitter: probability,
    spacing: span,
    house: z.strictObject({ width: span, depth: span, turned: probability, setBack: span, margin: z.number().nonnegative() }),
    farmstead: z.strictObject({ wider: metres, share: probability, barn: z.strictObject({ width: span, depth: span, behind: span }), shed: z.strictObject({ width: metres, depth: metres, share: probability }) }),
    row: z.strictObject({ from: wholeNumber, within: metres, width: span, depth: span, plot: span, most: metres }),
    roadWeight: share,
    lanePenalty: z.number().nonnegative(),
    laneReach: share,
    step: metres,
  }),
  /**
   * The anchors, placed before any plot, and the building types each holds: the first type the city has, the
   * lowest ID of it. A well's site is `side` metres square, its footprint `footprint` square in the middle. A village flagged `plaza` has a green, and others by chance: `share.least` at `share.from`
   * buildings, rising to `share.most` at `share.to`. A green is an oval `length` by `width` metres (`large` from `largeFrom` buildings), with a
   * pond and the well, beside the road at the centre; without one the well stands by the road there. A church's,
   * a manor's plot is `width` by `depth` and lies at least `from` metres from the centre. A mill is `length` by
   * `width` at the bank, `along` metres from the crossing. A landing is ground `site.width` by `site.depth` at the shore, at the end of a lane, with a jetty `length` metres over the water.
   */
  anchors: z.strictObject({
    green: z.strictObject({ types: z.array(id).min(1), share: z.strictObject({ least: probability, most: probability, from: wholeNumber, to: wholeNumber }), small: z.strictObject({ length: metres, width: metres }), large: z.strictObject({ length: metres, width: metres }), largeFrom: wholeNumber, wobble: probability, pond: metres, pondAlong: probability }),
    well: z.strictObject({ types: z.array(id).min(1), side: metres, footprint: metres }),
    church: z.strictObject({ types: z.array(id).min(1), width: metres, depth: metres, from: z.number().nonnegative() }),
    manor: z.strictObject({ types: z.array(id).min(1), width: metres, depth: metres, from: z.number().nonnegative() }),
    mill: z.strictObject({ types: z.array(id).min(1), length: metres, width: metres, along: z.number().nonnegative() }),
    landing: z.strictObject({ types: z.array(id).min(1), length: metres, width: metres, site: z.strictObject({ width: metres, depth: metres }) }),
  }),
});
export type VillageSettings = z.infer<typeof VillageSettingsSchema>;

const LayoutSettingsSchema = z.strictObject({
  /** Which generator lays towns out: the `staged` generator or the plain `grid`; left out, the grid. */
  generator: LayoutGeneratorSchema.optional(),
  /** The numbers of the `staged` generator, which is being built stage by stage. */
  staged: StagedSettingsSchema.optional(),
  /** The numbers of the village generator. Left out, a village is laid out as any other town. */
  village: VillageSettingsSchema.optional(),
  /** The full width of the roadway, per kind of street segment. */
  streetWidths: z.strictObject({ arterial: metres, street: metres, lane: metres, bridge: metres }),
  /** The land between streets: its length along the street and its depth. */
  block: z.strictObject({ length: metres, depth: metres }),
  /** The lot of a building type that has no entry of its own. */
  defaultLot: LotSizeSchema,
  /** Lot sizes by workplace, dwelling and landmark type. */
  lots: z.record(id, LotSizeSchema),
  /**
   * How much of a lot its building covers, as a share of the lot's depth back from the street:
   * a default, and building types that differ. Left out, lots have no footprints.
   */
  footprints: z.strictObject({ coverage: probability, types: z.record(id, probability) }).optional(),
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

const CalendarSchema = z
  .strictObject({
    /** The days of the week in order, and which are rest days. */
    week: z.array(z.strictObject({ name: text, rest: z.boolean() })).min(1),
    daysPerYear: z.int().positive(),
    sunrise: clockTime,
    sunset: clockTime,
  })
  .refine((value) => value.sunrise < value.sunset, 'sunrise must be before sunset');
export type Calendar = z.infer<typeof CalendarSchema>;

const AvatarSettingsSchema = z.strictObject({
  /** Metres per game second. */
  walkingSpeed: z.number().positive(),
  /** How far the avatar perceives residents from a street, in metres. */
  perceptionRadius: metres,
});
export type AvatarSettings = z.infer<typeof AvatarSettingsSchema>;

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour written "#rrggbb"');
const DisplaySchema = z.strictObject({
  /** A colour for each workforce category. */
  categories: z.strictObject(Object.fromEntries(CATEGORY_IDS.map((category) => [category, colour])) as Record<CategoryId, typeof colour>),
  keepingHouse: colour,
  notWorking: colour,
  /** Single occupations with a colour of their own, which takes priority over their category's. */
  occupations: z.record(id, colour).optional(),
  /** A colour for each kind of traveller, by the kind's ID in the travellers file. */
  travellers: z.record(id, colour).optional(),
  /** The colour of people who live on the streets. */
  vagrants: colour.optional(),
});
export type Display = z.infer<typeof DisplaySchema>;

const TimeSchema = z.strictObject({
  /** Clock rates on offer, in game seconds per real second. */
  rates: z.array(z.number().positive()).min(1),
  defaultRate: z.number().positive(),
});

const ShiftSchema = z.strictObject({
  name: text,
  start: clockTime,
  end: clockTime,
  /** Must be true when the shift ends on the day after it starts. */
  crossesMidnight: z.boolean().optional(),
  /** Whether the shift is worked on rest days, and if so what share of each occupation is on duty then. */
  restDays: z.boolean(),
  dutyShare: probability.optional(),
});
export type Shift = z.infer<typeof ShiftSchema>;

/** One stop of an errand. */
const VisitStopSchema = z.strictObject({
  destinations: z.array(id).min(1),
  durationMinutes: z.strictObject({ min: minutes, max: minutes }),
  /** The chance that this stop is made at all. Left out means always. */
  chance: probability.optional(),
  nearest: z.boolean().optional(),
});

const VisitSchema = z.strictObject({
  id,
  name: text,
  who: z.strictObject({
    states: z.array(WorkforceStateSchema).min(1),
    minAge: wholeNumber.optional(),
    maxAge: wholeNumber.optional(),
  }),
  /** How many times in a day, each at a time of its own within `when`. Left out means once. */
  timesPerDay: z.strictObject({ min: z.int().positive(), max: z.int().positive() }).optional(),
  /** On which kind of day the visit can happen. */
  days: z.enum(['work', 'rest', 'any']),
  /** Days of the week, by the calendar's names, to which the visit is limited. Left out means any. */
  weekdays: z.array(text).min(1).optional(),
  probability,
  /** After the day's work, on the way home; or starting at some time in a window of the day. */
  when: z.union([z.literal('after-work'), z.strictObject({ from: clockTime, to: clockTime })]),
  /** For a visit with one stop: how long it lasts. */
  durationMinutes: z.strictObject({ min: minutes, max: minutes }).optional(),
  /** For a visit with one stop: the building types it can go to. `home` is the person's own dwelling, which takes no walk to reach. */
  destinations: z.array(id).min(1).optional(),
  /** Always the nearest destination that will do, instead of favouring nearer ones by chance. */
  nearest: z.boolean().optional(),
  /** For an errand that chains: several stops in a row, each walked to from the last, before going home. */
  stops: z.array(VisitStopSchema).optional(),
  /** For a walk with no destination: out from home, by way of a street point or a public place, and back. */
  stroll: z
    .strictObject({
      /** How long is spent walking. */
      minutes: z.strictObject({ min: minutes, max: minutes }),
      /** How long the walker pauses where they turn. */
      pauseMinutes: z.strictObject({ min: minutes, max: minutes }),
      /** Building types a stroll goes by way of where the town has them, such as a market square. */
      favour: z.array(id).optional(),
    })
    .optional(),
  /** The visitor is outside, whatever the building type. */
  outside: z.boolean().optional(),
  /** Where an outside visitor is: on the lot's open ground, or out on the street in front of the building. Left out means the ground. */
  where: z.enum(['ground', 'street']).optional(),
});
export type Visit = z.infer<typeof VisitSchema>;
export type VisitStop = z.infer<typeof VisitStopSchema>;

/** The stops of a visit, in order: its own list, or the one stop a plain visit has. A stroll has none. */
export function stopsOf(visit: Visit): VisitStop[] {
  if (visit.stops) return visit.stops;
  if (visit.destinations && visit.durationMinutes) return [{ destinations: visit.destinations, durationMinutes: visit.durationMinutes, ...(visit.nearest && { nearest: true }) }];
  return [];
}

/** A round: work done on foot, on a circuit that starts and ends at the workplace. */
const RoundSchema = z.strictObject({
  name: text,
  /** How much of each shift is spent on rounds. */
  share: probability,
  /** How many stops a circuit has. */
  stops: z.strictObject({ min: z.int().positive(), max: z.int().positive() }),
  /** How long each stop lasts. */
  stopMinutes: z.strictObject({ min: minutes, max: minutes }),
  /** How far a round ranges: the district of the workplace, or the whole town. */
  range: z.enum(['district', 'town']),
  /** What a stop is: a point on a street, or a building of one of the types listed. */
  at: z.union([z.literal('street'), z.array(id).min(1)]),
});
export type Round = z.infer<typeof RoundSchema>;

const VisitsSchema = z.strictObject({
  /** How strongly nearer destinations are favoured: 1 is not at all, higher is more. */
  nearness: z.number().min(1),
  /** Whether a visit goes only to a place that is open when the visitor arrives. Left out, places are never closed. */
  openingHours: z.boolean().optional(),
  /** How far along the street, either way, someone out on the street in front of a building or at a stop on a round moves about. */
  streetReach: metres.optional(),
  visits: z.array(VisitSchema),
});

const minuteRange = z.strictObject({ min: minutes, max: minutes });
const countRange = z.strictObject({ min: wholeNumber, max: wholeNumber });

/**
 * Something an outsider does in town: one stop, a chain of stops, or a stroll. It has the forms a resident's
 * visit has, without the parts that say which residents make it.
 */
const OutsiderVisitSchema = z.strictObject({
  id,
  name: text,
  /** The window of the day in which it starts. */
  when: z.strictObject({ from: clockTime, to: clockTime }),
  durationMinutes: minuteRange.optional(),
  destinations: z.array(id).min(1).optional(),
  nearest: z.boolean().optional(),
  stops: z.array(VisitStopSchema).optional(),
  stroll: z.strictObject({ minutes: minuteRange, pauseMinutes: minuteRange, favour: z.array(id).optional() }).optional(),
  outside: z.boolean().optional(),
  where: z.enum(['ground', 'street']).optional(),
});
export type OutsiderVisit = z.infer<typeof OutsiderVisitSchema>;

/** The stops of an outsider's visit, in order. A stroll has none. */
export function outsiderStopsOf(visit: OutsiderVisit): VisitStop[] {
  if (visit.stops) return visit.stops;
  if (visit.destinations && visit.durationMinutes) return [{ destinations: visit.destinations, durationMinutes: visit.durationMinutes, ...(visit.nearest && { nearest: true }) }];
  return [];
}

/** Which of the file's visits a kind of outsider makes, how likely each day, and how many times. */
const OutsiderVisitsSchema = z.array(z.strictObject({ visit: id, chance: probability, times: z.strictObject({ min: z.int().positive(), max: z.int().positive() }).optional() }));

const TravellerKindSchema = z.strictObject({
  id,
  name: text,
  /**
   * How many parties arrive in a day, on average: the sum of these terms, times the multiplier of the day of
   * the week. The number on a given day is drawn around that average.
   */
  arrivals: z.strictObject({
    /** In any settlement. */
    base: weight.optional(),
    /** For every thousand residents. */
    perThousandResidents: weight.optional(),
    /** For each route exit, by the kind of route. A party also enters by an exit with these weights. */
    perExit: z.partialRecord(RouteKindSchema, weight).optional(),
    /** For each point of the settlement's draw, where the draw reaches its floor. */
    perDraw: weight.optional(),
    /** Multipliers by day of the week, by the calendar's names. A day left out has 1. */
    weekdays: z.record(text, weight).optional(),
  }),
  partySize: z.strictObject({ min: z.int().positive(), max: z.int().positive() }),
  /** How many nights a party stays. One that stays none does not lodge: it makes its visits on the way through and leaves. */
  nights: countRange,
  /** The hours of the day in which a party arrives, and those of its last day in which one that lodged sets out. */
  arrivalHours: z.strictObject({ from: clockTime, to: clockTime }),
  departureHours: z.strictObject({ from: clockTime, to: clockTime }),
  ages: range,
  maleShare: probability,
  /** Building types a party lodges at. It takes one of those the settlement has; with none of them it does not stay the night. */
  lodging: z.array(id).optional(),
  /** By which exit a party leaves: the one it came by, another where there is one, or any. */
  leaves: z.enum(['same', 'other', 'any']),
  visits: OutsiderVisitsSchema,
});
export type TravellerKind = z.infer<typeof TravellerKindSchema>;

/** Where on the street graph someone with no dwelling may sleep. */
export const SleepingPlaceSchema = z.enum(['lane', 'bridge-end', 'edge', 'gate']);
export type SleepingPlace = z.infer<typeof SleepingPlaceSchema>;

const VagrantsSchema = z.strictObject({
  name: text,
  /** A settlement with fewer residents has none. */
  minPopulation: wholeNumber,
  /** How many there are, as a share of the residents. They are not residents and are not counted among them. */
  share: probability,
  ages: range,
  maleShare: probability,
  /** The kinds of place one sleeps at: a lane, the end of a bridge, a street at the town's edge, which is one built on one side only, or by a gate in the town's wall. */
  sleepsAt: z.array(SleepingPlaceSchema).min(1),
  /** How many places each has to sleep, and for how many days running one is kept before another may be chosen. */
  haunts: z.int().positive(),
  spotDays: z.strictObject({ min: z.int().positive(), max: z.int().positive() }),
  visits: OutsiderVisitsSchema,
});
export type VagrantRules = z.infer<typeof VagrantsSchema>;

const TravellersSchema = z.strictObject({
  /** A settlement's draw: how much it attracts visitors who have no business there. */
  draw: z.strictObject({
    /** What each flag and status adds. */
    conditions: z.partialRecord(ConditionSchema, weight),
    /** For sheer size: so much for every thousand residents, up to a most. */
    population: z.strictObject({ perThousand: weight, max: weight.optional() }),
    /** For what the settlement is known for: so much for each specialty tag the pack does not ignore, up to a number of tags. */
    specialties: z.strictObject({ perTag: weight, maxTags: wholeNumber }),
    /** Below this a settlement draws no such visitors at all. */
    floor: weight,
  }),
  visits: z.array(OutsiderVisitSchema),
  kinds: z.array(TravellerKindSchema),
  vagrants: VagrantsSchema.optional(),
});
export type TravellerRules = z.infer<typeof TravellersSchema>;

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
  calendar: CalendarSchema,
  time: TimeSchema,
  avatar: AvatarSettingsSchema,
  display: DisplaySchema,
  rounds: z.record(id, RoundSchema),
  shifts: z.strictObject({ default: id, shifts: z.record(id, ShiftSchema) }),
  visits: VisitsSchema,
  travellers: TravellersSchema.optional(),
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

/**
 * The role a person is shown in: their occupation if the pack gives it a colour of its own, otherwise
 * their occupation's category, otherwise their workforce state. `occupations` is every occupation by ID.
 */
export function roleOf(person: { occupationId?: string | undefined; workforceState: WorkforceState }, pack: SettingPack, occupations: ReadonlyMap<string, Occupation>): string {
  const occupation = person.occupationId === undefined ? undefined : occupations.get(person.occupationId);
  if (!occupation) return person.workforceState === 'keeping-house' ? 'keeping-house' : 'not-working';
  return pack.display.occupations?.[occupation.id] !== undefined ? occupation.id : occupation.category;
}

/** The role a traveller of a kind is shown in, and the role of a vagrant. Neither can be an occupation's or a category's ID. */
export const travellerRole = (kindId: string) => `traveller:${kindId}`;
export const VAGRANT_ROLE = 'vagrant';

/** The colour of each role, by the keys `roleOf` gives, and those of outsiders. */
export function roleColours(pack: SettingPack): Record<string, string> {
  return {
    ...pack.display.categories,
    'keeping-house': pack.display.keepingHouse,
    'not-working': pack.display.notWorking,
    ...pack.display.occupations,
    ...Object.fromEntries(Object.entries(pack.display.travellers ?? {}).map(([kind, shade]) => [travellerRole(kind), shade])),
    ...(pack.display.vagrants !== undefined && { [VAGRANT_ROLE]: pack.display.vagrants }),
  };
}

/** The destination that means a person's own dwelling, whatever its type. */
export const HOME = 'home';

export type NamedShift = Shift & { id: string };

/** The shifts an occupation is worked in, each with the share of its workers on it: its own, or the pack's default. */
export function shiftsOf(occupation: Occupation, pack: SettingPack): Array<NamedShift & { share: number }> {
  const named = occupation.shift ?? pack.shifts.default;
  const entries = typeof named === 'string' ? [{ shift: named, share: 1 }] : named;
  return entries.map(({ shift, share }) => ({ id: shift, share, ...(pack.shifts.shifts[shift] as Shift) }));
}

/** The shift an occupation works. For an occupation split across shifts, this is the first listed. */
export function shiftOf(occupation: Occupation, pack: SettingPack): NamedShift {
  const { share: _share, ...shift } = shiftsOf(occupation, pack)[0] as NamedShift & { share: number };
  return shift;
}

/** What the pack says about a building type as a place to be: out of doors, and open at all hours. */
export function placeFlagsOf(type: string, pack: SettingPack): { openAir: boolean; alwaysOpen: boolean } {
  const entry = pack.workplaces.find((workplace) => workplace.id === type) ?? pack.landmarks.find((landmark) => landmark.id === type);
  return { openAir: entry?.openAir === true, alwaysOpen: entry?.alwaysOpen === true };
}

/** How long a shift lasts, in seconds, allowing for one that crosses midnight. */
export function shiftLength(shift: Shift): number {
  return shift.end - shift.start + (shift.crossesMidnight ? SECONDS_PER_DAY : 0);
}

/** How long the species usually sleeps, in seconds. */
export function sleepLength(species: Species): number {
  const { from, to } = species.life.sleep;
  return (to - from + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

/**
 * How much of its lot a building of the given type covers. An open-air type covers none
 * unless the pack gives it a figure of its own.
 */
export function footprintCoverageOf(type: string, pack: SettingPack): number {
  const settings = pack.layout.footprints;
  if (!settings) return 0;
  return settings.types[type] ?? (placeFlagsOf(type, pack).openAir ? 0 : settings.coverage);
}

/** The lot a building of the given type gets. */
export function lotSizeOf(type: string, pack: SettingPack): LotSize {
  return pack.layout.lots[type] ?? pack.layout.defaultLot;
}

/** The age below which a holder of this occupation is an apprentice; 0 if it has no apprenticeship. */
export function apprenticeUntil(occupation: Occupation, pack: SettingPack): number {
  return occupation.apprenticeUntil ?? pack.pack.apprenticeUntil ?? 0;
}

/** How far a list of shares written as decimals may be from adding up to 1. */
const SHARE_TOLERANCE = 1e-9;

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

  if (pack.layout.staged) {
    const marks = pack.layout.staged.landmarks;
    const types = new Set([...pack.workplaces.map((type) => type.id), ...pack.dwellings.map((type) => type.id), ...pack.landmarks.map((type) => type.id)]);
    for (const [type, mark] of Object.entries(marks.types)) {
      const where = `layout.staged.landmarks.types: "${type}"`;
      if (!types.has(type)) problems.push(`${where} is not a building type of the pack`);
      if (mark.template !== undefined && !(mark.template in marks.templates)) problems.push(`${where} names the template "${mark.template}", which layout.staged.landmarks.templates does not list`);
      if (mark.reservation === 'ward' && mark.ward === undefined) problems.push(`${where} reserves a ward, so it must say which: castle or plaza`);
      if (mark.reservation === 'block' && mark.template === undefined) problems.push(`${where} reserves a block, so it needs a template for its footprint`);
    }
    for (const kind of Object.keys(pack.layout.staged.character.kinds)) needKind(kind, 'layout.staged.character.kinds');
    for (const type of pack.layout.staged.fitting.onRoads) if (!types.has(type)) problems.push(`layout.staged.fitting.onRoads: "${type}" is not a building type of the pack`);
    for (const [name, template] of Object.entries(marks.templates)) {
      for (const [x0, y0, x1, y1] of template.parts) if (!(x0 < x1 && y0 < y1)) problems.push(`layout.staged.landmarks.templates: "${name}" has a part whose corners are not written lowest first`);
    }
  }

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
    if (landmark.district !== undefined) needKind(landmark.district, `landmarks: "${landmark.id}"`);
    else if (!landmark.spread) problems.push(`landmarks: "${landmark.id}" needs a district to prefer, or spread: true`);
    if (landmark.when === undefined && landmark.minPopulation === undefined && !landmark.spread && !('perTravellers' in landmark.count)) {
      problems.push(`landmarks: "${landmark.id}" needs a "when", a minPopulation, spread: true or a count by travellers, to say which settlements have it`);
    }
    if (landmark.proprietorLivesIn && landmark.posts.length === 0) problems.push(`landmarks: "${landmark.id}" has proprietorLivesIn but no post whose holder could live there`);
    for (const spec of [landmark.count, ...landmark.posts.map((post) => post.count)]) {
      if ('perTravellers' in spec && !pack.travellers) problems.push(`landmarks: "${landmark.id}" is counted by travellers, so the pack needs a travellers file`);
    }
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

  // Time: the clock's rates, the shifts and the visits.
  if (!pack.time.rates.includes(pack.time.defaultRate)) {
    problems.push(`time: defaultRate ${pack.time.defaultRate} is not one of the rates listed`);
  }
  if (!(pack.shifts.default in pack.shifts.shifts)) {
    problems.push(`shifts: the default shift "${pack.shifts.default}" is not defined`);
  }
  for (const [shiftId, shift] of Object.entries(pack.shifts.shifts)) {
    const where = `shifts: "${shiftId}"`;
    if (shift.end <= shift.start && !shift.crossesMidnight) {
      problems.push(`${where} ends before it starts; if it runs past midnight, mark it crossesMidnight: true`);
    }
    if (shift.end > shift.start && shift.crossesMidnight) {
      problems.push(`${where} is marked crossesMidnight but ends after it starts on the same day`);
    }
    if (shift.restDays && shift.dutyShare === undefined) problems.push(`${where} is worked on rest days, so it needs a dutyShare`);
    if (!shift.restDays && shift.dutyShare !== undefined) problems.push(`${where} has a dutyShare but is not worked on rest days`);
    // A worker must be able to sleep, get ready, work and wind down within a day.
    for (const [speciesId, species] of Object.entries(pack.species)) {
      const awake = SECONDS_PER_DAY - sleepLength(species);
      const needed = shiftLength(shift) + (species.life.minutesBeforeLeaving + species.life.minutesBeforeBed) * 60;
      if (needed > awake) {
        problems.push(`${where} is too long for the species "${speciesId}": with time before and after, it needs ${(needed / 3600).toFixed(1)} waking hours of ${(awake / 3600).toFixed(1)}`);
      }
    }
  }
  for (const occupation of occupations) {
    if (occupation.shift === undefined) continue;
    const named = typeof occupation.shift === 'string' ? [occupation.shift] : occupation.shift.map((entry) => entry.shift);
    for (const shiftId of named) {
      if (!(shiftId in pack.shifts.shifts)) {
        problems.push(`occupations: "${occupation.id}" names the shift "${shiftId}", which shifts does not define`);
      }
    }
    for (const repeated of duplicates(named)) problems.push(`occupations: "${occupation.id}" lists the shift "${repeated}" more than once`);
    if (typeof occupation.shift !== 'string') {
      const total = occupation.shift.reduce((sum, entry) => sum + entry.share, 0);
      if (Math.abs(total - 1) > SHARE_TOLERANCE) {
        problems.push(`occupations: "${occupation.id}" has shift shares that add up to ${Number(total.toFixed(6))}, not 1`);
      }
    }
  }
  const taken = new Set<string>([...CATEGORY_IDS, 'keeping-house', 'not-working']);
  for (const occupationId of Object.keys(pack.display.occupations ?? {})) {
    if (!occupations.some((occupation) => occupation.id === occupationId)) problems.push(`display: occupations gives a colour to "${occupationId}", which is not an occupation`);
    if (taken.has(occupationId)) problems.push(`display: the occupation "${occupationId}" shares its ID with a category or workforce state, so it cannot have a colour of its own`);
  }
  if (buildingTypeIds.includes(HOME)) {
    problems.push(`a building type is called "${HOME}", which visits use to mean a person's own dwelling: give it another ID`);
  }
  const weekdayNames = pack.calendar.week.map((entry) => entry.name);
  for (const repeated of duplicates(pack.visits.visits.map((visit) => visit.id))) {
    problems.push(`visits: "${repeated}" is defined more than once`);
  }
  for (const visit of pack.visits.visits) {
    const where = `visits: "${visit.id}"`;
    // A visit is one stop, or a chain of stops, or a stroll.
    const forms = [visit.destinations !== undefined || visit.durationMinutes !== undefined, visit.stops !== undefined, visit.stroll !== undefined].filter(Boolean).length;
    if (visit.stops !== undefined && visit.stops.length === 0) problems.push(`${where} is a chain with no stops`);
    else if (forms !== 1) problems.push(`${where} must be exactly one of: a stop (destinations and durationMinutes), a chain (stops), or a stroll`);
    else if ((visit.destinations === undefined) !== (visit.durationMinutes === undefined)) problems.push(`${where} needs both destinations and durationMinutes`);
    if ((visit.stops !== undefined || visit.stroll !== undefined) && visit.when === 'after-work') {
      problems.push(`${where} is a ${visit.stroll ? 'stroll' : 'chain'}, which starts from home at a time of day, so it cannot be after-work`);
    }
    for (const stop of stopsOf(visit)) {
      for (const type of stop.destinations) {
        if (type !== HOME && !buildingTypeIds.includes(type)) problems.push(`${where} names the building type "${type}", which does not exist`);
      }
      if (stop.durationMinutes.min > stop.durationMinutes.max) problems.push(`${where} has a shortest duration above its longest`);
    }
    for (const type of visit.stroll?.favour ?? []) {
      if (!buildingTypeIds.includes(type)) problems.push(`${where} favours the building type "${type}", which does not exist`);
    }
    if (visit.stroll && (visit.stroll.minutes.min > visit.stroll.minutes.max || visit.stroll.pauseMinutes.min > visit.stroll.pauseMinutes.max)) {
      problems.push(`${where} has a shortest time above its longest`);
    }
    if (visit.timesPerDay && visit.timesPerDay.min > visit.timesPerDay.max) problems.push(`${where} has a least number of times a day above its most`);
    if (visit.timesPerDay && visit.when === 'after-work') problems.push(`${where} happens several times a day, so it needs a window of the day, not after-work`);
    if (visit.where === 'street' && !visit.outside) problems.push(`${where} is on the street, so it must be marked outside`);
    if ((visit.where === 'street' || visit.stroll) && pack.visits.streetReach === undefined) problems.push(`${where} puts people on the street, so visits needs a streetReach`);
    for (const weekday of visit.weekdays ?? []) {
      if (!weekdayNames.includes(weekday)) {
        problems.push(`${where} names the weekday "${weekday}", which the calendar does not have (it has ${weekdayNames.join(', ')})`);
      }
    }
    if (visit.when !== 'after-work' && visit.when.from > visit.when.to) problems.push(`${where} has a window that ends before it starts`);
    if (visit.who.minAge !== undefined && visit.who.maxAge !== undefined && visit.who.minAge > visit.who.maxAge) {
      problems.push(`${where} has a minAge above its maxAge`);
    }
  }
  for (const [roundId, round] of Object.entries(pack.rounds)) {
    const where = `rounds: "${roundId}"`;
    if (round.at !== 'street') {
      for (const type of round.at) if (!buildingTypeIds.includes(type)) problems.push(`${where} stops at the building type "${type}", which does not exist`);
    } else if (pack.visits.streetReach === undefined) problems.push(`${where} stops on the street, so visits needs a streetReach`);
    if (round.stops.min > round.stops.max) problems.push(`${where} has a least number of stops above its most`);
    if (round.stopMinutes.min > round.stopMinutes.max) problems.push(`${where} has a shortest stop above its longest`);
  }
  for (const occupation of occupations) {
    if (occupation.round !== undefined && !(occupation.round in pack.rounds)) {
      problems.push(`occupations: "${occupation.id}" names the round "${occupation.round}", which rounds does not define`);
    }
  }
  for (const [speciesId, species] of Object.entries(pack.species)) {
    const bands = species.life.walkingSpeed;
    const open = bands.filter((band) => band.upToAge === undefined).length;
    const ordered = bands.every((band, index) => index === 0 || band.upToAge === undefined || (bands[index - 1] as (typeof bands)[number]).upToAge! < band.upToAge);
    if (open !== 1 || bands[bands.length - 1]?.upToAge !== undefined || !ordered) {
      problems.push(`species: "${speciesId}" needs walking speeds in rising order of upToAge, the last with no upToAge`);
    }
    if (sleepLength(species) === 0) problems.push(`species: "${speciesId}" has sleep hours of no length`);
    const pause = species.life.outside?.pauseMinutes;
    if (pause && pause.min > pause.max) problems.push(`species: "${speciesId}" has a shortest pause outside above its longest`);
  }

  // Layout: every lot must fit in a block, since a block is where lots go.
  const buildingTypes = new Set(buildingTypeIds);
  for (const type of Object.keys(pack.layout.footprints?.types ?? {})) {
    if (!buildingTypes.has(type)) problems.push(`layout: footprints has a coverage for "${type}", which is not a building type`);
  }
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
  if (first && (first.when !== undefined || first.whenDraw !== undefined || !first.weight)) {
    problems.push('districts: the first kind must have a weight and no condition, because every settlement gets one');
  }
  const kindIds = new Set(pack.districts.kinds.map((kind) => kind.id));
  for (const [tier, list] of Object.entries(pack.districts.tierDistricts ?? {})) {
    needTier(tier, 'districts: tierDistricts');
    for (const kind of list.flat()) {
      if (!kindIds.has(kind)) problems.push(`districts: tierDistricts lists the district kind "${kind}" for "${tier}", which does not exist`);
    }
    for (const repeated of duplicates(list.flat())) problems.push(`districts: tierDistricts lists "${repeated}" more than once for "${tier}"`);
  }
  for (const kind of Object.keys(pack.districts.housingNearWork?.kinds ?? {})) {
    if (!kindIds.has(kind)) problems.push(`districts: housingNearWork has a share for the district kind "${kind}", which does not exist`);
  }
  if (pack.pack.homeAndWorkLabel !== undefined && !pack.pack.homeAndWorkLabel.includes('{workplace}')) {
    problems.push(`pack: homeAndWorkLabel "${pack.pack.homeAndWorkLabel}" must contain {workplace}`);
  }
  const kindOfType = new Map<string, string>();
  for (const kind of pack.districts.kinds) {
    const where = `districts: "${kind.id}"`;
    const says = [kind.weight !== undefined, kind.when !== undefined, kind.whenDraw !== undefined].filter(Boolean).length;
    if (says === 0) problems.push(`${where} needs either a weight or a condition`);
    if (says > 1) problems.push(`${where} has more than one of a weight, a condition and a draw to reach`);
    if (kind.whenDraw !== undefined && !pack.travellers) problems.push(`${where} depends on the settlement's draw, so the pack needs a travellers file`);
    for (const type of kind.types ?? []) {
      if (!buildingTypes.has(type)) problems.push(`${where} lists the building type "${type}", which does not exist`);
      if (kindOfType.has(type)) problems.push(`${where} lists the building type "${type}", which "${kindOfType.get(type)}" lists too`);
      kindOfType.set(type, kind.id);
    }
    for (const tier of kind.statuses) needTier(tier, where);
    for (const pattern of kind.names) {
      for (const [, key] of pattern.matchAll(/\{([^}]*)\}/g)) {
        if (key !== 'settlement' && !(key as string in pack.districts.words)) {
          problems.push(`${where} has the name pattern "${pattern}", but districts.words has no "${key}"`);
        }
      }
    }
  }

  // Travellers and vagrants
  const outsiders = pack.travellers;
  for (const kindId of Object.keys(pack.display.travellers ?? {})) {
    if (!outsiders?.kinds.some((kind) => kind.id === kindId)) problems.push(`display: travellers gives a colour to "${kindId}", which is not a kind of traveller`);
  }
  if (outsiders) {
    const outsiderVisits = new Map(outsiders.visits.map((visit) => [visit.id, visit]));
    for (const repeated of duplicates([...pack.visits.visits.map((visit) => visit.id), ...outsiders.visits.map((visit) => visit.id)])) {
      problems.push(`travellers: the visit "${repeated}" is defined more than once, here or in visits`);
    }
    for (const visit of outsiders.visits) {
      const where = `travellers: the visit "${visit.id}"`;
      const forms = [visit.destinations !== undefined || visit.durationMinutes !== undefined, visit.stops !== undefined, visit.stroll !== undefined].filter(Boolean).length;
      if (visit.stops !== undefined && visit.stops.length === 0) problems.push(`${where} is a chain with no stops`);
      else if (forms !== 1) problems.push(`${where} must be exactly one of: a stop (destinations and durationMinutes), a chain (stops), or a stroll`);
      else if ((visit.destinations === undefined) !== (visit.durationMinutes === undefined)) problems.push(`${where} needs both destinations and durationMinutes`);
      for (const stop of outsiderStopsOf(visit)) {
        for (const type of stop.destinations) if (!buildingTypes.has(type)) problems.push(`${where} names the building type "${type}", which does not exist`);
        if (stop.durationMinutes.min > stop.durationMinutes.max) problems.push(`${where} has a shortest duration above its longest`);
      }
      for (const type of visit.stroll?.favour ?? []) if (!buildingTypes.has(type)) problems.push(`${where} favours the building type "${type}", which does not exist`);
      if (visit.stroll && (visit.stroll.minutes.min > visit.stroll.minutes.max || visit.stroll.pauseMinutes.min > visit.stroll.pauseMinutes.max)) problems.push(`${where} has a shortest time above its longest`);
      if (visit.where === 'street' && !visit.outside) problems.push(`${where} is on the street, so it must be marked outside`);
      if ((visit.where === 'street' || visit.stroll) && pack.visits.streetReach === undefined) problems.push(`${where} puts people on the street, so visits needs a streetReach`);
      if (visit.when.from > visit.when.to) problems.push(`${where} has a window that ends before it starts`);
    }
    const checkVisits = (where: string, list: ReadonlyArray<{ visit: string; times?: { min: number; max: number } | undefined }>) => {
      for (const entry of list) {
        if (!outsiderVisits.has(entry.visit)) problems.push(`${where} names the visit "${entry.visit}", which travellers does not define`);
        if (entry.times && entry.times.min > entry.times.max) problems.push(`${where} makes "${entry.visit}" a least number of times above its most`);
      }
      for (const repeated of duplicates(list.map((entry) => entry.visit))) problems.push(`${where} lists the visit "${repeated}" more than once`);
    };
    for (const repeated of duplicates(outsiders.kinds.map((kind) => kind.id))) problems.push(`travellers: the kind "${repeated}" is defined more than once`);
    for (const kind of outsiders.kinds) {
      const where = `travellers: "${kind.id}"`;
      for (const type of kind.lodging ?? []) if (!buildingTypes.has(type)) problems.push(`${where} lodges at the building type "${type}", which does not exist`);
      checkVisits(where, kind.visits);
      for (const weekday of Object.keys(kind.arrivals.weekdays ?? {})) {
        if (!weekdayNames.includes(weekday)) problems.push(`${where} names the weekday "${weekday}", which the calendar does not have (it has ${weekdayNames.join(', ')})`);
      }
      if (kind.partySize.min > kind.partySize.max) problems.push(`${where} has a smallest party above its largest`);
      if (kind.nights.min > kind.nights.max) problems.push(`${where} has a shortest stay above its longest`);
      if (kind.ages.max > Math.min(...Object.values(pack.species).map((species) => species.ages.maxAge))) problems.push(`${where} has ages above the maximum age of a species`);
      if (kind.arrivalHours.from > kind.arrivalHours.to || kind.departureHours.from > kind.departureHours.to) problems.push(`${where} has hours that end before they start`);
      if (kind.nights.max > 0 && (kind.lodging ?? []).length === 0) problems.push(`${where} can stay the night, so it needs somewhere to lodge`);
    }
    const vagrants = outsiders.vagrants;
    if (vagrants) {
      const where = 'travellers: vagrants';
      checkVisits(where, vagrants.visits);
      // Someone with no dwelling is never indoors: everything they do is out on a street.
      for (const entry of vagrants.visits) {
        const visit = outsiderVisits.get(entry.visit);
        if (visit && !visit.stroll && visit.where !== 'street') problems.push(`${where} makes the visit "${visit.id}", which is not a stroll and not spent out on the street (outside: true, where: street)`);
        if (visit?.stroll?.favour?.length) problems.push(`${where} makes the stroll "${visit.id}", which goes by way of buildings; a vagrant's stroll keeps to the streets`);
      }
      if (vagrants.spotDays.min > vagrants.spotDays.max) problems.push(`${where} has a shortest run of days above its longest`);
      if (vagrants.ages.max > Math.min(...Object.values(pack.species).map((species) => species.ages.maxAge))) problems.push(`${where} has ages above the maximum age of a species`);
      if (pack.visits.streetReach === undefined) problems.push(`${where} live on the street, so visits needs a streetReach`);
    }
  }

  return problems;
}
