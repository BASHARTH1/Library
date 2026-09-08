import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import type { AppConfig } from '../config/configuration';
import type { AuthenticatedUser, JwtPayload, PermissionCode, RoleCode } from './auth.types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: Omit<AuthenticatedUser, 'permissions'> & { permissions: PermissionCode[] };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Load a user with roles, permissions and the effective daily budget.
   * The budget is the MAXIMUM across roles, so adding a role can only widen access.
   */
  async loadUser(userId: string): Promise<AuthenticatedUser | null> {
    const [row] = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT u.id, u.email, COALESCE(u.full_name_en, u.full_name_ar) AS full_name,
              u.is_university_member, u.is_active,
              COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              COALESCE(ARRAY(
                SELECT DISTINCT p.code FROM role_permissions rp
                JOIN permissions p ON p.id = rp.permission_id
                WHERE rp.role_id IN (SELECT role_id FROM user_roles WHERE user_id = u.id)
              ), '{}') AS permissions,
              COALESCE(MAX(r.daily_token_limit), 0)   AS daily_token_limit,
              COALESCE(MAX(r.daily_request_limit), 0) AS daily_request_limit
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND u.deleted_at IS NULL
       GROUP BY u.id`,
      [userId],
    );

    if (!row || row.is_active === false) return null;

    const roles = (row.roles as RoleCode[]) ?? [];
    return {
      id: String(row.id),
      email: String(row.email),
      fullName: (row.full_name as string) ?? null,
      roles,
      permissions: (row.permissions as PermissionCode[]) ?? [],
      isUniversityMember: Boolean(row.is_university_member),
      isAdmin: roles.includes('super_admin') || roles.includes('admin'),
      dailyTokenLimit: Number(row.daily_token_limit),
      dailyRequestLimit: Number(row.daily_request_limit),
    };
  }

  async register(input: {
    email: string;
    password: string;
    fullName?: string;
    role?: RoleCode;
  }): Promise<AuthTokens> {
    const email = input.email.trim().toLowerCase();

    const [existing] = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email]);
    if (existing) throw new ConflictException('An account with this email already exists');

    // University membership is derived from the email domain, never self-declared.
    const isUniversityMember = email.endsWith('@gulfuniversity.edu.bh');
    const hash = await bcrypt.hash(input.password, 12);

    const [user] = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO users (email, password_hash, full_name_en, is_university_member)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, hash, input.fullName ?? null, isUniversityMember],
    );

    // Self-registration can never grant a privileged role.
    const requested = input.role;
    const safeRole: RoleCode =
      requested && ['student', 'researcher', 'staff'].includes(requested)
        ? requested
        : isUniversityMember
          ? 'researcher'
          : 'student';

    await this.dataSource.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = $2 ON CONFLICT DO NOTHING`,
      [user.id, safeRole],
    );

    const loaded = await this.loadUser(user.id);
    if (!loaded) throw new UnauthorizedException('Account creation failed');
    return this.issueTokens(loaded);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const normalized = email.trim().toLowerCase();
    const [row] = await this.dataSource.query<Array<{ id: string; password_hash: string | null }>>(
      `SELECT id, password_hash FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [normalized],
    );

    // Compare against a dummy hash when the user is absent so response time does
    // not reveal whether an email is registered.
    const hash = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const valid = await bcrypt.compare(password, hash);
    if (!row || !valid) throw new UnauthorizedException('Invalid email or password');

    const user = await this.loadUser(row.id);
    if (!user) throw new UnauthorizedException('Account is inactive');

    await this.dataSource.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const jwtConfig = this.config.get('jwt', { infer: true });
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, { secret: jwtConfig.refreshSecret });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Not a refresh token');

    const user = await this.loadUser(payload.sub);
    if (!user) throw new UnauthorizedException('Account no longer active');
    return this.issueTokens(user);
  }

  private async issueTokens(user: AuthenticatedUser): Promise<AuthTokens> {
    const jwtConfig = this.config.get('jwt', { infer: true });
    const base = { sub: user.id, email: user.email, roles: user.roles };

    // expiresIn is a template-literal type from `ms` ("1h", "7d"), not a plain
    // string, so the env-sourced value is narrowed here rather than at every use.
    type ExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync({ ...base, type: 'access' }, {
        secret: jwtConfig.secret,
        expiresIn: jwtConfig.expiresIn as ExpiresIn,
      }),
      this.jwt.signAsync({ ...base, type: 'refresh' }, {
        secret: jwtConfig.refreshSecret,
        expiresIn: jwtConfig.refreshExpiresIn as ExpiresIn,
      }),
    ]);

    return { accessToken, refreshToken, expiresIn: jwtConfig.expiresIn, user };
  }

  /**
   * Today's AI consumption for a user, used to enforce the per-role budget.
   * Reads ai_usage_logs, which every AI operation now writes to.
   */
  async usageToday(userId: string): Promise<{ tokens: number; requests: number }> {
    const [row] = await this.dataSource.query<Array<{ tokens: string; requests: string }>>(
      `SELECT COALESCE(sum(total_tokens), 0) AS tokens, count(*) AS requests
       FROM ai_usage_logs
       WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [userId],
    );
    return { tokens: Number(row?.tokens ?? 0), requests: Number(row?.requests ?? 0) };
  }

  /**
   * Today's spend by signed-out callers, which all log with a NULL user_id.
   *
   * They cannot be metered individually, so the AI guard holds them to a single
   * shared ceiling rather than a per-account one.
   */
  async anonymousUsageToday(): Promise<{ tokens: number; requests: number }> {
    const [row] = await this.dataSource.query<Array<{ tokens: string; requests: string }>>(
      `SELECT COALESCE(sum(total_tokens), 0) AS tokens, count(*) AS requests
       FROM ai_usage_logs
       WHERE user_id IS NULL
         AND operation IN ('chat_single', 'chat_repository', 'classification')
         AND created_at >= date_trunc('day', now())`,
    );
    return { tokens: Number(row?.tokens ?? 0), requests: Number(row?.requests ?? 0) };
  }
}
