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

export const LayoutGeneratorSchema = z.enum(['grid', 'grown']);
export type LayoutGenerator = z.infer<typeof LayoutGeneratorSchema>;

/**
 * The numbers of the `grown` generator: roads first, then wards, then buildings. The roads cut the town's ground
 * into wards, and each ward is cut in two again and again until the pieces are buildings.
 */
const span = z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() });
/** How a kind of district builds: how far its cuts wander from square and the middle, how much its buildings vary in size, and the chance a piece is left open. */
const WardCharacterSchema = z.strictObject({ gridChaos: span, sizeChaos: probability, open: probability });
const GrownSettingsSchema = z.strictObject({
  /**
   * Roadway widths: a highway; an arterial and the road a bridge carries; a street, which is a quay or a street
   * that splits a ward; an alley, the gap a cut leaves between buildings, with a lane down its middle; a bridge.
   */
  widths: z.strictObject({ highway: metres, arterial: metres, street: metres, alley: metres, bridge: metres }),
  /**
   * Highways: every route of the brief, laid before anything else. `wander` is how far a highway strays aside from
   * a straight line, in metres, and no more than `wanderShare` of the town's radius; two exits within `through` degrees of opposite make one road through the centre;
   * a highway runs on `beyond` metres past the town before its exit. Where it crosses a river it leaves its line
   * `approach` metres either side, to meet a bridge square to the bank.
   */
  highways: z.strictObject({ wander: z.number().nonnegative(), wanderShare: z.number().nonnegative(), through: z.number().nonnegative(), beyond: metres, approach: metres }),
  /**
   * Arterials branch off each highway on alternating sides, `spacing` metres apart, along a stretch `span` times the
   * town's radius either side of the centre. Each is `reach` times the radius long less `fall` for every metre
   * along the highway from the centre, times a share drawn from `spread`. It leaves square to the highway, leaning
   * along it by about `lean`, and strays aside by `wander` metres. It stops `bank` metres from water. Once the
   * ground is known each is cut back to within `trim` metres of it, and one left shorter than `shortest` is dropped.
   * In a settlement of fewer than `streetBelow` residents, arterials are as wide as streets.
   */
  arterials: z.strictObject({
    streetBelow: wholeNumber,
    spacing: span,
    span: z.number().positive(),
    reach: z.number().positive(),
    fall: z.number().nonnegative(),
    spread: span,
    lean: z.number().nonnegative(),
    wander: z.number().nonnegative(),
    bank: metres,
    trim: z.number().nonnegative(),
    shortest: metres,
  }),
  /**
   * Bridges stand square to the bank, their ends `landing` metres beyond the water. A town of more than
   * `secondAbove` residents has a second, `apart` metres along the river from the first, with an arterial of its
   * own that strays `wander` metres and runs `beyond` times the town's radius past the far end.
   */
  bridges: z.strictObject({ landing: metres, secondAbove: wholeNumber, apart: metres, wander: z.number().nonnegative(), beyond: z.number().nonnegative() }),
  /** A street follows each bank of a river, `offset` metres out from the water. */
  quays: z.strictObject({ offset: metres }),
  /**
   * The ground the town needs: its buildings' pack lot area over `fill`, times `margin`. Ground is taken cheapest
   * first on a grid of `cell` metres, where cost is the distance from the nearest highway, plus `along` for every
   * metre along it from the centre, plus `arterial` for every metre from the nearest arterial (up to
   * `arterialCap`), plus smooth noise `noise.depth` metres deep over `noise.length` metres. Ground across the water
   * from its nearest highway costs `water` more, and ground within `wet` metres of the water is never taken. The
   * outline is closed over gaps of `close` metres and opened over necks of `open`; nothing is built within
   * `waterClear` metres of the water.
   */
  ground: z.strictObject({
    fill: probability,
    margin: z.number().positive(),
    cell: metres,
    along: z.number().nonnegative(),
    arterial: z.number().nonnegative(),
    arterialCap: metres,
    noise: z.strictObject({ depth: z.number().nonnegative(), length: metres }),
    water: z.number().nonnegative(),
    wet: z.number().nonnegative(),
    close: z.number().nonnegative(),
    open: z.number().nonnegative(),
    waterClear: z.number().nonnegative(),
  }),
  /**
   * Wards: the pieces the roads cut the ground into. One larger than a limit drawn from `limit` (square metres) is
   * split in two by a street across its long axis, `at` of the way along, turned by about `turn` degrees and bent
   * aside by `bend` of its width, at most `rounds` times over. A piece under `least` square metres is no ward.
   */
  wards: z.strictObject({ limit: span, at: span, turn: z.number().nonnegative(), bend: z.number().nonnegative(), rounds: wholeNumber, least: metres }),
  /**
   * Buildings: each ward is cut in two again and again. A cut leaves an alley while the piece is larger than its
   * building size times `alleyAbove` divided by a draw that is usually small; once the piece is under `squareBelow`
   * building sizes the cuts are square. The finished pieces come out at about `pieceShare` of the building size.
   * Each kind of district has a character, `default` for kinds not listed. Building size varies from ward to ward
   * by a share drawn from `vary`. Buildings of more than `big` times the ward's building size are cut for first,
   * a half within `bigMatch` of one's size going to it. The last `loose.share` of wards by growth are loose: a
   * piece is left open with a chance rising from `loose.open.min` to `loose.open.max` toward the very edge, and
   * each building is drawn in from its lot by a distance drawn from `loose.pull`. A ward's buildings are no more
   * than the ground within `frontDepth` metres of the ways along it would hold. No cut leaves a lot narrower than
   * `leastWidth` metres, but for a building whose pack lot is itself narrower, nor more than `longest` times as long
   * as it is wide, both measured on its smallest enclosing rectangle.
   */
  buildings: z.strictObject({
    frontDepth: metres,
    leastWidth: metres,
    longest: z.number().positive(),
    alleyAbove: z.number().positive(),
    squareBelow: z.number().positive(),
    pieceShare: z.number().positive(),
    character: z.record(id, WardCharacterSchema),
    vary: span,
    big: z.number().positive(),
    bigMatch: probability,
    loose: z.strictObject({ share: probability, open: span, pull: span }),
  }),
  /**
   * Districts are chunks of wards: a ward joins the district whose seed ward is nearest, where crossing a highway,
   * an arterial or the water counts as so many metres more; then over `rounds` rounds each district's reach is
   * adjusted until its ground matches its buildings.
   */
  districts: z.strictObject({ penalty: z.strictObject({ highway: z.number().nonnegative(), arterial: z.number().nonnegative(), water: z.number().nonnegative() }), rounds: wholeNumber }),
  /**
   * The plaza of a town flagged for one: so much ground for each resident, between a least and a most, in square
   * metres, and the building type whose lot the plaza is.
   */
  plaza: z.strictObject({ perResident: z.number().nonnegative(), min: metres, max: metres, building: id }),
  /**
   * The wall of a town flagged for one: its width, the share of the town's ground it encloses (the oldest), the
   * number of residents below which it encloses everything, how many metres its line is smoothed over, and the
   * building type that stands at each gate.
   */
  wall: z.strictObject({ width: metres, share: probability, enclosesAllBelow: wholeNumber, smoothing: z.number().nonnegative(), gatehouse: id }),
  /**
   * A river: the length of its meanders as a multiple of its width, their swing aside as a share of that length,
   * the share by which its width varies along it, the length of the pieces its line is cut into, and how far it
   * passes from the centre at the least, beyond the plaza. A coast stands as far out beyond the oldest ground.
   */
  river: z.strictObject({ meanderLength: z.number().positive(), meanderSwing: probability, widthVariation: probability, pieceLength: metres, beside: metres }),
  /** The coast: broad bays and headlands, a smaller wobble on top (each a length along the shore and a depth), and the bay a port's harbour stands in. */
  coast: z.strictObject({
    bays: z.strictObject({ length: metres, depth: z.number().nonnegative() }),
    wobble: z.strictObject({ length: metres, depth: z.number().nonnegative() }),
    harbour: z.strictObject({ length: metres, depth: z.number().nonnegative() }),
    pieceLength: metres,
  }),
});
export type GrownSettings = z.infer<typeof GrownSettingsSchema>;

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
   * centre is never nearer the bank than `least` metres. Each
   * half has one bend, pushed aside by a share of the half's length drawn from `bend`. Its ends lie `beyond` times
   * the reach out. A river that rises here starts a share of the radius drawn from `source` from the centre, and is laid as if it
   * came from opposite the way it leaves, turned by a number of degrees drawn from `sourceTurn`.
   */
  river: z.strictObject({ width: metres, portWidth: share, least: metres, distance: span, portDistance: span, bend: span, beyond: share, source: span, sourceTurn: span }),
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
   * river it runs beside, and an exit that would fall in a river is turned by up to `exitShift` degrees.
   */
  highways: z.strictObject({ through: z.number().min(90).max(180), wander: z.number().nonnegative(), step: metres, waterClear: metres, exitShift: z.number().nonnegative() }),
  /**
   * Bridges. `counts` gives the number by the town's buildings: the first entry whose `below` exceeds them, the
   * last having none. A bridge's ends lie `landing` metres beyond the water. The main crossing is looked for every
   * `step` metres of river within `search` times the radius of the centre, scoring `square` for a river square to
   * the way and losing `near` for each metre from the centre. A town whose centre is within `astrideWithin`
   * metres of that bridge is astride its river. The road runs straight for `lead` metres either side of the main
   * bridge: `single` where it is the only one, otherwise `share` of the distance from the centre held between
   * `min` and `max`. Beside the river further bridges stand `apart` metres along the bank and the highway splits
   * to them, straight for `approach` metres at each; astride it they stand `astrideApart` (a share of the wall's
   * radius, held between `min` and `max`, varied by `vary`) apart and each one's road runs `run` metres on and
   * then to the nearest highway within `joinWithin` times the radius, a metre along the bank counting `veer` more.
   * Where no route crosses the river, the main bridge carries a road of its own that ends `beyond` times the
   * radius into the far bank.
   */
  bridges: z.strictObject({
    counts: z.array(z.strictObject({ below: wholeNumber.optional(), bridges: wholeNumber.min(1) })).min(1),
    landing: metres,
    step: metres,
    search: share,
    square: z.number().nonnegative(),
    near: z.number().nonnegative(),
    astrideWithin: metres,
    lead: z.strictObject({ single: metres, share: share, min: metres, max: metres }),
    apart: span,
    approach: metres,
    astrideApart: z.strictObject({ share: share, min: metres, max: metres, vary: span }),
    run: metres,
    joinWithin: share,
    veer: z.number().nonnegative(),
    beyond: share,
  }),
  /**
   * The wall of a town flagged for one encloses ground for `share` of its buildings at `perBuilding` square metres
   * each. It is an oval `through` times as long as wide along a single through road, `several` otherwise.
   */
  wall: z.strictObject({ share: probability, perBuilding: metres, ratio: z.strictObject({ through: share, several: share }) }),
  /**
   * The harbour of a port: a quay `length` metres long and `width` wide, `inset` metres inland of the water's
   * edge, and no longer than `lengthShare` times the town's radius. On a coast it has `piers.count` piers,
   * `piers.length` long and `piers.width` wide; on a river, jetties no longer than `jettyShare` of the river's
   * width. The road to it strays `wander` metres. A river wharf keeps `clearOfBridge` metres from any bridge.
   */
  harbour: z.strictObject({
    quay: z.strictObject({ length: metres, lengthShare: share, width: metres, inset: metres }),
    piers: z.strictObject({ count: wholeNumber.min(1), length: metres, width: metres }),
    jettyShare: probability,
    wander: z.number().nonnegative(),
    clearOfBridge: metres,
  }),
});
export type StagedSettings = z.infer<typeof StagedSettingsSchema>;

