import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  styleUrl: './admin.scss',
  template: `
    <div class="admin-layout">
      <nav class="admin-nav" [attr.aria-label]="i18n.t('adminArea')">
        <a routerLink="/admin" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">{{ i18n.t('adminOverview') }}</a>
        <a routerLink="/admin/theses" routerLinkActive="active">{{ i18n.t('adminTheses') }}</a>
        <a routerLink="/admin/faculties" routerLinkActive="active">{{ i18n.t('adminFaculties') }}</a>
        @if (auth.canManageUsers()) {
          <a routerLink="/admin/users" routerLinkActive="active">{{ i18n.t('adminUsers') }}</a>
        }
        <a routerLink="/admin/activity" routerLinkActive="active">{{ i18n.t('adminActivity') }}</a>
      </nav>
      <div class="admin-content">
        <router-outlet />
      </div>
    </div>
  `,
})
export class AdminShell {
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
}
