import { useState, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, QrCode, Search, Filter, AlertCircle } from 'lucide-react';
import type { Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsController } from '../hooks/useSessionsController';
import { useQrPairing } from '../hooks/useQrPairing';
import { PageHeader } from '../components/PageHeader';
import { PageLoader } from '../components/PageLoader';
import { EmptyState } from '../components/EmptyState';
import { CustomSelect } from '../components/CustomSelect';
import { QrPairingModal } from '../components/sessions/QrPairingModal';
import { CreateSessionModal } from '../components/sessions/CreateSessionModal';
import { SessionDetailsModal } from '../components/sessions/SessionDetailsModal';
import { ConfirmModal } from '../components/sessions/ConfirmModal';
import { SessionCard } from '../components/sessions/SessionCard';
import './Sessions.css';

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const { canWrite } = useRole();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);

  // Ref bridge: the controller needs the QR hook's callbacks (show / close-on-stop), while the QR hook
  // needs the controller's sessions state — resolve the cycle with stable refs updated each render.
  const showQrRef = useRef<(id: string) => void>(() => {});
  const closeQrRef = useRef<(id: string) => void>(() => {});
  const controller = useSessionsController({
    showQr: useCallback((id: string) => showQrRef.current(id), []),
    onSessionStopped: useCallback((id: string) => closeQrRef.current(id), []),
  });
  const { sessions, loading, error, sessionsRef, fetchSessions } = controller;
  const qr = useQrPairing({ sessions, sessionsRef, fetchSessions });
  showQrRef.current = qr.handleShowQR;
  closeQrRef.current = qr.closeForSession;

  const filteredSessions = sessions.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && s.status === 'ready') ||
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected'].includes(s.status)) ||
      (statusFilter === 'connecting' && ['initializing', 'connecting', 'qr_ready'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return <PageLoader className="sessions-page" />;
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('sessions.newSession')}
            </button>
          )
        }
      />

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('sessions.searchPlaceholder')}
            aria-label={t('sessions.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <CustomSelect
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: t('sessions.filter.all') },
              { value: 'active', label: t('sessions.filter.active') },
              { value: 'inactive', label: t('sessions.filter.inactive') },
              { value: 'connecting', label: t('sessions.filter.connecting') },
            ]}
          />
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{error}</span>
        </div>
      )}

      {showCreateModal && (
        <CreateSessionModal
          sessions={sessions}
          onCreate={controller.handleCreate}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      <QrPairingModal qr={qr} />

      {selectedSession && (
        <SessionDetailsModal session={selectedSession} onClose={() => setSelectedSession(null)} />
      )}

      {deleteConfirmId && (
        <ConfirmModal
          title={t('sessions.delete.title')}
          message={
            <Trans
              i18nKey="sessions.delete.message"
              values={{ name: sessions.find(s => s.id === deleteConfirmId)?.name }}
              components={{ strong: <strong /> }}
            />
          }
          warning={t('sessions.delete.warning')}
          confirmLabel={t('common.delete')}
          onConfirm={() => {
            void controller.handleDelete(deleteConfirmId).finally(() => setDeleteConfirmId(null));
          }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}

      {killConfirmId && (
        <ConfirmModal
          title={t('sessions.forceKill.title')}
          message={
            <Trans
              i18nKey="sessions.forceKill.message"
              values={{ name: sessions.find(s => s.id === killConfirmId)?.name }}
              components={{ strong: <strong /> }}
            />
          }
          warning={t('sessions.forceKill.warning')}
          confirmLabel={t('sessions.forceKill.confirm')}
          onConfirm={() => {
            void controller.handleForceKill(killConfirmId).finally(() => setKillConfirmId(null));
          }}
          onCancel={() => setKillConfirmId(null)}
        />
      )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <EmptyState
            icon={<QrCode size={48} />}
            title={t('sessions.empty.title')}
            description={t('sessions.empty.description')}
          />
        ) : (
          filteredSessions.map(session => (
            <SessionCard
              key={session.id}
              session={session}
              canWrite={canWrite}
              onView={setSelectedSession}
              onShowQR={qr.handleShowQR}
              onStart={controller.handleStart}
              onStop={controller.handleStop}
              onDelete={setDeleteConfirmId}
              onKill={setKillConfirmId}
            />
          ))
        )}
      </div>
    </div>
  );
}
