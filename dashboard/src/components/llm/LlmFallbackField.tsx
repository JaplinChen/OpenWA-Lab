import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';

interface Props {
  canWrite: boolean;
  models: string[];
  fallbackModels: string[];
  fallbackInput: string;
  setFallbackInput: (v: string) => void;
  addFallback: () => void;
  removeFallback: (m: string) => void;
}

export function LlmFallbackField({
  canWrite,
  models,
  fallbackModels,
  fallbackInput,
  setFallbackInput,
  addFallback,
  removeFallback,
}: Props) {
  const { t } = useTranslation();
  const fallbackFieldId = useId();

  return (
    <div className="form-group">
      <label htmlFor={fallbackFieldId}>{t('llm.fallbackModels')}</label>
      <span className="llm-hint">{t('llm.fallbackHint')}</span>
      {canWrite && (
        <div className="llm-row">
          {models.length > 0 ? (
            <select id={fallbackFieldId} value={fallbackInput} onChange={e => setFallbackInput(e.target.value)}>
              <option value="">{t('llm.fallbackPlaceholder')}</option>
              {models.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={fallbackFieldId}
              type="text"
              value={fallbackInput}
              placeholder={t('llm.fallbackPlaceholder')}
              onChange={e => setFallbackInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addFallback())}
            />
          )}
          <button className="btn-secondary" onClick={addFallback} disabled={!fallbackInput.trim()}>
            <Plus size={16} />
            {t('llm.add')}
          </button>
        </div>
      )}
      <ul className="llm-fallback-list">
        {fallbackModels.map(m => (
          <li key={m}>
            <span>{m}</span>
            {canWrite && (
              <button className="llm-fallback-del" onClick={() => removeFallback(m)} title={t('llm.add')}>
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
