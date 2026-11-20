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
 */
import { z } from 'zod';
import { BuildingIdSchema, DistrictIdSchema } from '../city/records.ts';
import { BearingSchema, PointSchema, RouteIdSchema, RouteKindSchema, SettlementIdSchema } from '../schema.ts';

/** Raised whenever a layout for the same inputs would change. */
export const LAYOUT_VERSION = 1;

const recordId = (kind: string, digits: number) =>
  z.string().regex(new RegExp(`^${kind}-(0|[1-9][0-9]*)-[0-9]{${digits}}$`), `must be a ${kind} ID`);

export const JunctionIdSchema = recordId('junction', 6);
export const SegmentIdSchema = recordId('segment', 6);
export const LotIdSchema = recordId('lot', 6);
export const ExitIdSchema = recordId('exit', 3);
export const WaterIdSchema = recordId('water', 3);

const text = z.string().min(1);
const count = z.int().nonnegative();
const metres = z.number().positive();
const polygon = z.array(PointSchema).min(3);
const polyline = z.array(PointSchema).min(2);

export const JunctionKindSchema = z.enum(['crossing', 'dead-end', 'bridge-end', 'exit']);
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
    width: metres,
  }),
  z.strictObject({ id: WaterIdSchema, kind: z.literal('sea'), polygon }),
]);
export type Water = z.infer<typeof WaterSchema>;

export const LotSchema = z.strictObject({
  id: LotIdSchema,
  buildingId: BuildingIdSchema,
  polygon,
  districtId: DistrictIdSchema,
  /** The lot is entered from this point on this segment's centre line. */
  entrance: z.strictObject({ segmentId: SegmentIdSchema, point: PointSchema }),
});
export type Lot = z.infer<typeof LotSchema>;

export const DistrictAreaSchema = z.strictObject({
  districtId: DistrictIdSchema,
  /** One or more polygons that touch each other and together enclose the district's lots. */
  polygons: z.array(polygon).min(1),
  labelPoint: PointSchema,
});
export type DistrictArea = z.infer<typeof DistrictAreaSchema>;

export const LayoutSummarySchema = z.strictObject({
  settlementId: SettlementIdSchema,
  counts: z.strictObject({
    junctions: count,
    segments: count,
    exits: count,
    waters: count,
    lots: count,
    districtAreas: count,
  }),
  /** The box around every lot and segment. */
  bounds: z.strictObject({ minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number() }),
  /** The total area of the lots, in square metres. */
  builtArea: z.number().nonnegative(),
  residentsPerHectare: z.number().nonnegative(),
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
  summary: LayoutSummarySchema,
});
export type Layout = z.infer<typeof LayoutSchema>;

/** A walking path between two lots, along the street graph. */
export const LayoutPathSchema = z.strictObject({
  fromLotId: LotIdSchema,
  toLotId: LotIdSchema,
  /** Every segment walked, in order. The first and last are usually walked only in part. */
  segmentIds: z.array(SegmentIdSchema),
  /** In metres, from entrance point to entrance point. */
  length: z.number().nonnegative(),
  /** The line walked, for drawing. */
  points: z.array(PointSchema).min(1),
});
export type LayoutPath = z.infer<typeof LayoutPathSchema>;
