/**
 * The launcher page's one DOM helper: an element with a class, attributes and
 * children. Text is always set as text (never HTML), so nothing a project, a log
 * line or a manifest says can become markup.
 */
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; attrs?: Record<string, string>; text?: string } = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  if (props.text !== undefined) node.textContent = props.text;
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Replace every child of `parent`. */
export function replaceChildren(parent: Element, children: readonly Child[]): void {
  parent.replaceChildren(...children.filter((child): child is Node | string => !!child));
}
