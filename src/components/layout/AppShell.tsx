import type { ReactNode } from 'react';
import {
  Compass,
  Cpu,
  FolderKanban,
  HardDrive,
  LayoutDashboard,
  MessageSquare,
  RefreshCw,
  Settings,
} from 'lucide-react';
import type { AppBootstrapState, NavRoute } from '../../types/ipc';

interface AppShellProps {
  activeRoute: NavRoute;
  onNavigate: (route: NavRoute) => void;
  state: AppBootstrapState | null;
  loading: boolean;
  onRefresh: () => void;
  children: ReactNode;
}

const NAV_ITEMS: Array<{ id: NavRoute; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'discover', label: 'Discover Models', icon: Compass },
  { id: 'my-models', label: 'My Models', icon: FolderKanban },
  { id: 'run', label: 'Run Model', icon: MessageSquare },
  { id: 'hardware', label: 'Hardware', icon: Cpu },
  { id: 'storage', label: 'External Storage', icon: HardDrive },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  activeRoute,
  onNavigate,
  state,
  loading,
  onRefresh,
  children,
}: AppShellProps) {
  const driveLabel = state?.active_library
    ? `${state.active_library.label} (${state.library_connected ? 'Ready' : 'Disconnected'})`
    : 'No external drive configured';

  const ollamaBadge = state?.ollama.api_reachable
    ? `Ollama ${state.ollama.api_version ?? 'Online'}`
    : state?.ollama.installed
      ? 'Ollama Stopped'
      : 'Ollama Missing';

  return (
    <div className="mosaic-shell">
      <header className="mosaic-topbar">
        <div className="mosaic-brand">
          <Cpu size={20} color="#2878B8" aria-hidden="true" />
          <span>MOSAIC</span>
        </div>
        <div className="mosaic-topbar-meta">
          <span
            className={
              state?.library_connected ? 'mosaic-badge mosaic-badge-success' : 'mosaic-badge mosaic-badge-warn'
            }
          >
            <HardDrive size={12} aria-hidden="true" />
            <span>{driveLabel}</span>
          </span>
          <span
            className={
              state?.ollama.api_reachable ? 'mosaic-badge' : 'mosaic-badge mosaic-badge-warn'
            }
          >
            {ollamaBadge}
          </span>
          <button
            type="button"
            className="mosaic-button-secondary"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Rescan host hardware, external drives, and Ollama"
          >
            <RefreshCw size={15} aria-hidden="true" />
            <span>{loading ? 'Scanning...' : 'Rescan'}</span>
          </button>
        </div>
      </header>

      <div className="mosaic-body">
        <nav className="mosaic-sidebar" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="mosaic-nav-btn"
                aria-current={activeRoute === item.id ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <main className="mosaic-content">{children}</main>
      </div>

      <footer className="mosaic-statusbar" role="status" aria-live="polite">
        <span>
          {state?.library_connected
            ? `Model library: ${state.active_library?.directory_path}`
            : 'External model library required — internal disk fallback is disabled.'}
        </span>
        <span>
          {state?.analytics.available
            ? `Analytics v${state.analytics.service_version ?? '1.0'}`
            : 'Analytics degraded (core controls active)'}
        </span>
      </footer>
    </div>
  );
}
