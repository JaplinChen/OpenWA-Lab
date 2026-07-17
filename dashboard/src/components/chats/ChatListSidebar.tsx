import { Search, User, Users, Loader2 } from 'lucide-react';
import { type Session, type Chat } from '../../services/api';

interface ChatListSidebarProps {
  sessions: Session[];
  selectedSessionId: string;
  onSelectSession: (sessionId: string) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onlyTranslateGroups: boolean;
  onToggleTranslateGroups: (checked: boolean) => void;
  filteredChats: Chat[];
  activeChat: Chat | null;
  onSelectChat: (chat: Chat) => void;
  loadingChats: boolean;
  formatChatTime: (timestamp?: number) => string;
  formatLastMessageSnippet: (chat: Chat) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function ChatListSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
  searchQuery,
  onSearchChange,
  onlyTranslateGroups,
  onToggleTranslateGroups,
  filteredChats,
  activeChat,
  onSelectChat,
  loadingChats,
  formatChatTime,
  formatLastMessageSnippet,
  t,
}: ChatListSidebarProps) {
  return (
    <aside className="chats-sidebar">
      <div className="sidebar-header-box">
        {/* Session selector */}
        <div className="session-select-group">
          <label className="form-label">{t('chats.sessionLabel')}</label>
          <select
            value={selectedSessionId}
            onChange={e => onSelectSession(e.target.value)}
            className="session-selector"
          >
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.phone || t('chats.noPhone')})
              </option>
            ))}
          </select>
        </div>

        {/* Search bar */}
        <div className="chat-search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('chats.searchPlaceholder')}
            aria-label={t('chats.searchPlaceholder')}
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
          />
        </div>

        {/* Only show groups selected for translation */}
        <label className="chat-translate-filter">
          <input
            type="checkbox"
            checked={onlyTranslateGroups}
            onChange={e => onToggleTranslateGroups(e.target.checked)}
          />
          <span>{t('chats.onlyTranslateGroups', { defaultValue: '只顯示翻譯群組' })}</span>
        </label>
      </div>

      {/* Chat list */}
      <div className="chats-list">
        {loadingChats ? (
          <div className="chats-list-loading">
            <Loader2 className="animate-spin" size={24} />
            <span>{t('chats.loadingChats')}</span>
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="chats-list-empty">
            <span>{t('chats.empty')}</span>
          </div>
        ) : (
          filteredChats.map(chat => {
            const isActive = activeChat?.id === chat.id;
            return (
              <div
                key={chat.id}
                className={`chat-item-card ${isActive ? 'active' : ''}`}
                onClick={() => onSelectChat(chat)}
              >
                <div className="chat-avatar">
                  {chat.isGroup ? <Users size={20} /> : <User size={20} />}
                </div>

                <div className="chat-item-info">
                  <div className="chat-item-top">
                    <span className="chat-item-name" title={chat.name || chat.id}>
                      {chat.name || chat.id.split('@')[0]}
                    </span>
                    {chat.timestamp && (
                      <span className="chat-item-time">{formatChatTime(chat.timestamp)}</span>
                    )}
                  </div>
                  <div className="chat-item-bottom">
                    <span className="chat-item-snippet" title={formatLastMessageSnippet(chat)}>
                      {formatLastMessageSnippet(chat) || (
                        <span className="no-message">{t('chats.noMessageYet')}</span>
                      )}
                    </span>
                    {chat.unreadCount > 0 && (
                      <span className="chat-unread-badge">{chat.unreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
