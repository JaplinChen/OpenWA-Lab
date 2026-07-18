import { useTranslation } from 'react-i18next';

export function TemplatePreview({
  preview,
  placeholders,
  previewValues,
  onValuesChange,
}: {
  preview: string;
  placeholders: string[];
  previewValues: Record<string, string>;
  onValuesChange: (values: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="template-preview">
      <div className="template-preview-header">
        <h2>{t('templates.previewTitle')}</h2>
        <span>{placeholders.length}</span>
      </div>
      <div className="template-preview-message">
        <pre>{preview || t('templates.previewEmpty')}</pre>
      </div>
      <div className="template-variable-panel">
        {placeholders.length > 0 ? (
          <div className="placeholder-list">
            {placeholders.map(key => (
              <label key={key}>
                <span>{`{{${key}}}`}</span>
                <input
                  value={previewValues[key] || ''}
                  onChange={event => onValuesChange({ ...previewValues, [key]: event.target.value })}
                  placeholder={t('templates.previewValuePlaceholder')}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="template-muted">{t('templates.noPlaceholders')}</p>
        )}
      </div>
    </aside>
  );
}
