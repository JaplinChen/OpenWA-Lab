import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

export function EnvPinNote({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation();
  return pinned ? (
    <p className="env-pin-note">
      <AlertTriangle size={14} /> {t('infrastructure.envPinNote')}
    </p>
  ) : null;
}
