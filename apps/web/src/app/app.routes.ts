import { Routes } from '@angular/router';
import { adminGuard } from './pages/admin/admin.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
  },
  {
    path: 'search',
    loadComponent: () => import('./pages/search/search').then((m) => m.SearchPage),
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
  },
  {
    path: 'assistant',
    loadComponent: () => import('./pages/assistant/assistant').then((m) => m.AssistantPage),
  },
  {
    path: 'research/:id',
    loadComponent: () => import('./pages/research/research').then((m) => m.ResearchPage),
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/admin/admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', loadComponent: () => import('./pages/admin/admin-overview').then((m) => m.AdminOverview) },
      { path: 'theses', loadComponent: () => import('./pages/admin/admin-theses').then((m) => m.AdminTheses) },
      { path: 'theses/new', loadComponent: () => import('./pages/admin/admin-new-thesis').then((m) => m.AdminNewThesis) },
      { path: 'theses/:id', loadComponent: () => import('./pages/admin/admin-thesis').then((m) => m.AdminThesis) },
      { path: 'faculties', loadComponent: () => import('./pages/admin/admin-faculties').then((m) => m.AdminFaculties) },
      { path: 'users', loadComponent: () => import('./pages/admin/admin-users').then((m) => m.AdminUsers) },
      { path: 'activity', loadComponent: () => import('./pages/admin/admin-activity').then((m) => m.AdminActivity) },
    ],
  },
  { path: '**', redirectTo: '' },
];
