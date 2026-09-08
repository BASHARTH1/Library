import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './auth/auth.guards';
import { resolve } from 'node:path';
import configuration, { type AppConfig } from './config/configuration';
import { ALL_ENTITIES } from './database/entities';
import { GeminiModule } from './gemini/gemini.module';
import { SearchService } from './search/search.service';
import { ResearchService } from './research/research.service';
import { ResearchController } from './research/research.controller';
import { ChatService } from './chat/chat.service';
import { AssistantService } from './chat/assistant.service';
import { ChatController } from './chat/chat.controller';
import { DocumentParserService } from './ingest/document-parser.service';
import { StructureService } from './ingest/structure.service';
import { IngestService } from './ingest/ingest.service';
import { OcrService } from './ingest/ocr.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // The repository root .env is the single source of configuration.
      envFilePath: [resolve(__dirname, '..', '..', '..', '.env')],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const db = config.get('database', { infer: true });

        // Neon's connection pooler forces search_path='' and rejects every
        // override, which breaks unqualified SQL — and this codebase uses raw
        // queries throughout. DATABASE_URL_UNPOOLED reports a normal
        // ["$user", public], so it is preferred when present. The pool is kept
        // small because each serverless instance holds its own.
        const url = process.env.DATABASE_URL_UNPOOLED?.trim() || db.url;

        return {
          type: 'postgres' as const,
          ...(url
            ? { url }
            : {
                host: db.host,
                port: db.port,
                database: db.name,
                username: db.username,
                password: db.password,
              }),
          ssl: db.ssl || /neon\.tech|supabase|amazonaws/.test(url ?? '')
            ? { rejectUnauthorized: false }
            : false,
          extra: {
            max: Number(process.env.DATABASE_POOL_MAX ?? 5),
            connectionTimeoutMillis: 15000,
            // Neon scales compute to zero; a cold start can take a few seconds.
            idleTimeoutMillis: 30000,
          },
          entities: ALL_ENTITIES,
          // The SQL schema file is authoritative; TypeORM must never alter it.
          synchronize: false,
          logging: ['error', 'warn'],
        };
      },
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
    GeminiModule,
    AuthModule,
  ],
  controllers: [ResearchController, ChatController],
  providers: [
    // Authentication is global: every route is protected unless it declares
    // @Public() or @OptionalAuth(). A new endpoint cannot be exposed by
    // forgetting to attach a guard.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    SearchService,
    ResearchService,
    ChatService,
    AssistantService,
    DocumentParserService,
    StructureService,
    IngestService,
    OcrService,
  ],
})
export class AppModule {}
