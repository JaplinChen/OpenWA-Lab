import { useState, useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ToastProvider';
import { RoleProvider } from './hooks/RoleProvider';
import { useRole, type UserRole } from './hooks/useRole';
import { ErrorBoundary } from './components/ErrorBoundary';
import { API_BASE_URL } from './services/api';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Translate = lazy(() => import('./pages/Translate').then(m => ({ default: m.Translate })));
const Glossary = lazy(() => import('./pages/Glossary').then(m => ({ default: m.Glossary })));
const Senders = lazy(() => import('./pages/Senders').then(m => ({ default: m.Senders })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const LlmSettings = lazy(() => import('./pages/LlmSettings').then(m => ({ default: m.LlmSettings })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Plugins = lazy(() => import('./pages/Plugins'));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  // Initialize from sessionStorage to avoid setState in effect
  const savedKey = sessionStorage.getItem('openwalab_api_key');
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const { setRole, role } = useRole();

  const handleLogin = async (key: string) => {
    setApiKey(key);
    sessionStorage.setItem('openwalab_api_key', key);

    // Fetch the role from API
    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: { 'X-API-Key': key },
      });
      if (response.ok) {
        const data = await response.json();
        setRole(data.role as UserRole);
      }
    } catch {
      // Default to viewer if we can't fetch role
      setRole('viewer');
    }

    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    sessionStorage.removeItem('openwalab_api_key');
  };

  // Re-validate and get role on mount if already authenticated
  useEffect(() => {
    if (!savedKey) return;

    fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'X-API-Key': savedKey },
    })
      .then(res => res.json())
      .then(data => {
        if (data.valid && data.role) {
          setRole(data.role as UserRole);
        }
      })
      .catch(() => {
        // Keep existing role from localStorage if validation fails
      });
  }, [savedKey, setRole]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return <Suspense fallback={loadingFallback}><Login onLogin={handleLogin} /></Suspense>;
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
        <Routes>
          <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
            <Route index element={<Dashboard />} />
            <Route path="chats" element={<Chats />} />
            <Route path="translate" element={<Translate />} />
            <Route path="glossary" element={<Glossary />} />
            <Route path="senders" element={<Senders />} />
            <Route path="logs" element={<Logs />} />
            <Route path="settings" element={<Settings userRole={role} />}>
              <Route index element={<Navigate to="sessions" replace />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="templates" element={<Templates />} />
              <Route path="message-tester" element={<MessageTester />} />
              {role === 'admin' && <Route path="llm" element={<LlmSettings />} />}
              {role === 'admin' && <Route path="api-keys" element={<ApiKeys />} />}
              {role === 'admin' && <Route path="infrastructure" element={<Infrastructure />} />}
              {role === 'admin' && <Route path="plugins" element={<Plugins />} />}
            </Route>
            {/* Redirect legacy top-level routes into the Settings section */}
            <Route path="sessions" element={<Navigate to="/settings/sessions" replace />} />
            <Route path="webhooks" element={<Navigate to="/settings/webhooks" replace />} />
            <Route path="templates" element={<Navigate to="/settings/templates" replace />} />
            <Route path="settings/translate" element={<Navigate to="/translate" replace />} />
            <Route path="settings/glossary" element={<Navigate to="/glossary" replace />} />
            <Route path="message-tester" element={<Navigate to="/settings/message-tester" replace />} />
            <Route path="api-keys" element={<Navigate to="/settings/api-keys" replace />} />
            <Route path="infrastructure" element={<Navigate to="/settings/infrastructure" replace />} />
            <Route path="plugins" element={<Navigate to="/settings/plugins" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
