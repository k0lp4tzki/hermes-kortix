import { ReactElement } from 'react';
import Settings from './pages/Settings';
import Platform from './pages/Platform';
import Home from './pages/Home';
import Inventory from './pages/Inventory';
import ResourcePage from './pages/Resource';
import Discovery from './pages/Discovery';

export type NavItem = { to: string; label: string; icon: string; count?: string } | '-';

export const NAV: NavItem[] = [
  { to: '/', label: 'Übersicht', icon: 'radar' },
  { to: '/inventory', label: 'Inventar', icon: 'list' },
  { to: '/discovery', label: 'Discovery', icon: 'inbox', count: 'discovery' },
  '-',
  { to: '/platform', label: 'Plattform', icon: 'cpu' },
  { to: '/settings', label: 'Einstellungen', icon: 'settings' },
];

export const ROUTES: Array<{ path: string; element: ReactElement }> = [
  { path: '/', element: <Home /> },
  { path: '/inventory', element: <Inventory /> },
  { path: '/resources/:id', element: <ResourcePage /> },
  { path: '/discovery', element: <Discovery /> },
  { path: '/platform', element: <Platform /> },
  { path: '/settings', element: <Settings /> },
];
