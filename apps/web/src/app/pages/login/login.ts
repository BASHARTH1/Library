import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly i18n = inject(I18nService);

  readonly mode = signal<'login' | 'register'>('login');
  readonly email = signal('');
  readonly password = signal('');
  readonly fullName = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** Where to return after signing in; defaults to the assistant. */
  private redirectTo = '/assistant';

  constructor() {
    const target = this.route.snapshot.queryParamMap.get('redirect');
    if (target && target.startsWith('/')) this.redirectTo = target;
  }

  setMode(mode: 'login' | 'register'): void {
    this.mode.set(mode);
    this.error.set(null);
  }

  submit(): void {
    if (this.busy()) return;
    this.error.set(null);

    const email = this.email().trim();
    const password = this.password();

    if (!email || !password) {
      this.error.set(this.i18n.t('authFillFields'));
      return;
    }
    if (this.mode() === 'register' && password.length < 12) {
      this.error.set(this.i18n.t('authPasswordTooShort'));
      return;
    }

    this.busy.set(true);
    const request =
      this.mode() === 'login'
        ? this.auth.login(email, password)
        : this.auth.register({ email, password, fullName: this.fullName().trim() || undefined });

    request.subscribe({
      next: () => {
        this.busy.set(false);
        void this.router.navigateByUrl(this.redirectTo);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(this.describe(err));
      },
    });
  }

  /** Surface the server's reason rather than a generic failure message. */
  private describe(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const message = (err.error as { message?: string | string[] })?.message;
      if (Array.isArray(message)) return message.join(' · ');
      if (typeof message === 'string') return message;
      if (err.status === 0) return this.i18n.t('authServerUnreachable');
    }
    return this.i18n.t('authFailed');
  }
}
