/**
 * A short fingerprint of a world AFMG made, to hold a generated world against without keeping its whole export:
 * cell counts, a hash of the heights, and the numbers of rivers and burgs.
 */
import { createHash } from 'node:crypto';

export interface Fingerprint {
  /** Cells of the raw grid and of the refined (packed) graph. */
  gridCells: number;
  packCells: number;
  /** SHA-256 of the heights, raw then refined, one byte a cell. */
  heights: string;
  rivers: number;
  /** Burgs that exist: not AFMG's empty first entry, nor removed ones. */
  burgs: number;
}

/** The fingerprint of an AFMG export (the object a `.json` export parses to). */
export function fingerprint(exported: any): Fingerprint {
  const gridHeights: number[] = exported.grid.cells.map((cell: { h: number }) => cell.h);
  const packHeights: number[] = exported.pack.cells.map((cell: { h: number }) => cell.h);
  return {
    gridCells: gridHeights.length,
    packCells: packHeights.length,
    heights: createHash('sha256').update(Uint8Array.from([...gridHeights, ...packHeights])).digest('hex'),
    rivers: exported.pack.rivers.length,
    burgs: exported.pack.burgs.filter((burg: { i?: number; removed?: boolean } | null) => burg?.i && !burg.removed).length,
  };
}
