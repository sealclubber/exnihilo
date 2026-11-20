/**
 * The world clock: a game time, a rate and whether it is running.
 *
 * The current game time is computed from an anchor, a real moment and the
 * game time at that moment, and the rate. Nothing ticks. Pausing, running,
 * changing the rate and setting the time all re-anchor, so game time never
 * jumps unless it is set.
 *
 * The real-time source is passed in, so tests can drive it.
 */
import type { ClockState } from '@worldsim/core';

export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

export interface ClockOptions {
  /** Real time in milliseconds. */
  now: () => number;
  /** The rates on offer, in game seconds per real second, and the one a new clock starts at. */
  rates: number[];
  defaultRate: number;
  /** A clock stored earlier. It is restored paused. */
  stored?: { gameTime: number; rate: number } | undefined;
  /** Called with what to store whenever the clock is paused, re-anchored or set, and when it is stopped. */
  save?: (clock: { gameTime: number; rate: number }) => void;
}

export class WorldClock {
  private readonly now: () => number;
  private readonly rates: number[];
  private readonly save: ((clock: { gameTime: number; rate: number }) => void) | undefined;
  private readonly listeners = new Set<(state: ClockState) => void>();
  private anchor: { real: number; game: number };
  private rate: number;
  private running = false;

  constructor(options: ClockOptions) {
    this.now = options.now;
    this.rates = [...options.rates];
    this.save = options.save;
    const stored = options.stored;
    // A stored rate the pack no longer offers falls back to the default.
    this.rate = stored && this.rates.includes(stored.rate) ? stored.rate : options.defaultRate;
    this.anchor = { real: this.now(), game: stored ? Math.max(0, stored.gameTime) : 0 };
  }

  private gameTime(): number {
    return this.running ? this.anchor.game + ((this.now() - this.anchor.real) / 1000) * this.rate : this.anchor.game;
  }

  read(): ClockState {
    return { gameTime: this.gameTime(), rate: this.rate, running: this.running, rates: [...this.rates] };
  }

  /** Fixes the present game time as the new starting point, stores it, and tells whoever is listening. */
  private reanchor(change: () => void): ClockState {
    this.anchor = { real: this.now(), game: this.gameTime() };
    change();
    this.store();
    const state = this.read();
    for (const listener of this.listeners) listener(state);
    return state;
  }

  private store(): void {
    this.save?.({ gameTime: Math.floor(this.gameTime()), rate: this.rate });
  }

  run(): ClockState {
    return this.reanchor(() => (this.running = true));
  }

  pause(): ClockState {
    return this.reanchor(() => (this.running = false));
  }

  setRate(rate: number): ClockState {
    if (!this.rates.includes(rate)) throw new ClockError(`the rate must be one of ${this.rates.join(', ')}`);
    return this.reanchor(() => (this.rate = rate));
  }

  /** Jumps to a game time, forward or back. Whether the clock is running does not change. */
  setTime(gameTime: number): ClockState {
    if (!Number.isFinite(gameTime) || gameTime < 0) throw new ClockError('the game time must be a number of seconds, zero or more');
    return this.reanchor(() => (this.anchor.game = gameTime));
  }

  /** Calls the listener after every change. Returns a function that stops it. */
  subscribe(listener: (state: ClockState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stores the clock as it stands, for shutdown. */
  stop(): void {
    this.store();
  }
}
