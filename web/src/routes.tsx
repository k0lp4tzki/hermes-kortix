import { ReactElement } from 'react';
import Settings from './pages/Settings';
import Platform from './pages/Platform';
import Home from './pages/Home';

export type NavItem = { to: string; label: string; icon: string; count?: string } | '-';

export const NAV: NavItem[] = [
  { to: '/', label: 'Übersicht', icon: 'radar' },
  '-',
  { to: '/platform', label: 'Plattform', icon: 'cpu' },
  { to: '/settings', label: 'Einstellungen', icon: 'settings' },
];

export const ROUTES: Array<{ path: string; element: ReactElement }> = [
  { path: '/', element: <Home /> },
  { path: '/platform', element: <Platform /> },
  { path: '/settings', element: <Settings /> },
];
