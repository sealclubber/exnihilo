/**
 * Collapsible panes. Every pane in the viewer has a header that folds it away
 * to one line, its title and a short summary, and unfolds it again. Each
 * pane's state is remembered across reloads, and one control folds or unfolds
 * them all.
 */
import { h } from './dom.ts';

const STORED_UNDER = 'worldsim.pane.';

export interface Pane {
  /** The pane: its header and, when unfolded, its body. */
  element: HTMLElement;
  setTitle(text: string): void;
  /** The few words shown beside the title when the pane is folded, such as a count. */
  setSummary(text: string): void;
  readonly collapsed: boolean;
  collapse(on: boolean): void;
}

const panes: Pane[] = [];
const controls: HTMLButtonElement[] = [];

/** Whether a pane was left folded, if the browser will say. */
function remembered(id: string): boolean {
  try {
    return localStorage.getItem(STORED_UNDER + id) === 'collapsed';
  } catch {
    return false;
  }
}

function remember(id: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(STORED_UNDER + id, 'collapsed');
    else localStorage.removeItem(STORED_UNDER + id);
  } catch {
    // Nowhere to remember it: the pane still folds for now.
  }
}

/** The words for the one control: it folds everything unless everything is folded already. */
export function foldAllLabel(collapsed: readonly boolean[]): string {
  return collapsed.length > 0 && collapsed.every(Boolean) ? 'Unfold all' : 'Fold all';
}

const refreshControls = () => {
  const label = foldAllLabel(panes.map((pane) => pane.collapsed));
  for (const control of controls) control.textContent = label;
};

/** The line a folded pane shows: its title and its summary. */
export function foldedLine(title: string, summary: string): string {
  return summary === '' ? title : `${title}: ${summary}`;
}

/**
 * Wraps a body in a pane. `id` names it for remembering its state; `kind` is
 * a class for its place on the page, such as a column or a panel over the map.
 */
export function createPane(id: string, title: string, body: HTMLElement, kind = ''): Pane {
  const mark = h('span', { class: 'pane-mark', attrs: { 'aria-hidden': 'true' } });
  const titleText = h('span', { class: 'pane-title' }, title);
  const summaryText = h('span', { class: 'pane-summary' });
  const head = h('button', { class: 'pane-head', attrs: { type: 'button' } }, mark, titleText, summaryText);
  body.classList.add('pane-body');
  const element = h('section', { class: `pane ${kind}`.trim(), attrs: { 'data-pane': id } }, head, body);
  let collapsed = false;
  let summary = '';
  const show = () => {
    element.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
    head.title = collapsed ? `Unfold: ${foldedLine(titleText.textContent ?? '', summary)}` : 'Fold this pane away';
    mark.textContent = collapsed ? '▸' : '▾';
    // The summary is the folded pane's one line; unfolded, the body says it all.
    summaryText.textContent = collapsed && summary !== '' ? `: ${summary}` : '';
  };
  const pane: Pane = {
    element,
    get collapsed() {
      return collapsed;
    },
    setTitle(text) {
      titleText.textContent = text;
      show();
    },
    setSummary(text) {
      if (text === summary) return;
      summary = text;
      show();
    },
    collapse(on) {
      collapsed = on;
      remember(id, on);
      show();
      refreshControls();
      // The map takes up the room a folded pane gives up, and gives it back.
      window.dispatchEvent(new Event('resize'));
    },
  };
  head.addEventListener('click', () => pane.collapse(!collapsed));
  collapsed = remembered(id);
  show();
  panes.push(pane);
  refreshControls();
  return pane;
}

/** The one control that folds every pane away, or unfolds them all. */
export function createFoldAll(): HTMLButtonElement {
  const control = h('button', { class: 'fold-all', attrs: { type: 'button' }, title: 'Fold every pane away, or unfold them all' });
  control.addEventListener('click', () => {
    const fold = !panes.every((pane) => pane.collapsed);
    for (const pane of panes) pane.collapse(fold);
  });
  controls.push(control);
  refreshControls();
  return control;
}
