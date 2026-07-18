import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createColumnHelper } from '@tanstack/react-table';
import { RefreshCw, Trash2, Eye, EyeOff } from 'lucide-react';
import type { ApiKey } from '../../services/api';

export type ConfirmAction = { type: 'delete' | 'revoke'; id: string; name: string };

const columnHelper = createColumnHelper<ApiKey>();

export function useApiKeyColumns({
  visibleKeys,
  toggleKeyVisibility,
  setConfirmAction,
}: {
  visibleKeys: Set<string>;
  toggleKeyVisibility: (id: string) => void;
  setConfirmAction: (action: ConfirmAction) => void;
}) {
  const { t } = useTranslation();
  return useMemo(
    () => [
      columnHelper.accessor('name', {
        header: () => t('apiKeys.columns.name'),
        cell: info => <span className="name-cell">{info.getValue()}</span>,
      }),
      columnHelper.accessor('keyPrefix', {
        id: 'key',
        header: () => t('apiKeys.columns.key'),
        cell: info => {
          const apiKey = info.row.original;
          return (
            <span className="key-cell">
              <code>{visibleKeys.has(apiKey.id) ? apiKey.keyPrefix + '...' : apiKey.keyPrefix + '****'}</code>
              <button
                className="icon-btn-sm"
                onClick={() => toggleKeyVisibility(apiKey.id)}
                aria-label={visibleKeys.has(apiKey.id) ? t('common.hideApiKey') : t('common.showApiKey')}
              >
                {visibleKeys.has(apiKey.id) ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
          );
        },
      }),
      columnHelper.accessor('role', {
        header: () => t('apiKeys.columns.role'),
        cell: info => <span className="permission-badge">{info.getValue()}</span>,
      }),
      columnHelper.accessor('isActive', {
        header: () => t('apiKeys.columns.status'),
        cell: info => (
          <span className={`status-badge ${info.getValue() ? 'active' : 'inactive'}`}>
            {info.getValue() ? t('apiKeys.statuses.active') : t('apiKeys.statuses.revoked')}
          </span>
        ),
      }),
      columnHelper.accessor('lastUsedAt', {
        id: 'lastUsed',
        header: () => t('apiKeys.columns.lastUsed'),
        cell: info => (
          <span className="last-used">
            {info.getValue() ? new Date(info.getValue()!).toLocaleDateString() : t('common.never')}
          </span>
        ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => t('apiKeys.columns.actions'),
        cell: info => {
          const apiKey = info.row.original;
          return (
            <span className="actions-cell">
              {/* No per-row copy: the full key only exists once (post-creation modal); the row
                  only has the prefix, so a copy button here could only copy a useless fragment. */}
              {apiKey.isActive && (
                <button
                  className="icon-btn"
                  onClick={() => setConfirmAction({ type: 'revoke', id: apiKey.id, name: apiKey.name })}
                  title={t('apiKeys.actions.revoke')}
                >
                  <RefreshCw size={16} />
                </button>
              )}
              <button
                className="icon-btn danger"
                onClick={() => setConfirmAction({ type: 'delete', id: apiKey.id, name: apiKey.name })}
                title={t('apiKeys.actions.delete')}
              >
                <Trash2 size={16} />
              </button>
            </span>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKeys, t],
  );
}
