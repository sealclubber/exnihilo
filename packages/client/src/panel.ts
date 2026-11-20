import type { BriefText } from './brief.ts';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function showMessage(panel: HTMLElement, text: string, kind: 'hint' | 'error' = 'hint'): void {
  panel.replaceChildren(element('p', text, kind));
}

export function showBrief(panel: HTMLElement, brief: BriefText, onOpenCity: () => void): void {
  const open = element('button', 'Open city', 'open-city');
  open.type = 'button';
  open.title = 'Browse the residents, households and buildings of this settlement';
  open.addEventListener('click', onOpenCity);
  const nodes: HTMLElement[] = [element('h2', brief.title), element('p', brief.subtitle, 'subtitle'), open];
  for (const section of brief.sections) {
    nodes.push(element('h3', section.heading));
    if (section.rows) {
      const list = element('dl');
      for (const [label, value] of section.rows) list.append(element('dt', label), element('dd', value));
      nodes.push(list);
    }
    if (section.lines) {
      const list = element('ul');
      for (const line of section.lines) list.append(element('li', line));
      nodes.push(list);
    }
  }
  panel.replaceChildren(...nodes);
  panel.scrollTop = 0;
}
