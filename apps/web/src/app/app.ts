import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { I18nService } from './core/i18n.service';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="site-header">
      <a class="brand" routerLink="/" [attr.aria-label]="i18n.t('appTitle')">
        <img
          class="brand-logo"
          src="gulf-university-logo.png"
          [alt]="i18n.t('university')"
          width="960"
          height="209" />
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="brand-sub">{{ i18n.t('appShort') }}</span>
      </a>
      <nav class="site-nav">
        <a routerLink="/">{{ i18n.t('home') }}</a>
        <a routerLink="/search">{{ i18n.t('search') }}</a>
        <a routerLink="/assistant">{{ i18n.t('aiAssistant') }}</a>

        @if (auth.isAuthenticated()) {
          <span class="user-chip" [title]="auth.user()?.email ?? ''">
            {{ auth.user()?.fullName || auth.user()?.email }}
          </span>
          <button type="button" class="lang-toggle ghost" (click)="signOut()">
            {{ i18n.t('signOut') }}
          </button>
        } @else {
          <a routerLink="/login">{{ i18n.t('signIn') }}</a>
        }

        <button type="button" class="lang-toggle" (click)="i18n.toggle()">
          {{ i18n.locale() === 'ar' ? 'English' : 'العربية' }}
        </button>
      </nav>
    </header>

    <main class="site-main">
      <router-outlet />
    </main>

    <footer class="site-footer">
      <span>{{ i18n.t('appTitle') }}</span>
      <span class="muted">{{ i18n.t('aiDisclaimer') }}</span>
    </footer>
  `,
  styleUrl: './app.scss',
})
export class App {
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  signOut(): void {
    this.auth.logout();
    void this.router.navigate(['/']);
  }
}
