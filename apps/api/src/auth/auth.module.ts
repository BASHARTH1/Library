import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import type { AppConfig } from '../config/configuration';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AiUsageGuard, JwtAuthGuard, RolesGuard } from './auth.guards';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get('jwt', { infer: true }).secret,
        signOptions: {
          expiresIn: config.get('jwt', { infer: true }).expiresIn as NonNullable<JwtSignOptions['expiresIn']>,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, AiUsageGuard],
  exports: [AuthService, JwtAuthGuard, RolesGuard, AiUsageGuard, JwtModule],
})
export class AuthModule {}
