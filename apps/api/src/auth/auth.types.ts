import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** Role codes seeded by scripts/seed-auth.ts (spec §26). */
export const ROLES = [
  'super_admin',
  'admin',
  'librarian',
  'researcher',
  'student',
  'staff',
  'public_visitor',
] as const;
export type RoleCode = (typeof ROLES)[number];

/** Permission codes checked by guards (spec §26). */
export const PERMISSIONS = [
  'research.read_metadata',
  'research.read_fulltext',
  'research.download',
  'ai.chat',
  'ai.compare',
  'ai.literature_review',
  'admin.review',
  'admin.manage_users',
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string | null;
  roles: RoleCode[];
  permissions: PermissionCode[];
  isUniversityMember: boolean;
  isAdmin: boolean;
  /** Combined daily budget across the user's roles. */
  dailyTokenLimit: number;
  dailyRequestLimit: number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles: RoleCode[];
  type: 'access' | 'refresh';
}

/**
 * Marks a route as reachable without a token.
 *
 * Authentication is global by default, so a route is protected unless it opts
 * out here — forgetting a guard cannot silently expose an endpoint.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Routes that work anonymously but behave differently when a token is present. */
export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_OPTIONAL_AUTH_KEY, true);

export const ROLES_KEY = 'requiredRoles';
export const RequireRoles = (...roles: RoleCode[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: PermissionCode[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Injects the authenticated user, or null on an OptionalAuth route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | null => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return request.user ?? null;
  },
);

/** The visitor tier used when no token is presented. */
export const ANONYMOUS: AuthenticatedUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'anonymous',
  fullName: null,
  roles: ['public_visitor'],
  permissions: ['research.read_metadata'],
  isUniversityMember: false,
  isAdmin: false,
  dailyTokenLimit: 0,
  dailyRequestLimit: 0,
};
