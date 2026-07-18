import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Filter } from 'lucide-react';
import type { WebhookFilters, WebhookFilterCondition } from '../../services/api';

type TFn = ReturnType<typeof useTranslation>['t'];

// One-line, human-readable summary of a condition for the badge popover, reusing the FilterBuilder labels.
function conditionSummary(c: WebhookFilterCondition, t: TFn): string {
  const field = t(`webhooks.filters.fields.${c.field}`, { defaultValue: c.field });
  const operator = t(`webhooks.filters.operators.${c.operator}`, { defaultValue: c.operator });
  let value: string;
  if (typeof c.value === 'boolean') {
    value = c.value ? t('webhooks.filters.yes') : t('webhooks.filters.no');
  } else if (Array.isArray(c.value)) {
    value = c.value.join(', ');
  } else {
    value = `"${c.value}"`;
  }
  const caseNote = c.caseSensitive ? ` · ${t('webhooks.filters.caseSensitive')}` : '';
  return `${field} ${operator} ${value}${caseNote}`;
}

// Filters badge with a hover/focus popover listing the configured conditions. The popover is
// fixed-positioned from the badge's rect so the card's `overflow: hidden` doesn't clip it.
export function FilterBadge({ filters }: { filters: WebhookFilters }) {
  const { t } = useTranslation();
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 6, left: r.left });
  };
  const close = () => setCoords(null);

  return (
    <span
      className="filter-badge filter-badge-interactive"
      tabIndex={0}
      onMouseEnter={e => openAt(e.currentTarget)}
      onMouseLeave={close}
      onFocus={e => openAt(e.currentTarget)}
      onBlur={close}
    >
      <Filter size={12} />
      {t('webhooks.filters.badge', { count: filters.conditions.length })}
      {coords && (
        <div className="filter-popover" style={{ top: coords.top, left: coords.left }} role="tooltip">
          <div className="filter-popover-title">{t('webhooks.filters.title')}</div>
          {filters.conditions.map((condition, i) => (
            <div key={i} className="filter-popover-row">
              {conditionSummary(condition, t)}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
