/**
 * Day plans and the answers to questions about them.
 *
 * A resident's whereabouts are a pure function of game time. A day plan is
 * derived from the person, the day, the city, the layout, the pack and a
 * seed; nothing here is stored and nothing is stepped forward.
 */
import { z } from 'zod';
import { BuildingIdSchema, PersonIdSchema } from '../city/records.ts';
import { SegmentIdSchema, StreetPositionSchema } from '../layout/records.ts';
import { PointSchema } from '../schema.ts';

const text = z.string().min(1);
const gameTime = z.number();
const count = z.int().nonnegative();

/**
 * Raised whenever the plans for the same inputs would change. Version 1 was
 * the first daily life; version 2 added opening hours, occupations split
 * across shifts, and stays out of doors; version 3 has people who are outside
 * move about the lot's open ground; version 4 added errands that chain and
 * repeat, strolls, work done on rounds, and stops on the street; version 5
 * added outsiders, who are in every answer beside the residents and marked;
 * version 6 has someone outside at a building with no open ground of its own
 * move about its block's courtyard, or the plaza or the street in front.
 */
export const LIFE_VERSION = 6;

/**
 * Outsiders: people in town who do not live there. A traveller's ID carries the settlement's number, the day the
 * party arrived (six digits, with an `m` before them for a day before day 1), the kind of traveller, the party's
 * number among that kind's arrivals of the day, and the member's number: traveller-641-000040-merchant-002-01.
 * So the whole visit can be worked out again from the ID alone. A vagrant's is like a resident's.
 */
export const TravellerIdSchema = z.string().regex(/^traveller-(0|[1-9][0-9]*)-m?[0-9]{6}-[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9]{3}-[0-9]{2}$/, 'must be a traveller ID');
export const PartyIdSchema = z.string().regex(/^party-(0|[1-9][0-9]*)-m?[0-9]{6}-[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9]{3}$/, 'must be a party ID');
export const VagrantIdSchema = z.string().regex(/^vagrant-(0|[1-9][0-9]*)-[0-9]{6}$/, 'must be a vagrant ID');
export const OutsiderIdSchema = z.union([TravellerIdSchema, VagrantIdSchema]);
/** Whoever a plan or an answer is about: a resident or an outsider. An outsider's is marked `outsider`. */
const who = z.union([PersonIdSchema, OutsiderIdSchema]);
const marked = { outsider: z.literal(true).optional() };

/** Whether an ID is an outsider's rather than a resident's. */
export function isOutsiderId(id: string): boolean {
  return id.startsWith('traveller-') || id.startsWith('vagrant-');
}

/**
 * Moving about outside: the points a person is at, on the open ground of a
 * lot, and the game time at which they are at each. Between two points they
 * move in a straight line; where two times share a point, they pause.
 */
export const WanderSchema = z
  .strictObject({
    times: z.array(gameTime).min(2),
    points: z.array(PointSchema).min(2),
  })
  .refine((value) => value.times.length === value.points.length, 'a wander has one time for each point')
  .refine((value) => value.times.every((time, at) => at === 0 || time >= (value.times[at - 1] as number)), 'a wander\'s times never go back');
export type Wander = z.infer<typeof WanderSchema>;

/** Where a stay out of doors is spent: present, with a wander that covers the stay, exactly when the stay is outside. */
const outdoors = {
  outside: z.literal(true).optional(),
  wander: WanderSchema.optional(),
};
const outdoorsTogether = (value: { outside?: true | undefined; wander?: unknown }) => (value.outside === true) === (value.wander !== undefined);
/** Where someone outside is at one moment. */
const outdoorsNow = {
  outside: z.literal(true).optional(),
  /** Where on the lot's open ground they are at this moment. */
  point: PointSchema.optional(),
};

