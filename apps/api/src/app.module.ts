import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
        return {
          type: 'postgres' as const,
          ...(db.url
            ? { url: db.url }
            : {
                host: db.host,
                port: db.port,
                database: db.name,
                username: db.username,
                password: db.password,
              }),
          ssl: db.ssl ? { rejectUnauthorized: false } : false,
          entities: ALL_ENTITIES,
          // The SQL schema file is authoritative; TypeORM must never alter it.
          synchronize: false,
          logging: ['error', 'warn'],
        };
      },
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
    GeminiModule,
  ],
  controllers: [ResearchController, ChatController],
  providers: [
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
