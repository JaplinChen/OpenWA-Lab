import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, KeyRound, Trash2, Plus } from 'lucide-react';
import { keyProxyApi, type KeyStatus } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResizableCol } from '../hooks/useResizableCol';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import './KeyProxy.css';

// Providers the llm-key-proxy supports that make sense for free-tier rotation here.
const PROVIDERS = ['gemini', 'groq', 'openai', 'anthropic', 'mistral', 'openrouter', 'nvidia_nim'];

export function KeyProxy() {
  const { t } = useTranslation();
  useDocumentTitle(t('keyproxy.title'));
  const { canWrite } = useRole();
  const toast = useToast();
  const { ref: tableRef, startResize } = useResizableCol('keyproxy-cols');

  const RH = ({ col }: { col: string }) => (
    <span className="kp-resize-handle" aria-hidden="true" onMouseDown={startResize(col)} />
  );

  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState('');
  const [account, setAccount] = useState('');

  const fail = (err: unknown) =>
    toast.error(t('common.failed', { message: err instanceof Error ? err.message : 'unknown' }));

  useEffect(() => {
    let active = true;
    keyProxyApi
      .list()
      .then(list => active && setKeys(list))
      .catch(err => active && fail(err))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const add = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      setKeys(await keyProxyApi.add(provider, apiKey.trim(), account.trim()));
      setApiKey('');
      setAccount('');
      toast.success(t('keyproxy.added'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k: KeyStatus) => {
    setBusy(true);
    try {
      setKeys(await keyProxyApi.remove(k.provider, k.index));
      toast.success(t('keyproxy.removed'));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="etable-page etable-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="etable-page keyproxy-page">
      <PageHeader title={t('keyproxy.title')} subtitle={t('keyproxy.subtitle')} />

      <p className="keyproxy-note">{t('keyproxy.accountNote')}</p>

      {canWrite && (
        <div className="keyproxy-addbar">
          <select
            className="keyproxy-select"
            value={provider}
            onChange={e => setProvider(e.target.value)}
            disabled={busy}
            aria-label={t('keyproxy.provider')}
          >
            {PROVIDERS.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            className="keyproxy-input"
            type="password"
            autoComplete="off"
            placeholder={t('keyproxy.keyPlaceholder')}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && add()}
            disabled={busy}
          />
          <input
            className="keyproxy-account-input"
            type="text"
            autoComplete="off"
            placeholder={t('keyproxy.accountPlaceholder')}
            value={account}
            onChange={e => setAccount(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && add()}
            disabled={busy}
          />
          <button className="btn-primary" onClick={add} disabled={busy || !apiKey.trim()}>
            <Plus size={16} />
            {t('keyproxy.add')}
          </button>
        </div>
      )}

      <div className="etable-panel">
        <div className="etable-panel-title">{t('keyproxy.keys')}</div>
        {keys.length === 0 ? (
          <div className="keyproxy-empty">
            <KeyRound size={32} strokeWidth={1} />
            <span>{t('keyproxy.empty')}</span>
          </div>
        ) : (
          <table className="keyproxy-table" ref={tableRef as React.RefObject<HTMLTableElement>}>
            <colgroup>
              <col style={{ width: 'var(--col-provider, 8rem)' }} />
              <col style={{ width: 'var(--col-account, 9rem)' }} />
              <col style={{ width: 'var(--col-keycol, auto)' }} />
              <col style={{ width: 'var(--col-status, 7rem)' }} />
              <col style={{ width: 'var(--col-requests, 6rem)' }} />
              <col style={{ width: 'var(--col-failures, 6rem)' }} />
              {canWrite && <col style={{ width: '3rem' }} />}
            </colgroup>
            <thead>
              <tr>
                <th data-col="provider">{t('keyproxy.provider')}<RH col="provider" /></th>
                <th data-col="account">{t('keyproxy.account')}<RH col="account" /></th>
                <th data-col="keycol">{t('keyproxy.key')}<RH col="keycol" /></th>
                <th data-col="status">{t('keyproxy.status')}<RH col="status" /></th>
                <th className="keyproxy-num" data-col="requests">{t('keyproxy.requests')}<RH col="requests" /></th>
                <th className="keyproxy-num" data-col="failures">{t('keyproxy.failures')}<RH col="failures" /></th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={`${k.provider}-${k.index}`}>
                  <td>{k.provider}</td>
                  <td>{k.account || <span className="keyproxy-muted">—</span>}</td>
                  <td className="keyproxy-mono">{k.masked}</td>
                  <td>
                    <span className={`keyproxy-badge keyproxy-badge-${k.status}`}>{k.status}</span>
                  </td>
                  <td className="keyproxy-num">{k.requestCount}</td>
                  <td className="keyproxy-num">{k.failureCount}</td>
                  {canWrite && (
                    <td>
                      <button
                        className="keyproxy-del"
                        onClick={() => remove(k)}
                        disabled={busy}
                        aria-label={t('keyproxy.remove')}
                        title={t('keyproxy.remove')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default KeyProxy;
