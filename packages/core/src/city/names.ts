/**
 * Personal names. The generator asks for names through this interface, so the
 * way they are made can be replaced without touching the pipeline.
 */
import type { SettlementBrief } from '../schema.ts';
import type { Sex } from './records.ts';
import type { Rng } from './random.ts';

export interface NameGenerator {
  givenName(rng: Rng, sex: Sex): string;
  familyName(rng: Rng): string;
}

/** Makes the name generator for one settlement. */
export type NameGeneratorFactory = (brief: SettlementBrief) => NameGenerator;

const START = '^';
const END = '$';
const ATTEMPTS = 6;

/**
 * The default: builds names letter by letter from the culture's name base,
 * each letter chosen by the two before it.
 *
 * Name bases are lists of place names, so these are placeholders that merely
 * sound right for the culture. Per-culture lists of personal names can
 * replace them later behind the same interface.
 */
export const nameBaseNames: NameGeneratorFactory = (brief) => {
  const base = brief.culture.nameBase;
  const words = base.sampleNames
    .flatMap((name) => name.toLowerCase().split(/[^\p{L}]+/u))
    .filter((word) => word.length >= 3);
  if (words.length === 0) throw new RangeError(`the name base "${base.name}" has no usable sample names`);

  const followers = new Map<string, string[]>();
  for (const word of words) {
    let context = START + START;
    for (const letter of [...word, END]) {
      let list = followers.get(context);
      if (!list) followers.set(context, (list = []));
      list.push(letter);
      context = context.charAt(1) + letter;
    }
  }

  const make = (rng: Rng, minLength: number, maxLength: number): string => {
    let name = '';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      name = '';
      let context = START + START;
      while (name.length < maxLength) {
        const options = followers.get(context) as string[];
        const letter = options[rng.int(0, options.length - 1)] as string;
        if (letter === END) break;
        name += letter;
        context = context.charAt(1) + letter;
      }
      if (name.length >= minLength) break;
    }
    if (name.length < 2) name = words[rng.int(0, words.length - 1)] as string;
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  // Given names are kept shorter than family names, within the name base's own limits.
  const shortest = Math.max(3, base.minLength - 2);
  return {
    givenName: (rng) => make(rng, shortest, Math.max(shortest, base.minLength + 1)),
    familyName: (rng) => make(rng, base.minLength, base.maxLength),
  };
};
