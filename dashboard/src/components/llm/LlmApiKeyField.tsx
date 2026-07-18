import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, Eye, EyeOff, ExternalLink } from 'lucide-react';
import type { ProviderMeta } from './providerMeta';

interface Props {
  meta: ProviderMeta;
  apiKey: string;
  canWrite: boolean;
  showKey: boolean;
  toggleShowKey: () => void;
  onChange: (v: string) => void;
  testing: boolean;
  onTest: () => void;
  statusBadge: ReactNode;
}

export function LlmApiKeyField({
  meta,
  apiKey,
  canWrite,
  showKey,
  toggleShowKey,
  onChange,
  testing,
  onTest,
  statusBadge,
}: Props) {
  const { t } = useTranslation();
  const apiKeyFieldId = useId();

  return (
    <div className="form-group">
      <div className="llm-label-row">
        <label htmlFor={apiKeyFieldId}>{t('llm.apiKey')}</label>
        {meta.apiKeyUrl && (
          <a className="llm-apply-link" href={meta.apiKeyUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            {t('llm.apiKeyApply')}
          </a>
        )}
      </div>
      <div className="llm-row">
        <div className="llm-key-input">
          <input
            id={apiKeyFieldId}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            disabled={!canWrite}
            autoComplete="off"
            onChange={e => onChange(e.target.value)}
          />
          <button className="llm-eye" onClick={toggleShowKey} type="button" tabIndex={-1}>
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <button className="btn-secondary" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {t('llm.verify')}
        </button>
      </div>
      {!meta.showEndpoint && statusBadge}
    </div>
  );
}