const LayoutSettingsSchema = z.strictObject({
  /** Which generator lays towns out: the plain `grid`, or `grown`. Left out, the grid. */
  generator: LayoutGeneratorSchema.optional(),
  /** The numbers of the `grown` generator. Needed when it is the one named. */
  grown: GrownSettingsSchema.optional(),
  /** The numbers of the `staged` generator, which is being built stage by stage. */
  staged: StagedSettingsSchema.optional(),
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
  const grown = pack.layout.grown;
  if (pack.layout.generator === 'grown' && !grown) problems.push('layout: the generator is "grown", so the file needs a `grown` block with its numbers');
  if (grown) {
    if (grown.plaza.min > grown.plaza.max) problems.push('layout: grown.plaza has a least above its most');
    for (const kind of Object.keys(grown.buildings.character)) if (kind !== 'default' && !kinds.has(kind)) problems.push(`layout: grown.buildings.character names the district kind "${kind}", which districts does not list`);
    if (!grown.buildings.character.default) problems.push('layout: grown.buildings.character needs a `default` for the kinds of district it does not list');
    if (!buildingTypes.has(grown.plaza.building)) problems.push(`layout: grown.plaza names the building type "${grown.plaza.building}", which is not a building type`);
    if (!buildingTypes.has(grown.wall.gatehouse)) problems.push(`layout: grown.wall names the gatehouse type "${grown.wall.gatehouse}", which is not a building type`);
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
