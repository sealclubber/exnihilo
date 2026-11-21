/**
 * The avatar as the server keeps it: one state, or none until it is first
 * spawned. Besides the clock, it is the only stored state that is not
 * imported. Nothing here moves the avatar: its position at any game time is
 * worked out from the state by `core`.
 */
import { type AvatarState, AvatarStateSchema } from '@worldsim/core';

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
