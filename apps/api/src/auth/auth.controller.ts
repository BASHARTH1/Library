import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { CurrentUser, OptionalAuth, Public, type AuthenticatedUser, type RoleCode } from './auth.types';

export class RegisterDto {
  @IsEmail() @MaxLength(180) email!: string;

  // 12 chars minimum: this protects a billing-enabled AI key, not a blog login.
  @IsString() @MinLength(12) @MaxLength(200) password!: string;

  @IsOptional() @IsString() @MaxLength(160) fullName?: string;

  // Only self-service roles are accepted; privileged roles are assigned by an admin.
  @IsOptional() @IsIn(['student', 'researcher', 'staff']) role?: RoleCode;
}

export class LoginDto {
  @IsEmail() @MaxLength(180) email!: string;
  @IsString() @MaxLength(200) password!: string;
}

export class RefreshDto {
  @IsString() refreshToken!: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  /** Current identity plus remaining AI budget, for the UI to display. */
  @OptionalAuth()
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser | null) {
    if (!user || user.email === 'anonymous') {
      return { authenticated: false, roles: ['public_visitor'] };
    }
    const usage = await this.auth.usageToday(user.id);
    return {
      authenticated: true,
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      permissions: user.permissions,
      isUniversityMember: user.isUniversityMember,
      usage: {
        tokensToday: usage.tokens,
        requestsToday: usage.requests,
        tokenLimit: user.dailyTokenLimit,
        requestLimit: user.dailyRequestLimit,
      },
    };
  }
}
