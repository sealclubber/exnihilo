/**
 * Outsiders: the people in a town who do not live there. Travellers come by
 * the roads and the sea and leave again; vagrants live on the streets.
 *
 * Neither is a resident. They belong to no household, hold no job, and are
 * not in the city's people or its counts. Nothing about them is stored: a
 * traveller's whole visit is derived from the settlement, the day the party
 * arrived and a seed, and the vagrants are a fixed set derived from the
 * settlement and a seed.
 */
import { z } from 'zod';
import { BuildingIdSchema } from '../city/records.ts';
import { ExitIdSchema } from '../layout/records.ts';
import { PartyIdSchema, TravellerIdSchema, VagrantIdSchema } from '../life/records.ts';
import { SexSchema } from '../pack/schema.ts';
import { RouteIdSchema, RouteKindSchema, RouteLeadSchema } from '../schema.ts';

const text = z.string().min(1);
const count = z.int().nonnegative();

/**
 * Where a traveller comes from or goes on to: a route of the brief, and the settlement that route leads to
 * from here. Where the brief names no settlement, it is the route itself.
 */
export const RouteEndSchema = z.strictObject({
  routeId: RouteIdSchema,
  routeName: text.optional(),
  routeKind: RouteKindSchema,
  settlement: RouteLeadSchema.optional(),
});
export type RouteEnd = z.infer<typeof RouteEndSchema>;

/** Entering or leaving town: the game time, and the exit of the layout. */
export const PassageSchema = z.strictObject({ time: z.number(), exitId: ExitIdSchema });
export type Passage = z.infer<typeof PassageSchema>;

const whoTheyAre = {
  givenName: text,
  familyName: text,
  age: count,
  sex: SexSchema,
  species: text,
};

export const TravellerSchema = z.strictObject({
  group: z.literal('traveller'),
  id: TravellerIdSchema,
  /** A kind from the pack's travellers file. */
  kindId: text,
  partyId: PartyIdSchema,
  ...whoTheyAre,
  origin: RouteEndSchema,
  /** The route they leave by, and where it leads. */
  destination: RouteEndSchema,
  arrival: PassageSchema,
  departure: PassageSchema,
  /** Where they lodge; absent for someone who does not stay the night. */
  lodgingId: BuildingIdSchema.optional(),
});
export type Traveller = z.infer<typeof TravellerSchema>;

export const VagrantSchema = z.strictObject({
  group: z.literal('vagrant'),
  id: VagrantIdSchema,
  ...whoTheyAre,
});
export type Vagrant = z.infer<typeof VagrantSchema>;

export const OutsiderSchema = z.discriminatedUnion('group', [TravellerSchema, VagrantSchema]);
export type Outsider = z.infer<typeof OutsiderSchema>;

/** People who arrive together, keep together and leave together: they share one plan. */
export const PartySchema = z.strictObject({
  id: PartyIdSchema,
  kindId: text,
  arrivalDay: z.int(),
  /** How many nights the party stays. */
  nights: count,
  memberIds: z.array(TravellerIdSchema).min(1),
  origin: RouteEndSchema,
  destination: RouteEndSchema,
  arrival: PassageSchema,
  departure: PassageSchema,
  lodgingId: BuildingIdSchema.optional(),
});
export type Party = z.infer<typeof PartySchema>;
