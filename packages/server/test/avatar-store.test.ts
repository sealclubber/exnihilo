/**
 * Phase 6D: an avatar stored under another layout is not restored. Its position names a segment or a building of
 * one layout, and means nothing in another.
 */
import { describe, expect, it } from 'vitest';
import { type AvatarState, LAYOUT_VERSION, parsePack } from '@worldsim/core';
import { medievalPack, rawMedievalPack } from '../../core/test/pack.ts';
import { AvatarKeeper, fromStore, toStore } from '../src/avatar.ts';

const pack = medievalPack();
const standing: AvatarState = { kind: 'standing', settlementId: 'settlement-641', segmentId: 'segment-641-000001', point: [10, 20] };

describe('the stored avatar', () => {
  it('is stored with the layout version and the generator it stands in, and restored under the same', () => {
    const stored = toStore(standing, pack);
    expect(stored).toEqual({ layoutVersion: LAYOUT_VERSION, generator: pack.layout.generator ?? 'grid', state: standing });
    expect(new AvatarKeeper({ stored: fromStore(JSON.parse(JSON.stringify(stored)), pack) }).read()).toEqual(standing);
  });

  it('is not restored from a store written under layout version 4, which kept the bare state', () => {
    // Before phase 6D the state was stored as it was, with nothing to say which layout it stood in.
    expect(fromStore(standing, pack)).toBeUndefined();
    expect(new AvatarKeeper({ stored: fromStore(standing, pack) }).read()).toBeUndefined();
    expect(fromStore({ layoutVersion: LAYOUT_VERSION - 1, generator: 'grid', state: standing }, pack)).toBeUndefined();
    expect(fromStore(undefined, pack)).toBeUndefined();
  });

  it('is not restored under another generator, whose segments are other segments', () => {
    const raw = rawMedievalPack();
    raw.layout.generator = (pack.layout.generator ?? 'grid') === 'grid' ? 'grown' : 'grid';
    expect(fromStore(toStore(standing, pack), parsePack(raw))).toBeUndefined();
  });
});
