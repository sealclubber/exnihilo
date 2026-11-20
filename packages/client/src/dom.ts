/** Small helpers for building DOM without a framework. Text is always set as text, never as HTML. */

type Child = Node | string | undefined | false;

interface Props {
  class?: string;
  title?: string;
  onClick?: (event: MouseEvent) => void;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.title) node.title = props.title;
  if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child !== undefined && child !== false) node.append(child);
  return node;
}

/** A button that looks like a link, for records that open other records. */
export function link(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  return h('button', { class: 'link', onClick, attrs: { type: 'button' }, ...(title !== undefined && { title }) }, text);
}
