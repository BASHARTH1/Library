import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { ASSIGNABLE_ROLES, AdminService, type UserRow, errorMessage } from '../../core/admin.service';
import { AuthService } from '../../core/auth.service';
import { I18nService, type StringKey } from '../../core/i18n.service';

@Component({
  selector: 'app-admin-users',
  imports: [DatePipe, FormsModule],
  styleUrl: './admin.scss',
  template: `
    <div class="page-head">
      <h1>{{ i18n.t('adminUsers') }}</h1>
      <button class="btn" type="button" (click)="adding.set(!adding())">{{ i18n.t('addUser') }}</button>
    </div>

    @if (error()) { <p class="notice small section" role="alert">{{ error() }}</p> }

    @if (adding()) {
      <form class="card section" (ngSubmit)="create()">
        <div class="form-grid">
          <label><span class="small muted">{{ i18n.t('email') }}</span>
            <input class="input" type="email" name="email" dir="ltr" required autocomplete="off" [ngModel]="email()" (ngModelChange)="email.set($event)" /></label>
          <label><span class="small muted">{{ i18n.t('fullName') }}</span>
            <input class="input" name="fullName" autocomplete="off" [ngModel]="fullName()" (ngModelChange)="fullName.set($event)" /></label>
          <label><span class="small muted">{{ i18n.t('password') }}</span>
            <input class="input" type="password" name="password" required autocomplete="new-password" [ngModel]="password()" (ngModelChange)="password.set($event)" />
            <span class="small muted">{{ i18n.t('passwordHint') }}</span></label>
          <label><span class="small muted">{{ i18n.t('rolesLabel') }}</span>
            <select class="select" name="role" [ngModel]="role()" (ngModelChange)="role.set($event)">
              @for (r of roles; track r) { <option [value]="r">{{ i18n.t(roleKey(r)) }}</option> }
            </select></label>
        </div>
        <div class="actions">
          <button class="btn" type="submit" [disabled]="busy() || !email() || password().length < 12">{{ i18n.t('save') }}</button>
          <button class="btn btn-ghost" type="button" (click)="adding.set(false)">{{ i18n.t('cancel') }}</button>
        </div>
      </form>
    }

    <form class="toolbar" (ngSubmit)="load()">
      <input class="input" name="q" [placeholder]="i18n.t('searchUsers')" [ngModel]="q()" (ngModelChange)="q.set($event)" />
      <button class="btn btn-ghost" type="submit">{{ i18n.t('search') }}</button>
    </form>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>{{ i18n.t('email') }}</th>
            <th>{{ i18n.t('rolesLabel') }}</th>
            <th>{{ i18n.t('lastLogin') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (user of users(); track user.id) {
            <tr>
              <td>
                <span dir="ltr">{{ user.email }}</span>
                @if (user.full_name) { <div class="small muted">{{ user.full_name }}</div> }
                <label class="small">
                  <input type="checkbox" [checked]="user.is_university_member"
                         (change)="send(admin.updateUser(user.id, { isUniversityMember: !user.is_university_member }))" />
                  {{ i18n.t('universityMember') }}
                </label>
              </td>
              <td>
                <div class="role-checks">
                  @for (r of roles; track r) {
                    <label>
                      <input type="checkbox" [checked]="user.roles.includes(r)"
                             [disabled]="r === 'super_admin' && user.id === auth.user()?.id"
                             (change)="toggleRole(user, r)" />
                      {{ i18n.t(roleKey(r)) }}
                    </label>
                  }
                </div>
              </td>
              <td class="small">{{ user.last_login_at ? (user.last_login_at | date: 'short') : i18n.t('never') }}</td>
              <td>
                <div class="actions" style="margin: 0">
                  <button class="btn btn-ghost btn-sm" type="button" (click)="setPassword(user)">{{ i18n.t('resetPassword') }}</button>
                  @if (user.id !== auth.user()?.id) {
                    <button class="btn btn-sm" type="button" [class.btn-danger]="user.is_active" [class.btn-ghost]="!user.is_active"
                            (click)="send(admin.updateUser(user.id, { isActive: !user.is_active }))">
                      {{ user.is_active ? i18n.t('deactivate') : i18n.t('activate') }}
                    </button>
                  }
                </div>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class AdminUsers {
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
  readonly admin = inject(AdminService);

  readonly roles = ASSIGNABLE_ROLES;
  readonly users = signal<UserRow[]>([]);
  readonly q = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly adding = signal(false);
  readonly email = signal('');
  readonly fullName = signal('');
  readonly password = signal('');
  readonly role = signal<string>('librarian');

  constructor() {
    this.load();
  }

  roleKey(role: string): StringKey {
    return `role_${role}` as StringKey;
  }

  load(): void {
    this.admin.users(this.q().trim()).subscribe({
      next: (rows) => this.users.set(rows),
      error: () => this.error.set(this.i18n.t('loadFailed')),
    });
  }

  send(request: Observable<unknown>, onDone?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    request.subscribe({
      next: () => {
        this.busy.set(false);
        onDone?.();
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(error, this.i18n.t('authFailed')));
        // A checkbox has already changed on screen; put it back in line with the server.
        this.load();
      },
    });
  }

  toggleRole(user: UserRow, role: string): void {
    const roles = user.roles.includes(role) ? user.roles.filter((r) => r !== role) : [...user.roles, role];
    this.send(this.admin.updateUser(user.id, { roles }));
  }

  setPassword(user: UserRow): void {
    const password = prompt(`${user.email}\n${this.i18n.t('newPasswordPrompt')}`);
    if (!password) return;
    if (password.length < 12) {
      this.error.set(this.i18n.t('authPasswordTooShort'));
      return;
    }
    this.send(this.admin.updateUser(user.id, { password }));
  }

  create(): void {
    this.send(
      this.admin.createUser({
        email: this.email().trim(),
        password: this.password(),
        fullName: this.fullName().trim() || undefined,
        roles: [this.role()],
      }),
      () => {
        this.adding.set(false);
        this.email.set('');
        this.fullName.set('');
        this.password.set('');
      },
    );
  }
}
