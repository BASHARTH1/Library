import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/** Endpoints that must never carry a token or trigger a refresh loop. */
const AUTH_ENDPOINTS = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh'];

/**
 * Attaches the access token to API calls and transparently renews it once on a
 * 401, so a user mid-session is not thrown back to the login screen when a
 * short-lived token expires.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const isAuthCall = AUTH_ENDPOINTS.some((path) => req.url.includes(path));
  const token = auth.accessToken;

  const authorised =
    token && !isAuthCall
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

  return next(authorised).pipe(
    catchError((error: unknown) => {
      const is401 = error instanceof HttpErrorResponse && error.status === 401;
      if (!is401 || isAuthCall || !token) return throwError(() => error);

      // One renewal attempt; if it fails the session is genuinely over.
      return auth.renew().pipe(
        switchMap((tokens) =>
          next(req.clone({ setHeaders: { Authorization: `Bearer ${tokens.accessToken}` } })),
        ),
        catchError((renewError: unknown) => {
          auth.clearTokens();
          return throwError(() => renewError);
        }),
      );
    }),
  );
};
