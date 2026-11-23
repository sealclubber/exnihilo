/**
 * The layout format: a settlement's street graph, its water, and one lot per
 * building. This is the only thing that code using a layout may depend on.
 *
 * Coordinates are metres. The origin is the town centre, x points east and y
 * points south. Bearings are degrees clockwise from north, as in the brief.
 *
 * Rules every layout generator must satisfy (checked by invariants.ts):
 * - One lot per building, and every building has one.
 * - Shapes are general. A segment is a polyline and a lot is a polygon.
 *   Nothing that reads a layout may assume straight streets, right angles,
 *   rectangles or a grid.
 * - The graph is the truth for movement. A lot is reached through its
 *   entrance point on its segment; lots do not connect to each other.
 * - IDs carry the settlement number and are zero-padded: lot-641-000123.
 * - The summary names the generator that produced the layout.
 * - A lot's footprints, the outlines of its buildings, lie inside the lot and
 *   do not overlap each other. Everything else in the lot is open ground.
 */
import { z } from 'zod';
import { BuildingIdSchema, DistrictIdSchema } from '../city/records.ts';
import { BearingSchema, PointSchema, RouteIdSchema, RouteKindSchema, SettlementIdSchema } from '../schema.ts';

/**
 * Raised whenever a layout for the same inputs would change. Version 4 places the civic buildings a pack spreads,
 * such as wells, on streets of their own within a district instead of side by side. Version 5 adds walls with
 * gates and open places to the format, and a second generator, `grown`. Version 6 lets a river's width vary along
 * its length, and has the grown generator scatter blocks and leave streets between them. Version 7 lays the grown
 * generator's roads first. Version 8 cuts its ground into wards along the roads, and each ward into its buildings.
 * Version 9 gives a wall several lines where water parts it, and keeps lots to a least width.
 */
export const LAYOUT_VERSION = 9;

const recordId = (kind: string, digits: number) =>
  z.string().regex(new RegExp(`^${kind}-(0|[1-9][0-9]*)-[0-9]{${digits}}$`), `must be a ${kind} ID`);

export const JunctionIdSchema = recordId('junction', 6);
export const SegmentIdSchema = recordId('segment', 6);
export const LotIdSchema = recordId('lot', 6);
export const ExitIdSchema = recordId('exit', 3);
export const WaterIdSchema = recordId('water', 3);
export const WallIdSchema = recordId('wall', 3);
export const PlaceIdSchema = recordId('place', 3);
export const BlockIdSchema = recordId('block', 6);

const text = z.string().min(1);
const count = z.int().nonnegative();
const metres = z.number().positive();
const polygon = z.array(PointSchema).min(3);
const polyline = z.array(PointSchema).min(2);

/** A `gate` is a junction on a wall's line, where a street passes through it. Paths run through it as through any other. */
export const JunctionKindSchema = z.enum(['crossing', 'dead-end', 'bridge-end', 'exit', 'gate']);
export type JunctionKind = z.infer<typeof JunctionKindSchema>;

export const JunctionSchema = z.strictObject({
  id: JunctionIdSchema,
  position: PointSchema,
  kind: JunctionKindSchema,
});
export type Junction = z.infer<typeof JunctionSchema>;

export const SegmentKindSchema = z.enum(['arterial', 'street', 'lane', 'bridge']);
export type SegmentKind = z.infer<typeof SegmentKindSchema>;

export const SegmentSchema = z.strictObject({
  id: SegmentIdSchema,
  fromJunctionId: JunctionIdSchema,
  toJunctionId: JunctionIdSchema,
  /** The centre line, from the first junction's position to the second's. */
  points: polyline,
  kind: SegmentKindSchema,
  /** The roadway's full width. */
  width: metres,
  name: text.optional(),
  /** The brief's route that this segment carries, if any. */
  routeId: RouteIdSchema.optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

/** Where one of the brief's route exits leaves the town. */
export const ExitSchema = z.strictObject({
  id: ExitIdSchema,
  junctionId: JunctionIdSchema,
  routeId: RouteIdSchema,
  name: text.optional(),
  kind: RouteKindSchema,
  /** The brief's bearing for this exit. */
  bearing: BearingSchema,
});
export type Exit = z.infer<typeof ExitSchema>;

export const WaterSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: WaterIdSchema,
    kind: z.literal('river'),
    /** From upstream to downstream. */
    centreLine: polyline,
    /** The width; where `widths` is given, the mean of them. */
    width: metres,
    /** The width at each point of the centre line, for a river whose width varies along its length. */
    widths: z.array(metres).optional(),
  }),
  z.strictObject({ id: WaterIdSchema, kind: z.literal('sea'), polygon }),
]);
export type Water = z.infer<typeof WaterSchema>;

/** A way through a wall: the junction where a street passes, the gatehouse that keeps it, and whether a main road uses it. */
export const GateSchema = z.strictObject({
  junctionId: JunctionIdSchema,
  buildingId: BuildingIdSchema,
  arterial: z.boolean(),
});
export type Gate = z.infer<typeof GateSchema>;

/**
 * A town wall: lines with a width. A wall that runs all the way round is one closed line; one that stops at water is
 * one or more open lines, each ending at a bank, the water closing the gaps. Streets cross it only at its gates.
 */
export const WallSchema = z.strictObject({
  id: WallIdSchema,
  lines: z.array(polyline).min(1),
  closed: z.boolean(),
  width: metres,
  gates: z.array(GateSchema),
});
export type Wall = z.infer<typeof WallSchema>;

