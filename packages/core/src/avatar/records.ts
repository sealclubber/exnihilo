/**
 * The avatar: the user's presence in a town.
 *
 * The avatar is never stepped. Its state is a resting place or a trip, and
 * its position at any game time is arithmetic on that state. It is the first
 * thing in the world that the user decides, so unlike a resident it cannot be
 * derived from a seed and is stored.
 */
import { z } from 'zod';
import { BuildingIdSchema } from '../city/records.ts';
import { SegmentIdSchema, StreetPathSchema } from '../layout/records.ts';
import { PointSchema, SettlementIdSchema } from '../schema.ts';

/** What a walk is heading for: a point on a street, or a building, entered on arrival. */
export const AvatarDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('street'), segmentId: SegmentIdSchema, point: PointSchema }),
  z.strictObject({ kind: z.literal('building'), buildingId: BuildingIdSchema }),
]);
export type AvatarDestination = z.infer<typeof AvatarDestinationSchema>;

export const AvatarStateSchema = z.discriminatedUnion('kind', [
  /** Standing on a street: the segment and the point on it. */
  z.strictObject({ kind: z.literal('standing'), settlementId: SettlementIdSchema, segmentId: SegmentIdSchema, point: PointSchema }),
  /** In a building. */
  z.strictObject({ kind: z.literal('inside'), settlementId: SettlementIdSchema, buildingId: BuildingIdSchema }),
  /** Walking: a path, the game time of departure, the speed in metres per game second, and what it is heading for. */
  z.strictObject({
    kind: z.literal('walking'),
    settlementId: SettlementIdSchema,
    path: StreetPathSchema,
    departAt: z.number(),
    speed: z.number().positive(),
    destination: AvatarDestinationSchema,
  }),
]);
export type AvatarState = z.infer<typeof AvatarStateSchema>;
export type AvatarWalk = Extract<AvatarState, { kind: 'walking' }>;

/** Where the avatar is at a moment: on a street, standing or walking, or in a building. */
export type AvatarPosition =
  | { kind: 'street'; segmentId: string; point: [number, number]; walking: boolean }
  | { kind: 'building'; buildingId: string };