export const ActivityKindSchema = z.enum(['sleep', 'home', 'work', 'visit', 'travel', 'street']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/**
 * Being at a building: asleep or awake at home, at work, or on a visit. A
 * stay is inside the building unless it is marked outside, in which case the
 * person moves about the open ground of its lot and can be seen.
 */
export const StaySchema = z.strictObject({
  kind: z.enum(['sleep', 'home', 'work', 'visit']),
  start: gameTime,
  end: gameTime,
  buildingId: BuildingIdSchema,
  /** For a visit: which of the pack's visits it is. */
  visitId: text.optional(),
  ...outdoors,
  /** Outside, and out on the street in front of the building rather than on its lot: the wander keeps to the entrance segment. */
  onStreet: z.literal(true).optional(),
  /** For work: at a stop on a round, away from the workplace. */
  round: z.literal(true).optional(),
});
export type Stay = z.infer<typeof StaySchema>;

/**
 * Being at a point on a street, with no building: a stop on a round, or a
 * pause on a stroll. The person is outside and moves about a short stretch of
 * the segment, as a wander.
 */
export const StreetPurposeSchema = z.enum(['work', 'visit', 'sleep', 'home']);
export type StreetPurpose = z.infer<typeof StreetPurposeSchema>;

export const StreetStopSchema = z.strictObject({
  kind: z.literal('street'),
  start: gameTime,
  end: gameTime,
  segmentId: SegmentIdSchema,
  wander: WanderSchema,
  /**
   * What the person is there for: their work, or a visit of the pack's. For someone who lives on the streets it
   * may also be `sleep` or `home`: asleep, or awake, at the place where they sleep.
   */
  purpose: StreetPurposeSchema,
  visitId: text.optional(),
  round: z.literal(true).optional(),
});
export type StreetStop = z.infer<typeof StreetStopSchema>;

/** The path of a trip: the segments walked, how far on each, and the line. */
export const TripPathSchema = z.strictObject({
  segmentIds: z.array(SegmentIdSchema),
  walked: z.array(z.number().nonnegative()),
  length: z.number().nonnegative(),
  points: z.array(PointSchema).min(1),
});
export type TripPath = z.infer<typeof TripPathSchema>;

/**
 * Walking from one place to the next. Each end is a building, entered and
 * left by its lot's entrance, or a point on a street. The trip runs from
 * `departAt` to `arriveAt`; `start` and `end` are the part of it that falls
 * in this day's plan, which differ only for a trip that crosses midnight.
 */
export const TravelSchema = z.strictObject({
  kind: z.literal('travel'),
  start: gameTime,
  end: gameTime,
  /** Where the walk begins: a building, or failing that the street position in `fromStreet`. */
  fromBuildingId: BuildingIdSchema.optional(),
  fromStreet: StreetPositionSchema.optional(),
  /** Where it ends, in the same way. */
  toBuildingId: BuildingIdSchema.optional(),
  toStreet: StreetPositionSchema.optional(),
  departAt: gameTime,
  arriveAt: gameTime,
  path: TripPathSchema,
  /** A leg of a round: the walker is at work. */
  round: z.literal(true).optional(),
});
export type Travel = z.infer<typeof TravelSchema>;

export const ActivitySchema = z
  .discriminatedUnion('kind', [StaySchema, TravelSchema, StreetStopSchema])
  .refine((activity) => activity.kind === 'travel' || activity.kind === 'street' || outdoorsTogether(activity), 'a stay has a wander exactly when it is outside')
  .refine(
    (activity) => activity.kind !== 'travel' || ((activity.fromBuildingId === undefined) !== (activity.fromStreet === undefined) && (activity.toBuildingId === undefined) !== (activity.toStreet === undefined)),
    'each end of a walk is a building or a street position, not both and not neither',
  );
export type Activity = z.infer<typeof ActivitySchema>;

/**
 * One person's day, from midnight to midnight, with no gaps and no overlaps. An outsider's plan covers only the
 * part of the day they are in town, and is empty on a day they are not; for a traveller, `sleep` and `home` are
 * asleep and awake at their lodging.
 */
export const DayPlanSchema = z
  .strictObject({
    personId: who,
    ...marked,
    day: z.int(),
    activities: z.array(ActivitySchema),
  })
  .refine((plan) => plan.outsider === true || plan.activities.length > 0, 'a resident\'s plan is never empty');
export type DayPlan = z.infer<typeof DayPlanSchema>;

/** Where a person is at a moment: in a building, outside at one, or at a point on the street. */
export const WhereaboutsSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    personId: who,
    ...marked,
    time: gameTime,
    kind: z.enum(['sleep', 'home', 'work', 'visit']),
    buildingId: BuildingIdSchema,
    visitId: text.optional(),
    ...outdoorsNow,
    onStreet: z.literal(true).optional(),
    round: z.literal(true).optional(),
    /** When the current activity began and when it ends. */
    since: gameTime,
    until: gameTime,
  }),
  z.strictObject({
    personId: who,
    ...marked,
    time: gameTime,
    kind: z.literal('travel'),
    point: PointSchema,
    segmentId: SegmentIdSchema,
    fromBuildingId: BuildingIdSchema.optional(),
    fromStreet: StreetPositionSchema.optional(),
    toBuildingId: BuildingIdSchema.optional(),
    toStreet: StreetPositionSchema.optional(),
    round: z.literal(true).optional(),
    since: gameTime,
    until: gameTime,
  }),
  /** At a point on a street, with no building: a stop on a round, or a pause on a stroll. */
  z.strictObject({
    personId: who,
    ...marked,
    time: gameTime,
    kind: z.literal('street'),
    point: PointSchema,
    segmentId: SegmentIdSchema,
    purpose: StreetPurposeSchema,
    visitId: text.optional(),
    round: z.literal(true).optional(),
    since: gameTime,
    until: gameTime,
  }),
  /** Not in town: a traveller before arriving or after leaving. */
  z.strictObject({ personId: OutsiderIdSchema, outsider: z.literal(true), time: gameTime, kind: z.literal('away') }),
]);
export type Whereabouts = z.infer<typeof WhereaboutsSchema>;

