import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  roles: string[];
  permissions: string[];
  isUniversityMember: boolean;
  dailyTokenLimit: number;
  dailyRequestLimit: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: AuthUser;
}

export interface MeResponse {
  authenticated: boolean;
  id?: string;
  email?: string;
  fullName?: string | null;
  roles: string[];
  permissions?: string[];
  isUniversityMember?: boolean;
  usage?: {
    tokensToday: number;
    requestsToday: number;
    tokenLimit: number;
    requestLimit: number;
  };
}

const ACCESS_KEY = 'gu_access_token';
const REFRESH_KEY = 'gu_refresh_token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly user = signal<MeResponse | null>(null);
  readonly isAuthenticated = computed(() => this.user()?.authenticated === true);
  readonly canUseAi = computed(() => this.user()?.permissions?.includes('ai.chat') ?? false);
  readonly isAdmin = computed(() => {
    const roles = this.user()?.roles ?? [];
    return roles.includes('admin') || roles.includes('super_admin');
  });

  constructor() {
    // Restore the session on boot so a refresh does not appear to log the user out.
    if (this.accessToken) this.refreshMe().subscribe({ error: () => this.clearTokens() });
  }

  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_KEY);
  }

  private get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY);
  }

  private store(tokens: AuthTokens): void {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  }

  clearTokens(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    this.user.set(null);
  }

  login(email: string, password: string): Observable<AuthTokens> {
    return this.http.post<AuthTokens>('/api/auth/login', { email, password }).pipe(
      tap((tokens) => {
        this.store(tokens);
        this.refreshMe().subscribe();
      }),
    );
  }

  register(input: { email: string; password: string; fullName?: string }): Observable<AuthTokens> {
    return this.http.post<AuthTokens>('/api/auth/register', input).pipe(
      tap((tokens) => {
        this.store(tokens);
        this.refreshMe().subscribe();
      }),
    );
  }

  /** Re-reads identity and remaining AI budget. */
  refreshMe(): Observable<MeResponse> {
    return this.http.get<MeResponse>('/api/auth/me').pipe(tap((me) => this.user.set(me)));
  }

  /** Exchanges the refresh token; used by the interceptor after a 401. */
  renew(): Observable<AuthTokens> {
    return this.http
      .post<AuthTokens>('/api/auth/refresh', { refreshToken: this.refreshToken })
      .pipe(tap((tokens) => this.store(tokens)));
  }

  logout(): void {
    this.clearTokens();
  }
}
