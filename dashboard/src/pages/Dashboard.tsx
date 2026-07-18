import { Suspense } from 'react';
import { lazyWithRetry as lazy } from '../utils/lazyWithRetry';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, Webhook, Activity, ArrowUpRight, ArrowDownRight, AlertCircle } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  useSessionsQuery,
  useSessionStatsQuery,
  useWebhooksQuery,
  useStopSessionMutation,
  useStatsOverviewQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './Dashboard.css';

// recharts is heavy (~150kB gzip); load the analytics section on demand so it never bloats the
// main/login bundle and only ships when the dashboard actually renders.
const DashboardCharts = lazy(() => import('../components/DashboardCharts').then(m => ({ default: m.DashboardCharts })));

// Placeholder rows shown while the sessions query is in flight. Three is a guess at the common
// case; the point is to hold the table's shape, not to predict the count.
const SKELETON_ROWS = ['a', 'b', 'c'];
// One bar per column of the table's 5-column grid.
const SKELETON_CELLS = ['id', 'phone', 'status', 'active', 'actions'];

export function Dashboard() {
  const { t } = useTranslation();
  useDocumentTitle(t('dashboard.title'));
  const navigate = useNavigate();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const { data: stats } = useSessionStatsQuery();
  const { data: webhooks = [] } = useWebhooksQuery();
  // /stats/overview is ADMIN-only; for a non-admin key it 403s → overview stays undefined and the
  // message cards fall back to '—' without breaking the (un-gated) session cards.
  const { data: overview } = useStatsOverviewQuery();
  const stopMutation = useStopSessionMutation();
  const messagesToday = overview ? overview.messages.today.sent + overview.messages.today.received : '—';
  const totalMessages = overview ? overview.messages.sent + overview.messages.received : '—';
  const loading = loadingSessions;
  const error = sessionsError instanceof Error
    ? sessionsError.message
    : sessionsError
      ? t('dashboard.loadError')
      : null;
  const webhookCount = webhooks.length;

  const handleDisconnect = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }
  };

  const statsCards = [
    {
      label: t('dashboard.stats.activeSessions'),
      value: stats?.active ?? 0,
      icon: MessageSquare,
      trend: `+${stats?.ready ?? 0}`,
      trendUp: true,
    },
    { label: t('dashboard.stats.messagesToday'), value: messagesToday, icon: Send, trend: '0', trendUp: null },
    { label: t('dashboard.stats.webhooksConfigured'), value: webhookCount, icon: Webhook, trend: '0', trendUp: null },
    { label: t('dashboard.stats.totalMessages'), value: totalMessages, icon: Activity, trend: '0', trendUp: null },
  ];

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.hoursAgo', { count: Math.floor(diff / 3600000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  if (error) {
    return (
      <div className="dashboard">
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('dashboard.errorPrefix', { message: error })}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        badge={
          <span className={`status-badge ${stats && stats.ready > 0 ? 'connected' : 'disconnected'}`}>
            {stats && stats.ready > 0 ? t('common.connected') : t('common.disconnected')}
          </span>
        }
      />

      <div className="stats-grid">
        {statsCards.map(({ label, value, icon: Icon, trend, trendUp }) => (
          <div key={label} className="stat-card">
            <div className="stat-header">
              <span className="stat-label">{label}</span>
              <Icon size={20} className="stat-icon" />
            </div>
            <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
            {trend !== '0' && (
              <div className={`stat-trend ${trendUp ? 'up' : 'down'}`}>
                {trendUp ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {trend}
              </div>
            )}
          </div>
        ))}
      </div>

      <Suspense fallback={null}>
        <DashboardCharts />
      </Suspense>

      <section className="sessions-section">
        <div className="section-header">
          <h2>{t('dashboard.sessionsOverview')}</h2>
          <span className="section-subtitle">
            {t('dashboard.showingSessions', { shown: sessions.length, total: stats?.total ?? 0 })}
          </span>
        </div>

        <div className="sessions-table" aria-busy={loading}>
          <div className="table-header">
            <span>{t('dashboard.columns.sessionId')}</span>
            <span>{t('dashboard.columns.phone')}</span>
            <span>{t('dashboard.columns.status')}</span>
            <span>{t('dashboard.columns.lastActive')}</span>
            <span>{t('dashboard.columns.actions')}</span>
          </div>
          {/* Skeleton rows must precede the empty check: while the query is in flight `sessions` is
              [], so testing length first would flash "no sessions" before the real rows arrive. */}
          {loading ? (
            SKELETON_ROWS.map(row => (
              <div key={row} className="table-row table-row--skeleton" aria-hidden="true">
                {SKELETON_CELLS.map(cell => (
                  <span key={cell} className="skeleton-bar" />
                ))}
              </div>
            ))
          ) : sessions.length === 0 ? (
            <div className="table-row table-row--empty">{t('dashboard.noSessions')}</div>
          ) : (
            sessions.map(session => (
              <div key={session.id} className="table-row">
                <div className="session-info-cell">
                  <span className="session-id">{session.id.substring(0, 12)}</span>
                  <span className="session-name" title={session.name}>
                    {session.name}
                  </span>
                </div>
                <span className="phone">{session.phone || '—'}</span>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
                <span className="last-active">{formatLastActive(session.lastActive)}</span>
                <div className="actions">
                  <button className="btn-sm" onClick={() => navigate('/sessions')}>
                    {t('dashboard.view')}
                  </button>
                  {['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) && (
                    <button className="btn-sm danger" onClick={() => handleDisconnect(session.id)}>
                      {t('dashboard.disconnect')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
