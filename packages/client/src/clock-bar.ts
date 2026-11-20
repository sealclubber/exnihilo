/**
 * The clock on the page: the day and time, and the controls that ask the
 * server to run, pause, change the rate or jump.
 */
import type { Calendar, ClockState } from '@worldsim/core';
import { type ClockSync, clockFace, describeRate, nextTimeOfDay } from './clock.ts';
import { h } from './dom.ts';

const MIDDAY = 12 * 3600;

export interface ClockBarHandlers {
  /** Asks the server to change the clock. */
  change(action: 'run' | 'pause' | 'rate' | 'time', body?: object): Promise<ClockState>;
  /** Called after the clock has changed here or been heard to change. */
  changed(): void;
}

export interface ClockBar {
  element: HTMLElement;
  /** Gives the calendar, once the pack's names are known. */
  setCalendar(calendar: Calendar): void;
  /** Brings the buttons into line with the clock's state. */
  refresh(): void;
}

export function createClockBar(sync: ClockSync, handlers: ClockBarHandlers): ClockBar {
  const face = h('span', { class: 'clock-face' }, 'Clock not connected');
  const toggle = h('button', { attrs: { type: 'button' } }, 'Run');
  const rates = h('span', { class: 'clock-rates' });
  const jumps = h('span', { class: 'clock-jumps' });
  const problem = h('span', { class: 'error' });
  const element = h('div', { class: 'clock-bar' }, face, toggle, rates, jumps, problem);
  let calendar: Calendar | undefined;
  let shownRates = '';

  const ask = (action: 'run' | 'pause' | 'rate' | 'time', body?: object) => {
    handlers
      .change(action, body)
      .then((state) => {
        sync.apply(state);
        problem.textContent = '';
        refresh();
        handlers.changed();
      })
      .catch((error: Error) => (problem.textContent = error.message));
  };
  toggle.addEventListener('click', () => ask(sync.current?.running ? 'pause' : 'run'));

  const jump = (label: string, title: string, secondsOfDay: () => number | undefined) =>
    h(
      'button',
      {
        attrs: { type: 'button' },
        title,
        onClick: () => {
          const now = sync.now();
          const target = secondsOfDay();
          if (now !== undefined && target !== undefined) ask('time', { gameTime: nextTimeOfDay(now, target) });
        },
      },
      label,
    );
  jumps.append(
    jump('Morning', 'Jump to the next sunrise', () => calendar?.sunrise),
    jump('Midday', 'Jump to the next midday', () => MIDDAY),
    jump('Evening', 'Jump to the next sunset', () => calendar?.sunset),
  );

  function refresh(): void {
    const state = sync.current;
    element.classList.toggle('disconnected', !state);
    if (!state) return;
    toggle.textContent = state.running ? 'Pause' : 'Run';
    toggle.classList.toggle('active', state.running);
    const key = `${state.rates.join()}|${state.rate}`;
    if (key !== shownRates) {
      shownRates = key;
      rates.replaceChildren(
        ...state.rates.map((rate) => {
          const { label, title } = describeRate(rate);
          return h('button', { class: rate === state.rate ? 'active' : '', title, attrs: { type: 'button' }, onClick: () => ask('rate', { rate }) }, label);
        }),
      );
    }
  }

  // The time shown moves with the clock; a few updates a second is plenty for a display in minutes.
  setInterval(() => {
    const now = sync.now();
    if (now === undefined || !calendar) return;
    const shown = clockFace(now, calendar);
    face.textContent = `${shown.isLight ? '☀' : '☾'} ${shown.dayName}, day ${shown.day.toLocaleString('en-US')} · ${shown.time}${shown.isRestDay ? ' · rest day' : ''}`;
    face.classList.toggle('night', !shown.isLight);
  }, 200);

  return {
    element,
    setCalendar(next) {
      calendar = next;
    },
    refresh,
  };
}