/** Someone at a building at a moment, inside it or outside on its lot. */
export const OccupantSchema = z.strictObject({
  personId: who,
  ...marked,
  kind: z.enum(['sleep', 'home', 'work', 'visit']),
  visitId: text.optional(),
  outside: z.literal(true).optional(),
});
export type Occupant = z.infer<typeof OccupantSchema>;

/** One walk, whole: who, between which buildings, when, and along what line. */
export const TripSchema = z.strictObject({
  personId: who,
  ...marked,
  /** The buildings walked between; one is absent where that end of the walk is a point on a street. */
  fromBuildingId: BuildingIdSchema.optional(),
  toBuildingId: BuildingIdSchema.optional(),
  /** A leg of a round: the walker is at work. */
  round: z.literal(true).optional(),
  departAt: gameTime,
  arriveAt: gameTime,
  length: z.number().nonnegative(),
  points: z.array(PointSchema).min(1),
});
export type Trip = z.infer<typeof TripSchema>;

/**
 * One stay out of doors: who, at which building, from when until when, and the
 * wander that says where they are meanwhile. A query for a window of game time
 * gives only the part of the wander that falls within it.
 */
export const OutsideStaySchema = z.strictObject({
  personId: who,
  ...marked,
  /** The building they are at; absent for a stop on a street, which has a segment instead. */
  buildingId: BuildingIdSchema.optional(),
  segmentId: SegmentIdSchema.optional(),
  kind: StreetPurposeSchema,
  visitId: text.optional(),
  round: z.literal(true).optional(),
  /** At a building, but out on the street in front of it rather than on its lot. */
  onStreet: z.literal(true).optional(),
  wander: WanderSchema,
  from: gameTime,
  to: gameTime,
});
export type OutsideStay = z.infer<typeof OutsideStaySchema>;

/** A resident who can be seen near a point at a moment: walking between two buildings, or outside at one. */
export const NearbySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    personId: who,
    ...marked,
    /** In metres, in a straight line. */
    distance: z.number().nonnegative(),
    point: PointSchema,
    kind: z.literal('walking'),
    /** The buildings walked between; one is absent where that end of the walk is a point on a street. */
    fromBuildingId: BuildingIdSchema.optional(),
    toBuildingId: BuildingIdSchema.optional(),
    /** Walking a round, at work. */
    round: z.literal(true).optional(),
  }),
  z.strictObject({
    personId: who,
    ...marked,
    distance: z.number().nonnegative(),
    point: PointSchema,
    kind: z.literal('outside'),
    /** The building they are at, on its lot or in front of it; absent for someone at a stop on a street, who has a segment instead. */
    buildingId: BuildingIdSchema.optional(),
    segmentId: SegmentIdSchema.optional(),
    /** What they are there for. */
    activity: StreetPurposeSchema,
    visitId: text.optional(),
    round: z.literal(true).optional(),
  }),
]);
export type Nearby = z.infer<typeof NearbySchema>;

/** A stretch of game time during which a building is open. */
export const OpenSpanSchema = z.strictObject({ from: gameTime, to: gameTime });
export type OpenSpan = z.infer<typeof OpenSpanSchema>;

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
        /** Of those at work or visiting, how many were out of doors. */
        outside: z.number().nonnegative(),
        tripsStarted: z.int().nonnegative(),
      }),
    )
    .length(24),
  /** Trips begun during the day. */
  trips: z.int().nonnegative(),
  /**
   * The outsiders in town that day, apart from the residents above: how many travellers by kind and how many
   * vagrants, and for each hour the average number in town and in each state. Present when outsiders are computed.
   */
  outsiders: z
    .strictObject({
      travellers: count,
      vagrants: count,
      byKind: z.record(text, count),
      hours: z
        .array(
          z.strictObject({
            hour: z.int().min(0).max(23),
            inTown: z.number().nonnegative(),
            asleep: z.number().nonnegative(),
            /** Awake at their lodging or, for a vagrant, at the place where they sleep. */
            atLodging: z.number().nonnegative(),
            visiting: z.number().nonnegative(),
            travelling: z.number().nonnegative(),
            outside: z.number().nonnegative(),
          }),
        )
        .length(24),
      trips: count,
    })
    .optional(),
});
export type DaySummary = z.infer<typeof DaySummarySchema>;

/** A region of the map, for limiting a query to what is in view. */
export interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
