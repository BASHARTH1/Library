import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ROLES, type RoleCode } from '../auth/auth.types';
import type { AccessLevel } from '../database/entities';

const ACCESS_LEVELS: AccessLevel[] = [
  'public', 'university_only', 'abstract_only', 'view_only',
  'download_disabled', 'restricted', 'confidential', 'embargoed',
];

/** Everyone but the anonymous tier, which is not a role an account can hold. */
const ASSIGNABLE_ROLES = ROLES.filter((role) => role !== 'public_visitor');

export class ThesisFileDto {
  @IsString() @MaxLength(255) filename!: string;
  @IsInt() @Min(1) size!: number;
  @Matches(/^[a-f0-9]{64}$/, { message: 'sha256 must be a lowercase hex digest' }) sha256!: string;
}

/** All editable details. Null clears a field; an absent one is left alone. */
export class ThesisDetailsDto {
  @IsOptional() @IsString() @MaxLength(1000) titleAr?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) titleEn?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) abstractAr?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) abstractEn?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1950) @Max(2100) publicationYear?: number | null;
  @IsOptional() @IsUUID() facultyId?: string | null;
  @IsOptional() @IsUUID() departmentId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) degree?: string | null;
  @IsOptional() @IsString() @MaxLength(100) researchType?: string | null;
  @IsOptional() @IsString() @MaxLength(100) publicationType?: string | null;
  @IsOptional() @IsString() @MaxLength(200) doi?: string | null;
  @IsOptional() @IsIn(ACCESS_LEVELS) accessLevel?: AccessLevel;
  @IsOptional() @IsDateString() embargoUntil?: string | null;
  @IsOptional() @IsBoolean() isFeatured?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) authors?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) supervisors?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(200, { each: true }) keywordsAr?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(200, { each: true }) keywordsEn?: string[];
}

export class CreateThesisDto extends ThesisDetailsDto {
  @ValidateNested() @Type(() => ThesisFileDto) file!: ThesisFileDto;
}

export class FacultyDto {
  @IsString() @MinLength(2) @MaxLength(200) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(200) nameEn?: string | null;
}

export class CreateUserDto {
  @IsEmail() @MaxLength(180) email!: string;
  @IsString() @MinLength(12) @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(160) fullName?: string;
  @IsArray() @IsIn(ASSIGNABLE_ROLES, { each: true }) roles!: RoleCode[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(160) fullName?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isUniversityMember?: boolean;
  @IsOptional() @IsArray() @IsIn(ASSIGNABLE_ROLES, { each: true }) roles?: RoleCode[];
  @IsOptional() @IsString() @MinLength(12) @MaxLength(200) password?: string;
}
