import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import {
  ANONYMOUS,
  IS_OPTIONAL_AUTH_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
  type AuthenticatedUser,
  type JwtPayload,
  type PermissionCode,
  type RoleCode,
} from './auth.types';

type RequestWithUser = Request & { user?: AuthenticatedUser };

/**
 * Global authentication guard.
 *
 * Applied APP-wide, so every route requires a valid token unless it is marked
 * @Public() or @OptionalAuth(). Defaulting to protected means a new endpoint
 * cannot be exposed by forgetting to add a guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    const isOptional = this.reflector.getAllAndOverride<boolean>(IS_OPTIONAL_AUTH_KEY, targets);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractToken(request);

    if (!token) {
      if (isPublic || isOptional) {
        request.user = ANONYMOUS;
        return true;
      }
      throw new UnauthorizedException('Authentication required');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.get('jwt', { infer: true }).secret,
      });
    } catch {
      // A bad token on an optional route degrades to anonymous rather than 401,
      // so an expired token never breaks public browsing.
      if (isPublic || isOptional) {
        request.user = ANONYMOUS;
        return true;
      }
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.type !== 'access') throw new UnauthorizedException('Refresh token cannot be used for access');

    const user = await this.auth.loadUser(payload.sub);
    if (!user) {
      if (isPublic || isOptional) {
        request.user = ANONYMOUS;
        return true;
      }
      throw new UnauthorizedException('Account no longer active');
    }

    request.user = user;
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
    return null;
  }
}

/** Enforces @RequireRoles / @RequirePermissions. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, targets);
    const permissions = this.reflector.getAllAndOverride<PermissionCode[]>(PERMISSIONS_KEY, targets);
    if (!roles?.length && !permissions?.length) return true;

    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user || user.id === ANONYMOUS.id) throw new UnauthorizedException('Authentication required');

    // super_admin bypasses fine-grained checks by design.
    if (user.roles.includes('super_admin')) return true;

    if (roles?.length && !roles.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException(`Requires one of: ${roles.join(', ')}`);
    }
    if (permissions?.length && !permissions.every((p) => user.permissions.includes(p))) {
      throw new ForbiddenException(`Missing permission: ${permissions.join(', ')}`);
    }
    return true;
  }
}

/**
 * Daily AI budget enforcement (spec §20).
 *
 * The schema has carried per-role token and request limits from the start, but
 * nothing read them. Without this, one caller can spend the project's entire
 * Gemini balance through the chat endpoint.
 */
@Injectable()
export class AiUsageGuard implements CanActivate {
  private readonly logger = new Logger(AiUsageGuard.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;

    if (!user || user.id === ANONYMOUS.id) {
      throw new ForbiddenException('AI features require an account');
    }
    if (!user.permissions.includes('ai.chat') && !user.roles.includes('super_admin')) {
      throw new ForbiddenException('This account is not permitted to use AI features');
    }
    if (user.roles.includes('super_admin')) return true;

    const ceiling = this.config.get('ai', { infer: true }).dailyTokenLimitPerUser;
    const tokenLimit = Math.min(user.dailyTokenLimit || ceiling, ceiling);
    const requestLimit = user.dailyRequestLimit;

    const usage = await this.auth.usageToday(user.id);

    if (requestLimit > 0 && usage.requests >= requestLimit) {
      throw new ForbiddenException(
        `Daily request limit reached (${usage.requests}/${requestLimit}). Resets at midnight.`,
      );
    }
    if (tokenLimit > 0 && usage.tokens >= tokenLimit) {
      throw new ForbiddenException(
        `Daily AI token limit reached (${usage.tokens}/${tokenLimit}). Resets at midnight.`,
      );
    }
    return true;
  }
}
