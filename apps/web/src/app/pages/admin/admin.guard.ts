import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';

/**
 * Keeps the admin pages out of the way of people who cannot use them. This is for
 * navigation only: the API checks the permission on every admin request.
 */
export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const toLogin = router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });

  if (!auth.accessToken) return toLogin;
  try {
    // A page refresh lands here before the session has been restored.
    await firstValueFrom(auth.refreshMe());
  } catch {
    return toLogin;
  }
  return auth.canManage() ? true : router.createUrlTree(['/']);
};
