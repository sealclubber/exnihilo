/**
 * The avatar as the server keeps it: one state, or none until it is first
 * spawned. Besides the clock, it is the only stored state that is not
 * imported. Nothing here moves the avatar: its position at any game time is
 * worked out from the state by `core`.
 */
import { type AvatarState, type SettingPack, AvatarStateSchema, LAYOUT_VERSION } from '@worldsim/core';

export interface AvatarKeeperOptions {
  /** What was stored earlier, as it was read back. Anything that is not a sound state is ignored. */
  stored?: unknown;
  /** Called with the new state whenever it changes. */
  save?: (state: AvatarState) => void;
}

export class AvatarKeeper {
  private state: AvatarState | undefined;
  private readonly save: ((state: AvatarState) => void) | undefined;
  private readonly listeners = new Set<(state: AvatarState) => void>();

  constructor(options: AvatarKeeperOptions = {}) {
    this.save = options.save;
    const stored = AvatarStateSchema.safeParse(options.stored);
    if (stored.success) this.state = stored.data;
  }

  /** The avatar's state; nothing until it has been spawned. */
  read(): AvatarState | undefined {
    return this.state;
  }

  /** Takes a new state, stores it, and tells whoever is listening. */
  set(state: AvatarState): AvatarState {
    this.state = state;
    this.save?.(state);
    for (const listener of this.listeners) listener(state);
    return state;
  }

  /** Calls the listener after every change. Returns a function that stops it. */
  subscribe(listener: (state: AvatarState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * What the avatar's state is stored with: the layout it stands in. A stored position names a segment or a
 * building of one layout, and means nothing in another, so an avatar stored under another layout version or
 * another generator is not restored: there is none until it is spawned again.
 */
export interface StoredAvatar {
  layoutVersion: number;
  generator: string;
  state: AvatarState;
}

const generatorOf = (pack: SettingPack) => pack.layout.generator ?? 'grid';

/** The avatar's state as it is written to the store. */
export function toStore(state: AvatarState, pack: SettingPack): StoredAvatar {
  return { layoutVersion: LAYOUT_VERSION, generator: generatorOf(pack), state };
}

/** The state to restore from what the store held: nothing if it was stored under another layout, or without one. */
export function fromStore(stored: unknown, pack: SettingPack): unknown {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { layoutVersion, generator, state } = stored as Partial<StoredAvatar>;
  return layoutVersion === LAYOUT_VERSION && generator === generatorOf(pack) ? state : undefined;
}