/**
 * An open place people can stand in: a plaza, which is the lot of the building it belongs to, or a green, open
 * ground inside the town that belongs to no building.
 */
export const PlaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: PlaceIdSchema, kind: z.literal('plaza'), polygon, buildingId: BuildingIdSchema }),
  z.strictObject({ id: PlaceIdSchema, kind: z.literal('green'), polygon }),
]);
export type Place = z.infer<typeof PlaceSchema>;

export const LotSchema = z.strictObject({
  id: LotIdSchema,
  buildingId: BuildingIdSchema,
  polygon,
  districtId: DistrictIdSchema,
  /** The lot is entered from this point on this segment's centre line. */
  entrance: z.strictObject({ segmentId: SegmentIdSchema, point: PointSchema }),
  /**
   * The outlines of the buildings on the lot: zero or more polygons that lie
   * inside the lot and do not overlap each other. Everything in the lot that
   * is not footprint is open ground.
   */
  footprints: z.array(polygon),
});
export type Lot = z.infer<typeof LotSchema>;

export const DistrictAreaSchema = z.strictObject({
  districtId: DistrictIdSchema,
  /** One or more polygons that touch each other and together enclose the district's lots. */
  polygons: z.array(polygon).min(1),
  labelPoint: PointSchema,
});
export type DistrictArea = z.infer<typeof DistrictAreaSchema>;

/**
 * A block: the ground between streets that lots are cut from, with the order the town grew over it. `growthRank` is
 * 0 for the first ground built on and 1 for the last. A block belongs to a district unless it is a green.
 */
export const BlockSchema = z.strictObject({
  id: BlockIdSchema,
  polygon,
  districtId: DistrictIdSchema.optional(),
  growthRank: z.number().min(0).max(1),
});
export type Block = z.infer<typeof BlockSchema>;

export const LayoutSummarySchema = z.strictObject({
  settlementId: SettlementIdSchema,
  counts: z.strictObject({
    junctions: count,
    segments: count,
    exits: count,
    waters: count,
    lots: count,
    districtAreas: count,
    walls: count,
    gates: count,
    places: count,
  }),
  /** The ground the town covers, streets and open land between them included, in square metres. */
  outlineArea: z.number().nonnegative(),
  /** The box around every lot and segment. */
  bounds: z.strictObject({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() }),
  /** The total area of the lots, in square metres. */
  builtArea: z.number().nonnegative(),
  residentsPerHectare: z.number().nonnegative(),
  /**
   * The share of street and lane length that runs round the centre or straight to it, within 20 degrees, leaving out
   * the middle 30 metres. A town with no preferred direction has about 0.44; a town of rings and spokes nearly 1.
   */
  ringShare: z.number().min(0).max(1),
  /** How many roads leave the centre: the main roads to the brief's exits, and local streets besides. */
  roadsOut: count,
  layoutVersion: z.int().positive(),
  /** Which layout generator made this, so that generators can coexist. */
  generator: text,
  pack: z.strictObject({ name: text, version: text }),
  seed: z.int().min(0).max(0xffffffff),
});
export type LayoutSummary = z.infer<typeof LayoutSummarySchema>;

export const LayoutSchema = z.strictObject({
  junctions: z.array(JunctionSchema),
  segments: z.array(SegmentSchema),
  exits: z.array(ExitSchema),
  waters: z.array(WaterSchema),
  lots: z.array(LotSchema),
  districtAreas: z.array(DistrictAreaSchema),
  /** Empty for most towns. */
  walls: z.array(WallSchema),
  places: z.array(PlaceSchema),
  /** The blocks of a generator that has them; the grid has none. */
  blocks: z.array(BlockSchema).optional(),
  summary: LayoutSummarySchema,
});
export type Layout = z.infer<typeof LayoutSchema>;

/** A position on the street graph: a segment and a point on its line. */
export const StreetPositionSchema = z.strictObject({
  segmentId: SegmentIdSchema,
  point: PointSchema,
});
export type StreetPosition = z.infer<typeof StreetPositionSchema>;

/** A walking path between two positions on the street graph. A lot's position is its entrance. */
export const StreetPathSchema = z.strictObject({
  /** Every segment walked, in order. The first and last are usually walked only in part. */
  segmentIds: z.array(SegmentIdSchema),
  /** How far is walked on each of those segments, in the same order. These sum to the length. */
  walked: z.array(z.number().nonnegative()),
  /** In metres. */
  length: z.number().nonnegative(),
  /** The line walked. */
  points: z.array(PointSchema).min(1),
});
export type StreetPath = z.infer<typeof StreetPathSchema>;

/** A walking path between two lots, along the street graph. */
export const LayoutPathSchema = z.strictObject({
  fromLotId: LotIdSchema,
  toLotId: LotIdSchema,
  /** Every segment walked, in order. The first and last are usually walked only in part. */
  segmentIds: z.array(SegmentIdSchema),
  /** How far is walked on each of those segments, in the same order. These sum to the length. */
  walked: z.array(z.number().nonnegative()),
  /** In metres, from entrance point to entrance point. */
  length: z.number().nonnegative(),
  /** The line walked, for drawing. */
  points: z.array(PointSchema).min(1),
});
export type LayoutPath = z.infer<typeof LayoutPathSchema>;
