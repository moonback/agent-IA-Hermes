import {
  Bot,
  Brain,
  History,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Mic,
  Monitor,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { Page } from '../../store';

export interface NavItem {
  id: Page;
  label: string;
  icon: LucideIcon;
}

/** The real routes of the application, grouped for the sidebar. No placeholder entries. */
export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Pilotage',
    items: [
      { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
      { id: 'chat', label: 'Chat', icon: MessageSquare },
      { id: 'voice', label: 'Assistant vocal', icon: Mic },
      { id: 'missions', label: 'Missions', icon: ListChecks },
    ],
  },
  {
    title: 'Exécution',
    items: [
      { id: 'agents', label: 'Agents', icon: Bot },
      { id: 'computer', label: 'Ordinateur', icon: Monitor },
      { id: 'history', label: 'Historique et mémoire', icon: History },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { id: 'models', label: 'Modèles et OpenRouter', icon: Brain },
      { id: 'tools', label: 'Outils et permissions', icon: ShieldCheck },
      { id: 'settings', label: 'Paramètres', icon: Settings },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
export const navItem = (id: Page): NavItem => NAV_ITEMS.find((n) => n.id === id) ?? NAV_ITEMS[0]!;
