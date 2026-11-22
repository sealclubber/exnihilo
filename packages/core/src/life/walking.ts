/**
 * How fast people walk, and how long a walk takes. Shared by residents' plans and outsiders'.
 */
import type { SettingPack, Species } from '../pack/schema.ts';

/** The walking speed of a person, in metres per second. */
export function walkingSpeed(person: { age: number; species: string }, pack: SettingPack): number {
  const bands = (pack.species[person.species] as Species).life.walkingSpeed;
  const band = bands.find((entry) => entry.upToAge === undefined || person.age <= entry.upToAge);
  return (band as (typeof bands)[number]).metresPerSecond;
}

/** How long a walk of a given length takes a person, in whole game seconds. */
export function tripDuration(length: number, speed: number): number {
  return Math.ceil(length / speed);
}
