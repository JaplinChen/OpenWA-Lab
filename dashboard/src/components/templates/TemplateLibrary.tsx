import { useTranslation } from 'react-i18next';
import { FileText, Loader2, Plus, Search } from 'lucide-react';
import type { MessageTemplate } from '../../services/api';
import { extractPlaceholders } from './template-utils';

export function TemplateLibrary({
  templates,
  filteredTemplates,
  loading,
  canWrite,
  searchTerm,
  onSearchChange,
  selectedId,
  onNew,
  onSelect,
}: {
  templates: MessageTemplate[];
  filteredTemplates: MessageTemplate[];
  loading: boolean;
  canWrite: boolean;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  selectedId: string | null;
  onNew: () => void;
  onSelect: (template: MessageTemplate) => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="templates-library">
      <div className="templates-library-header">
        <div>
          <h2>{t('templates.savedTitle')}</h2>
          <span>{t('templates.count', { count: templates.length })}</span>
        </div>
        <button className="btn-primary templates-new-btn" onClick={onNew} disabled={!canWrite}>
          <Plus size={16} />
          {t('templates.newTemplate')}
        </button>
      </div>

      <div className="templates-search">
        <Search size={16} />
        <input
          value={searchTerm}
          onChange={event => onSearchChange(event.target.value)}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
        />
      </div>

      {loading ? (
        <div className="templates-loading-inline">
          <Loader2 className="animate-spin" size={24} />
        </div>
      ) : templates.length === 0 ? (
        <div className="templates-empty-list">
          <FileText size={40} strokeWidth={1} />
          <h3>{t('templates.empty.title')}</h3>
          <p>{t('templates.empty.description')}</p>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className="templates-empty-list compact">
          <Search size={32} strokeWidth={1.5} />
          <h3>{t('templates.empty.title')}</h3>
        </div>
      ) : (
        <div className="template-list" role="list">
          {filteredTemplates.map(template => {
            const templatePlaceholders = extractPlaceholders(template);
            const isSelected = selectedId === template.id;
            return (
              <button
                key={template.id}
                className={`template-list-item ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelect(template)}
                type="button"
              >
                <span className="template-list-title">{template.name}</span>
                <span className="template-list-body">{template.body}</span>
                <span className="template-list-meta">
                  {templatePlaceholders.length > 0
                    ? templatePlaceholders.map(key => `{{${key}}}`).join(' ')
                    : t('templates.noPlaceholders')}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
