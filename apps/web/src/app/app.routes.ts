import { Routes } from '@angular/router';

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
    path: 'assistant',
    loadComponent: () => import('./pages/assistant/assistant').then((m) => m.AssistantPage),
  },
  {
    path: 'research/:id',
    loadComponent: () => import('./pages/research/research').then((m) => m.ResearchPage),
  },
  { path: '**', redirectTo: '' },
];
