import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Smartphone, Webhook, ClipboardList, Send, Key, KeyRound, Server, Puzzle, Bot, MessageSquareText } from 'lucide-react';
import { type UserRole } from '../hooks/useRole';
import './Settings.css';

interface SettingsProps {
  userRole: UserRole | null;
}

const settingsNavItems = [
  { to: 'sessions', icon: Smartphone, key: 'sessions' as const, adminOnly: false },
  { to: 'webhooks', icon: Webhook, key: 'webhooks' as const, adminOnly: false },
  { to: 'templates', icon: ClipboardList, key: 'templates' as const, adminOnly: false },
  { to: 'message-tester', icon: Send, key: 'messageTester' as const, adminOnly: false },
  { to: 'llm', icon: Bot, key: 'llm' as const, adminOnly: true },
  { to: 'keyproxy', icon: KeyRound, key: 'keyproxy' as const, adminOnly: true },
  { to: 'translate-prompt', icon: MessageSquareText, key: 'translatePrompt' as const, adminOnly: true },
  { to: 'api-keys', icon: Key, key: 'apiKeys' as const, adminOnly: true },
  { to: 'infrastructure', icon: Server, key: 'infrastructure' as const, adminOnly: true },
  { to: 'plugins', icon: Puzzle, key: 'plugins' as const, adminOnly: true },
];

export function Settings({ userRole }: SettingsProps) {
  const { t } = useTranslation();
  const items = settingsNavItems.filter(item => !item.adminOnly || userRole === 'admin');

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <span className="settings-nav-title">{t('nav.settings')}</span>
        {items.map(({ to, icon: Icon, key }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `settings-nav-item ${isActive ? 'active' : ''}`}>
            <Icon size={18} />
            <span>{t(`nav.${key}`)}</span>
          </NavLink>
        ))}
      </nav>
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}

export default Settings;
