import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import type { Session } from '../../services/api';

interface CreateSessionModalProps {
  sessions: Session[];
  onCreate: (name: string) => Promise<boolean>;
  onClose: () => void;
}

export function CreateSessionModal({ sessions, onCreate, onClose }: CreateSessionModalProps) {
  const { t } = useTranslation();
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    try {
      setCreating(true);
      const ok = await onCreate(newSessionName);
      if (ok) {
        setNewSessionName('');
        onClose();
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('sessions.create.title')}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">
          <label>{t('sessions.create.label')}</label>
          <input
            type="text"
            placeholder={t('sessions.create.placeholder')}
            value={newSessionName}
            onChange={e => {
              const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
              setNewSessionName(value);
            }}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <p className="input-hint">
            <Trans i18nKey="sessions.create.hint" components={{ code: <code /> }} />
          </p>
          {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
            <p className="input-error">{t('sessions.create.invalidChars')}</p>
          )}
          {newSessionName && newSessionName.length > 50 && (
            <p className="input-error">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
          )}
          {newSessionName &&
            /^[a-z0-9-]+$/.test(newSessionName) &&
            newSessionName.length <= 50 &&
            sessions.some(s => s.name === newSessionName) && (
              <p className="input-error">{t('sessions.create.duplicate')}</p>
            )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={handleCreate}
            disabled={
              creating ||
              !newSessionName.trim() ||
              !/^[a-z0-9-]+$/.test(newSessionName) ||
              newSessionName.length > 50 ||
              sessions.some(s => s.name === newSessionName)
            }
          >
            {creating ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
