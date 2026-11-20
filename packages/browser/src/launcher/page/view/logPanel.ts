/**
 * The log viewer: one service's output (or every service's), from a bounded
 * {@link LogBuffer}. Repaints at most once a frame, however fast lines arrive.
 */
import { formatLabel, type LauncherLabels } from '../../labels.js';
import { LogBuffer, type LogLine } from '../logBuffer.js';
import { el, replaceChildren } from './dom.js';

const ALL = '';

export function createLogPanel(labels: LauncherLabels) {
  const buffer = new LogBuffer();
  const select = el('select', { className: 'bf-select', attrs: { 'aria-label': labels.logs } });
  const dropped = el('p', { className: 'bf-note' });
  const output = el('pre', { className: 'bf-log', attrs: { tabindex: '0' } });
  const root = el('section', { className: 'bf-panel bf-logs', attrs: { 'aria-label': labels.logs } }, [
    el('div', { className: 'bf-panel-head' }, [el('h2', { text: labels.logs }), select]),
    dropped,
    output,
  ]);
  let serviceIds: string[] = [];
  let scheduled = false;

  const selected = () => (select.value === ALL ? undefined : select.value);

  function paint(): void {
    scheduled = false;
    const view = buffer.view(selected());
    const stick = output.scrollTop + output.clientHeight >= output.scrollHeight - 4;
    output.textContent = view.lines.length > 0 ? view.lines.map((line) => (selected() === undefined ? `[${line.serviceId}] ${line.text}` : line.text)).join('\n') : labels.noLogs;
    output.dataset.empty = String(view.lines.length === 0);
    dropped.textContent = view.dropped > 0 ? formatLabel(labels.logsDropped, { count: view.dropped }) : '';
    if (stick) output.scrollTop = output.scrollHeight;
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(paint);
  }

  select.addEventListener('change', schedule);
  schedule();

  return {
    root,
    setServices(ids: readonly string[]): void {
      if (ids.length === serviceIds.length && ids.every((id, i) => id === serviceIds[i])) return;
      const current = select.value;
      serviceIds = [...ids];
      replaceChildren(select, [
        el('option', { attrs: { value: ALL }, text: labels.logsAll }),
        ...serviceIds.map((id) => el('option', { attrs: { value: id }, text: id })),
      ]);
      select.value = serviceIds.includes(current) ? current : ALL;
    },
    show(serviceId: string): void {
      select.value = serviceIds.includes(serviceId) ? serviceId : ALL;
      schedule();
      root.scrollIntoView({ block: 'nearest' });
    },
    append(line: LogLine): void {
      buffer.push(line);
      const showing = selected();
      if (showing === undefined || showing === line.serviceId) schedule();
    },
  };
}

export type LogPanel = ReturnType<typeof createLogPanel>;
