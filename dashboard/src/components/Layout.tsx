import { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  MessageSquare,
  FileText,
  LogOut,
  Settings,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { type UserRole } from '../hooks/useRole';
import { resolveSupportedLanguage, rtlLanguages } from '../i18n';
import { healthApi } from '../services/api';
import { LanguageMenu } from './LanguageMenu';
import { AppearanceMenu } from './AppearanceMenu';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

const allNavItems = [
  { to: '/', icon: LayoutDashboard, key: 'dashboard' as const, adminOnly: false },
  { to: '/chats', icon: MessageSquare, key: 'chats' as const, adminOnly: false },
  { to: '/logs', icon: FileText, key: 'logs' as const, adminOnly: false },
  { to: '/settings', icon: Settings, key: 'settings' as const, adminOnly: false },
];

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();

  const navItems = allNavItems.filter(item => !item.adminOnly || userRole === 'admin');

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  // Show the build-time version immediately, then replace it with the live running version from the
  // backend so a stale-built bundle can't display the wrong number. Falls back silently on error.
  const [version, setVersion] = useState(__APP_VERSION__);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let active = true;
    healthApi
      .check()
      .then(info => {
        if (active && info?.version) setVersion(info.version);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <img src="/openwa_logo.webp" alt="OpenWA-Lab" className="sidebar-logo" />
            <span className="brand-name">{t('common.appName')}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <img src="/openwa_logo.webp" alt="OpenWA-Lab" className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{t('common.appName')}</span>
              <span className="brand-version">v{version}</span>
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={toggleCollapse}
            title={isCollapsed ? t('common.expand') : t('common.collapse')}
            aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
          >
            {isCollapsed ? (
              isRtl ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )
            ) : isRtl ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        )}

        <nav className="sidebar-nav">
          {navItems.map(({ to, icon: Icon, key }) => {
            const label = t(`nav.${key}`);
            return (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                end={to === '/'}
                onClick={handleNavClick}
                title={isCollapsed ? label : undefined}
              >
                <Icon size={20} />
                {!isCollapsed && <span>{label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <LanguageMenu />
          <AppearanceMenu />
          <button className="logout-btn icon-only" onClick={onLogout} title={t('common.logout')} aria-label={t('common.logout')}>
            <LogOut size={20} />
          </button>
        </div>
      </aside>

      <main className={`main-content ${isCollapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
