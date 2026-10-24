import { useEffect } from 'react';
import { useApp, type Page } from './store';
import { usePrefs } from './prefs';
import { applyTheme } from './theme';
import { AppShell } from './components/layout/AppShell';
import { DashboardPage } from './pages/Dashboard';
import { ChatPage } from './pages/Chat';
import { MissionsPage } from './pages/Missions';
import { ComputerPage } from './pages/Computer';
import { AgentsPage } from './pages/Agents';
import { ModelsPage } from './pages/Models';
import { ToolsPage } from './pages/Tools';
import { HistoryPage } from './pages/History';
import { SettingsPage } from './pages/Settings';

const PAGES: Record<Page, () => React.JSX.Element> = {
  dashboard: DashboardPage,
  chat: ChatPage,
  missions: MissionsPage,
  computer: ComputerPage,
  agents: AgentsPage,
  models: ModelsPage,
  tools: ToolsPage,
  history: HistoryPage,
  settings: SettingsPage,
};

export function App() {
  const page = useApp((s) => s.page);
  const start = useApp((s) => s.start);
  const theme = usePrefs((s) => s.theme);
  const reducedTransparency = usePrefs((s) => s.reducedTransparency);
  useEffect(() => start(), [start]);
  // public/theme-boot.js already applied the saved theme before the first paint; this keeps it in sync.
  useEffect(() => applyTheme(document.documentElement, theme), [theme]);
  useEffect(() => {
    if (reducedTransparency) document.documentElement.dataset.transparency = 'reduced';
    else delete document.documentElement.dataset.transparency;
  }, [reducedTransparency]);
  const Current = PAGES[page];

  return (
    <AppShell>
      <Current />
    </AppShell>
  );
}
