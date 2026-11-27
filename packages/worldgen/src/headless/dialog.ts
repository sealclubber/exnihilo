/**
 * Stands in for AFMG's `ui/dialog/dialog.ts` in the bundle. With no page, a dialog has nowhere to open, and AFMG's
 * generator opens one only to tell the user what it has already written to the console: a world too cold or too
 * small for the cultures asked for ("Extreme climate warning", `model/society/cultures-generator.ts`). Every call
 * is accepted and does nothing; nothing a dialog does feeds the world.
 */
export const Dialog: Record<string, (...args: unknown[]) => undefined> = new Proxy(
  {},
  { get: () => () => undefined },
);
