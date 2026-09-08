/**
 * Seed roles, permissions and the first administrator (spec §26).
 *
 * Idempotent. The admin password is taken from ADMIN_PASSWORD in the
 * environment — never hardcoded, never printed, and never defaulted to
 * something guessable.
 *
 * Usage:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node dist/scripts/seed-auth.js
 */
import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { PERMISSIONS, ROLES, type PermissionCode, type RoleCode } from '../auth/auth.types';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
loadEnv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
// .env.local carries the Vercel-provisioned Neon URL. Loading it with override
// lets this script target production; without it the seed silently writes to
// the local database while appearing to succeed.
loadEnv({ path: resolve(REPO_ROOT, '.env.local'), override: true, quiet: true });

/** Daily AI budget per role. public_visitor gets none — AI requires an account. */
const ROLE_DEFINITIONS: Record<RoleCode, {
  nameAr: string; nameEn: string; tokens: number; requests: number; permissions: PermissionCode[];
}> = {
  super_admin: {
    nameAr: 'مدير النظام', nameEn: 'Super Admin', tokens: 2_000_000, requests: 5000,
    permissions: [...PERMISSIONS],
  },
  admin: {
    nameAr: 'مسؤول', nameEn: 'Admin', tokens: 1_000_000, requests: 2000,
    permissions: ['research.read_metadata', 'research.read_fulltext', 'research.download',
      'ai.chat', 'ai.compare', 'ai.literature_review', 'admin.review'],
  },
  librarian: {
    nameAr: 'أمين المكتبة', nameEn: 'Librarian', tokens: 500_000, requests: 1000,
    permissions: ['research.read_metadata', 'research.read_fulltext', 'research.download',
      'ai.chat', 'ai.compare', 'admin.review'],
  },
  researcher: {
    nameAr: 'باحث', nameEn: 'Researcher', tokens: 200_000, requests: 300,
    permissions: ['research.read_metadata', 'research.read_fulltext', 'research.download',
      'ai.chat', 'ai.compare', 'ai.literature_review'],
  },
  staff: {
    nameAr: 'موظف', nameEn: 'Staff', tokens: 100_000, requests: 200,
    permissions: ['research.read_metadata', 'research.read_fulltext', 'research.download', 'ai.chat'],
  },
  student: {
    nameAr: 'طالب', nameEn: 'Student', tokens: 50_000, requests: 100,
    permissions: ['research.read_metadata', 'research.read_fulltext', 'ai.chat'],
  },
  public_visitor: {
    nameAr: 'زائر', nameEn: 'Public Visitor', tokens: 0, requests: 0,
    permissions: ['research.read_metadata'],
  },
};

async function main(): Promise<void> {
  const logger = new Logger('SeedAuth');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const dataSource = app.get(DataSource);

  // ---- permissions ----
  for (const code of PERMISSIONS) {
    await dataSource.query(
      `INSERT INTO permissions (code, description) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING`,
      [code, code.replace('.', ' ').replace('_', ' ')],
    );
  }
  logger.log(`${PERMISSIONS.length} permissions ensured`);

  // ---- roles + role_permissions ----
  for (const code of ROLES) {
    const def = ROLE_DEFINITIONS[code];
    await dataSource.query(
      `INSERT INTO roles (code, name_ar, name_en, daily_token_limit, daily_request_limit)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE
         SET name_ar = EXCLUDED.name_ar,
             name_en = EXCLUDED.name_en,
             daily_token_limit = EXCLUDED.daily_token_limit,
             daily_request_limit = EXCLUDED.daily_request_limit`,
      [code, def.nameAr, def.nameEn, def.tokens, def.requests],
    );

    // Re-grant from scratch so removing a permission here actually revokes it.
    await dataSource.query(
      `DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = $1)`, [code]);
    for (const permission of def.permissions) {
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = $1 AND p.code = $2
         ON CONFLICT DO NOTHING`,
        [code, permission],
      );
    }
  }
  logger.log(`${ROLES.length} roles ensured with permission grants`);

  // ---- first administrator ----
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';

  if (!email || !password) {
    logger.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin creation.');
    logger.warn('Create one with:  ADMIN_EMAIL=you@gulfuniversity.edu.bh ADMIN_PASSWORD=... npm run api:seed-auth');
  } else if (password.length < 12) {
    logger.error('ADMIN_PASSWORD must be at least 12 characters. No admin created.');
  } else {
    const hash = await bcrypt.hash(password, 12);
    const [user] = await dataSource.query<Array<{ id: string }>>(
      `INSERT INTO users (email, password_hash, full_name_en, is_university_member, is_active)
       VALUES ($1,$2,'Administrator',true,true)
       ON CONFLICT (lower(email)) WHERE deleted_at IS NULL
       DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [email, hash],
    );
    await dataSource.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'super_admin' ON CONFLICT DO NOTHING`,
      [user.id],
    );
    logger.log(`super_admin ready for ${email}`);
  }

  const [summary] = await dataSource.query<Array<Record<string, string>>>(
    `SELECT (SELECT count(*) FROM roles) roles,
            (SELECT count(*) FROM permissions) permissions,
            (SELECT count(*) FROM role_permissions) grants,
            (SELECT count(*) FROM users WHERE deleted_at IS NULL) users`,
  );
  console.log('\n=== AUTH SEED ===');
  console.log(summary);

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
