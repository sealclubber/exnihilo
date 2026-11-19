/**
 * Checked access to the raw AFMG export. Every read names the entity and the
 * field, so a missing or mistyped value stops the import with a useful message.
 */

export class AfmgImportError extends Error {
  readonly entity: string;
  readonly field: string;

  constructor(entity: string, field: string, problem: string) {
    super(`${entity}: field "${field}" ${problem}`);
    this.name = 'AfmgImportError';
    this.entity = entity;
    this.field = field;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `the ${typeof value} ${JSON.stringify(value)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One object from the export, with the label used in error messages. */
export class Rec {
  readonly entity: string;
  private readonly raw: Record<string, unknown>;
  private readonly prefix: string;

  constructor(raw: Record<string, unknown>, entity: string, prefix = '') {
    this.raw = raw;
    this.entity = entity;
    this.prefix = prefix;
  }

  /** Builds the error for a problem with one of this object's fields. */
  error(field: string, problem: string): AfmgImportError {
    return new AfmgImportError(this.entity, this.prefix + field, problem);
  }

  private fail(field: string, problem: string): never {
    throw this.error(field, problem);
  }

  /** True when the key is present with a value other than null. */
  has(field: string): boolean {
    return this.raw[field] !== undefined && this.raw[field] !== null;
  }

  keys(): string[] {
    return Object.keys(this.raw);
  }

  private required(field: string): unknown {
    const value = this.raw[field];
    if (value === undefined) this.fail(field, 'is missing');
    return value;
  }

  number(field: string): number {
    const value = this.required(field);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(field, `must be a number, but is ${describe(value)}`);
    }
    return value;
  }

  integer(field: string): number {
    const value = this.number(field);
    if (!Number.isInteger(value)) this.fail(field, `must be a whole number, but is ${value}`);
    return value;
  }

  string(field: string): string {
    const value = this.required(field);
    if (typeof value !== 'string') this.fail(field, `must be text, but is ${describe(value)}`);
    if (value === '') this.fail(field, 'must not be empty');
    return value;
  }

  /** Absent when the key is missing, null or an empty string. */
  optionalString(field: string): string | undefined {
    if (!this.has(field) || this.raw[field] === '') return undefined;
    return this.string(field);
  }

  optionalInteger(field: string): number | undefined {
    return this.has(field) ? this.integer(field) : undefined;
  }

  /** A 0/1 or true/false flag. An optional flag is false when the key is missing. */
  flag(field: string, presence: 'required' | 'optional'): boolean {
    if (presence === 'optional' && this.raw[field] === undefined) return false;
    const value = this.required(field);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    return this.fail(field, `must be a number or true/false, but is ${describe(value)}`);
  }

  array(field: string): unknown[] {
    const value = this.required(field);
    if (!Array.isArray(value)) this.fail(field, `must be a list, but is ${describe(value)}`);
    return value;
  }

  integers(field: string): number[] {
    return this.array(field).map((value, index) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        this.fail(`${field}[${index}]`, `must be a whole number, but is ${describe(value)}`);
      }
      return value;
    });
  }

  /** A pair of numbers such as a position. */
  point(field: string): [number, number] {
    const value = this.array(field);
    const [x, y] = value;
    if (value.length < 2 || typeof x !== 'number' || typeof y !== 'number') {
      this.fail(field, 'must be a pair of numbers');
    }
    return [x, y];
  }

  record(field: string): Rec {
    const value = this.required(field);
    if (!isPlainObject(value)) this.fail(field, `must be an object, but is ${describe(value)}`);
    return new Rec(value, this.entity, `${this.prefix}${field}.`);
  }

  /** A list of nested objects. */
  records(field: string): Rec[] {
    return this.array(field).map((value, index) => {
      if (!isPlainObject(value)) {
        this.fail(`${field}[${index}]`, `must be an object, but is ${describe(value)}`);
      }
      return new Rec(value, this.entity, `${this.prefix}${field}[${index}].`);
    });
  }

  /** The key/value pairs of a nested object whose values are whole numbers. */
  integerEntries(field: string): Array<[string, number]> {
    const nested = this.record(field);
    return nested.keys().map((key) => [key, nested.integer(key)]);
  }

  /**
   * A list of entities, each an object with a whole-number `i`. A leading
   * number 0 is AFMG's placeholder for "none" and is skipped when allowed.
   */
  entities(field: string, label: string, options: { zeroPlaceholder?: boolean } = {}): Entity[] {
    const seen = new Set<number>();
    const result: Entity[] = [];
    this.array(field).forEach((value, index) => {
      if (options.zeroPlaceholder && index === 0 && value === 0) return;
      const where = `${this.prefix}${field}[${index}]`;
      if (!isPlainObject(value)) {
        throw new AfmgImportError(`${label} at ${where}`, 'i', `cannot be read: the entry is ${describe(value)}`);
      }
      const number = new Rec(value, `${label} at ${where}`).integer('i');
      if (number < 0) throw new AfmgImportError(`${label} at ${where}`, 'i', 'must not be negative');
      if (seen.has(number)) throw new AfmgImportError(`${label} ${number}`, 'i', 'is used by more than one entry');
      seen.add(number);
      result.push({ number, rec: new Rec(value, `${label} ${number}`) });
    });
    return result.sort((a, b) => a.number - b.number);
  }
}

export interface Entity {
  /** AFMG's own number for the entity, its `i`. */
  number: number;
  rec: Rec;
}

export function rootRecord(value: unknown): Rec {
  if (!isPlainObject(value)) {
    throw new AfmgImportError('export', '(root)', `must be an object, but is ${describe(value)}`);
  }
  return new Rec(value, 'export');
}
