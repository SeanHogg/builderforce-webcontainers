/** Issues and declines: the plan's summary, then every issue and decline with its reason. */
import type { LauncherLabels } from '../../labels.js';
import type { PlanMessage, PlanSeverity } from '../launchPlan.js';
import { el, replaceChildren } from './dom.js';

export function createProblemsPanel(labels: LauncherLabels) {
  const summary = el('p', { className: 'bf-summary', attrs: { hidden: '' } });
  const list = el('ul', { className: 'bf-problems' });
  const root = el('section', { className: 'bf-panel', attrs: { 'aria-label': labels.problems } }, [el('h2', { text: labels.problems }), summary, list]);
  const messages: PlanMessage[] = [];

  const severityLabel: Record<PlanSeverity, string> = { error: labels.severityError, warning: labels.severityWarning, info: labels.severityInfo };

  function render(): void {
    replaceChildren(
      list,
      messages.length === 0
        ? [el('li', { className: 'bf-empty', text: labels.noProblems })]
        : messages.map((message) =>
            el('li', { className: `bf-problem bf-problem-${message.severity}` }, [
              el('span', { className: 'bf-chip', text: message.kind === 'declined' ? labels.declined : severityLabel[message.severity] }),
              message.subject && el('code', { text: message.subject }),
              el('span', { text: message.text }),
            ]),
          ),
    );
  }
  render();

  return {
    root,
    /** The summary (when shown) and every issue and decline, in order. */
    snapshot(): { summary?: string; messages: readonly PlanMessage[] } {
      return summary.hidden || !summary.textContent ? { messages: [...messages] } : { summary: summary.textContent, messages: [...messages] };
    },
    setSummary(text: string | undefined): void {
      summary.textContent = text ?? '';
      summary.hidden = !text;
    },
    add(...more: PlanMessage[]): void {
      messages.push(...more);
      render();
    },
  };
}

export type ProblemsPanel = ReturnType<typeof createProblemsPanel>;
