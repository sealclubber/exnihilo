import type { EntityKind } from './schema.ts';

/** Builds an entity ID such as `settlement-641`. */
export function makeId(kind: EntityKind, number: number): string {
  if (!Number.isInteger(number) || number < 0) {
    throw new RangeError(`cannot build a ${kind} ID from ${number}`);
  }
  return `${kind}-${number}`;
}

/** The number part of an entity ID. Throws if the ID is malformed. */
export function idNumber(id: string): number {
  const match = /^[a-z]+-(0|[1-9][0-9]*)$/.exec(id);
  if (!match) throw new RangeError(`malformed entity ID "${id}"`);
  return Number(match[1]);
}

/** Orders entities by the number in their ID. */
export function byIdNumber<T extends { id: string }>(a: T, b: T): number {
  return idNumber(a.id) - idNumber(b.id);
}
