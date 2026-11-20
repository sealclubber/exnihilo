/**
 * Day plans and the answers to questions about them.
 *
 * A resident's whereabouts are a pure function of game time. A day plan is
 * derived from the person, the day, the city, the layout, the pack and a
 * seed; nothing here is stored and nothing is stepped forward.
 */
import { z } from 'zod';
import { BuildingIdSchema, PersonIdSchema } from '../city/records.ts';
import { SegmentIdSchema } from '../layout/records.ts';
import { PointSchema } from '../schema.ts';

const text = z.string().min(1);
const gameTime = z.number();

export const ActivityKindSchema = z.enum(['sleep', 'home', 'work', 'visit', 'travel']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** Being in a building: asleep or awake at home, at work, or on a visit. */
export const StaySchema = z.strictObject({
  kind: z.enum(['sleep', 'home', 'work', 'visit']),
  start: gameTime,
  end: gameTime,
  buildingId: BuildingIdSchema,
  /** For a visit: which of the pack's visits it is. */
  visitId: text.optional(),
});
export type Stay = z.infer<typeof StaySchema>;

/** The path of a trip: the segments walked, how far on each, and the line. */
export const TripPathSchema = z.strictObject({
  segmentIds: z.array(SegmentIdSchema),
  walked: z.array(z.number().nonnegative()),
  length: z.number().nonnegative(),
  points: z.array(PointSchema).min(1),
});
export type TripPath = z.infer<typeof TripPathSchema>;

/**
 * Walking from one building to the next. The trip runs from `departAt` to
 * `arriveAt`; `start` and `end` are the part of it that falls in this day's
 * plan, which differ only for a trip that crosses midnight.
 */
export const TravelSchema = z.strictObject({
  kind: z.literal('travel'),
  start: gameTime,
  end: gameTime,
  fromBuildingId: BuildingIdSchema,
  toBuildingId: BuildingIdSchema,
  departAt: gameTime,
  arriveAt: gameTime,
  path: TripPathSchema,
});
export type Travel = z.infer<typeof TravelSchema>;

export const ActivitySchema = z.discriminatedUnion('kind', [StaySchema, TravelSchema]);
export type Activity = z.infer<typeof ActivitySchema>;

/** One person's day, from midnight to midnight, with no gaps and no overlaps. */
export const DayPlanSchema = z.strictObject({
  personId: PersonIdSchema,
  day: z.int(),
  activities: z.array(ActivitySchema).min(1),
});
export type DayPlan = z.infer<typeof DayPlanSchema>;

/** Where a person is at a moment: in a building, or at a point on the street. */
export const WhereaboutsSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    personId: PersonIdSchema,
    time: gameTime,
    kind: z.enum(['sleep', 'home', 'work', 'visit']),
    buildingId: BuildingIdSchema,
    visitId: text.optional(),
    /** When the current activity began and when it ends. */
    since: gameTime,
    until: gameTime,
  }),
  z.strictObject({
    personId: PersonIdSchema,
    time: gameTime,
    kind: z.literal('travel'),
    point: PointSchema,
    segmentId: SegmentIdSchema,
    fromBuildingId: BuildingIdSchema,
    toBuildingId: BuildingIdSchema,
    since: gameTime,
    until: gameTime,
  }),
]);
export type Whereabouts = z.infer<typeof WhereaboutsSchema>;

/** Someone inside a building at a moment. */
export const OccupantSchema = z.strictObject({
  personId: PersonIdSchema,
  kind: z.enum(['sleep', 'home', 'work', 'visit']),
  visitId: text.optional(),
});
export type Occupant = z.infer<typeof OccupantSchema>;

/** One walk, whole: who, between which buildings, when, and along what line. */
export const TripSchema = z.strictObject({
  personId: PersonIdSchema,
  fromBuildingId: BuildingIdSchema,
  toBuildingId: BuildingIdSchema,
  departAt: gameTime,
  arriveAt: gameTime,
  length: z.number().nonnegative(),
  points: z.array(PointSchema).min(1),
});
export type Trip = z.infer<typeof TripSchema>;

/** A settlement's day, hour by hour. */
export const DaySummarySchema = z.strictObject({
  day: z.int(),
  /** For each hour, the average number of people in each state during it, and the trips begun in it. */
  hours: z
    .array(
      z.strictObject({
        hour: z.int().min(0).max(23),
        asleep: z.number().nonnegative(),
        atHome: z.number().nonnegative(),
        atWork: z.number().nonnegative(),
        visiting: z.number().nonnegative(),
        travelling: z.number().nonnegative(),
        tripsStarted: z.int().nonnegative(),
      }),
    )
    .length(24),
  /** Trips begun during the day. */
  trips: z.int().nonnegative(),
});
export type DaySummary = z.infer<typeof DaySummarySchema>;

/** A region of the map, for limiting a query to what is in view. */
export interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
