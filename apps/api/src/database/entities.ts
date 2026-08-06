import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * TypeORM entities mapped onto docs/schema/001_initial_schema.sql.
 *
 * `synchronize` is always false — the SQL file is the source of truth, so
 * TypeORM can never silently alter production structures.
 *
 * Every @Column declares an explicit `type`. That keeps the entities valid
 * under build tools that do not emit decorator metadata (esbuild/tsx), and is
 * the behaviour TypeORM recommends regardless.
 */

export type ResearchStatus =
  | 'pending' | 'processing' | 'extracted' | 'requires_review'
  | 'approved' | 'published' | 'failed' | 'rejected';

export type AccessLevel =
  | 'public' | 'university_only' | 'abstract_only' | 'view_only'
  | 'download_disabled' | 'restricted' | 'confidential' | 'embargoed';

export type ResearchLanguage = 'ar' | 'en' | 'mixed' | 'unknown';
export type TextSourceKind = 'pdf_text_layer' | 'word_text_layer' | 'word_twin_text' | 'vision_ocr' | 'manual';

@Entity('faculties')
export class Faculty {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'name_ar', type: 'text' }) nameAr!: string;
  @Column({ name: 'name_en', type: 'text', nullable: true }) nameEn!: string | null;
  @Column({ type: 'text' }) slug!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;

  @OneToMany(() => Department, (d) => d.faculty) departments!: Department[];
}

@Entity('departments')
export class Department {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'faculty_id', type: 'uuid' }) facultyId!: string;
  @Column({ name: 'name_ar', type: 'text' }) nameAr!: string;
  @Column({ name: 'name_en', type: 'text', nullable: true }) nameEn!: string | null;
  @Column({ type: 'text' }) slug!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;

  @ManyToOne(() => Faculty, (f) => f.departments)
  @JoinColumn({ name: 'faculty_id' })
  faculty!: Faculty;
}

@Entity('authors')
export class Author {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'full_name_ar', type: 'text', nullable: true }) fullNameAr!: string | null;
  @Column({ name: 'full_name_en', type: 'text', nullable: true }) fullNameEn!: string | null;
  @Column({ name: 'normalized_name', type: 'text' }) normalizedName!: string;
  @Column({ type: 'text', nullable: true }) email!: string | null;
  @Column({ type: 'text', nullable: true }) orcid!: string | null;
  @Column({ name: 'faculty_id', type: 'uuid', nullable: true }) facultyId!: string | null;
  @Column({ name: 'department_id', type: 'uuid', nullable: true }) departmentId!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
}

@Entity('research')
export class Research {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'title_ar', type: 'text', nullable: true }) titleAr!: string | null;
  @Column({ name: 'title_en', type: 'text', nullable: true }) titleEn!: string | null;
  @Column({ name: 'abstract_ar', type: 'text', nullable: true }) abstractAr!: string | null;
  @Column({ name: 'abstract_en', type: 'text', nullable: true }) abstractEn!: string | null;
  @Column({ name: 'publication_year', type: 'int', nullable: true }) publicationYear!: number | null;
  @Column({ name: 'faculty_id', type: 'uuid', nullable: true }) facultyId!: string | null;
  @Column({ name: 'department_id', type: 'uuid', nullable: true }) departmentId!: string | null;
  @Column({ type: 'text', nullable: true }) doi!: string | null;
  @Column({ name: 'research_type', type: 'text', nullable: true }) researchType!: string | null;
  @Column({ name: 'publication_type', type: 'text', nullable: true }) publicationType!: string | null;
  @Column({ type: 'varchar', default: 'unknown' }) language!: ResearchLanguage;
  @Column({ type: 'text', nullable: true }) degree!: string | null;
  @Column({ name: 'total_pages', type: 'int', nullable: true }) totalPages!: number | null;
  @Column({ name: 'full_text', type: 'text', nullable: true }) fullText!: string | null;
  @Column({ name: 'text_source', type: 'varchar', nullable: true }) textSource!: TextSourceKind | null;
  @Column({ type: 'varchar', default: 'pending' }) status!: ResearchStatus;
  @Column({ name: 'access_level', type: 'varchar', default: 'restricted' }) accessLevel!: AccessLevel;
  @Column({ name: 'embargo_until', type: 'date', nullable: true }) embargoUntil!: string | null;
  @Column({ name: 'view_count', type: 'bigint', default: 0 }) viewCount!: string;
  @Column({ name: 'download_count', type: 'bigint', default: 0 }) downloadCount!: string;
  @Column({ name: 'is_featured', type: 'boolean', default: false }) isFeatured!: boolean;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;

  @ManyToOne(() => Faculty) @JoinColumn({ name: 'faculty_id' }) faculty!: Faculty | null;
  @ManyToOne(() => Department) @JoinColumn({ name: 'department_id' }) department!: Department | null;
  @OneToMany(() => ResearchFile, (f) => f.research) files!: ResearchFile[];
  @OneToMany(() => ResearchAuthor, (a) => a.research) researchAuthors!: ResearchAuthor[];
}

@Entity('research_authors')
export class ResearchAuthor {
  @Column({ name: 'research_id', type: 'uuid', primary: true }) researchId!: string;
  @Column({ name: 'author_id', type: 'uuid', primary: true }) authorId!: string;
  @Column({ type: 'text', primary: true, default: 'author' }) role!: string;
  @Column({ name: 'author_order', type: 'smallint', default: 1 }) authorOrder!: number;
  @Column({ type: 'text', nullable: true }) affiliation!: string | null;
  @Column({ name: 'is_corresponding', type: 'boolean', default: false }) isCorresponding!: boolean;

  @ManyToOne(() => Research, (r) => r.researchAuthors) @JoinColumn({ name: 'research_id' }) research!: Research;
  @ManyToOne(() => Author) @JoinColumn({ name: 'author_id' }) author!: Author;
}

@Entity('research_files')
export class ResearchFile {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ name: 'original_filename', type: 'text' }) originalFilename!: string;
  @Column({ name: 'stored_path', type: 'text' }) storedPath!: string;
  @Column({ name: 'mime_type', type: 'text' }) mimeType!: string;
  @Column({ name: 'file_kind', type: 'text' }) fileKind!: string;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes!: string;
  @Column({ type: 'text' }) sha256!: string;
  @Column({ name: 'page_count', type: 'int', nullable: true }) pageCount!: number | null;
  @Column({ name: 'is_canonical', type: 'boolean', default: false }) isCanonical!: boolean;
  @Column({ name: 'is_downloadable', type: 'boolean', default: true }) isDownloadable!: boolean;
  @Column({ name: 'text_quality', type: 'text', nullable: true }) textQuality!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;

  @ManyToOne(() => Research, (r) => r.files) @JoinColumn({ name: 'research_id' }) research!: Research;
}

@Entity('research_pages')
export class ResearchPage {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ name: 'file_id', type: 'uuid' }) fileId!: string;
  @Column({ name: 'page_number', type: 'int' }) pageNumber!: number;
  @Column({ type: 'text', default: '' }) text!: string;
  @Column({ name: 'char_count', type: 'int', default: 0 }) charCount!: number;
  @Column({ name: 'text_source', type: 'varchar' }) textSource!: TextSourceKind;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('research_sections')
export class ResearchSection {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'text', nullable: true }) heading!: string | null;
  @Column({ name: 'start_page', type: 'int' }) startPage!: number;
  @Column({ name: 'end_page', type: 'int' }) endPage!: number;
  @Column({ name: 'section_order', type: 'smallint', default: 0 }) sectionOrder!: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('research_chunks')
@Index(['researchId', 'pageNumber'])
export class ResearchChunk {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ name: 'file_id', type: 'uuid', nullable: true }) fileId!: string | null;
  @Column({ name: 'section_id', type: 'uuid', nullable: true }) sectionId!: string | null;
  @Column({ name: 'chunk_index', type: 'int' }) chunkIndex!: number;
  @Column({ type: 'text' }) text!: string;
  @Column({ name: 'page_number', type: 'int' }) pageNumber!: number;
  @Column({ name: 'section_name', type: 'text', nullable: true }) sectionName!: string | null;
  @Column({ type: 'text', nullable: true }) heading!: string | null;
  @Column({ name: 'token_count', type: 'int' }) tokenCount!: number;
  @Column({ name: 'char_count', type: 'int' }) charCount!: number;
  @Column({ type: 'varchar', default: 'unknown' }) language!: ResearchLanguage;
  @Column({ name: 'is_overlap', type: 'boolean', default: false }) isOverlap!: boolean;
  @Column({ name: 'source_filename', type: 'text', nullable: true }) sourceFilename!: string | null;
  @Column({ name: 'content_hash', type: 'text' }) contentHash!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('ai_conversations')
export class AiConversation {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId!: string | null;
  @Column({ name: 'research_id', type: 'uuid', nullable: true }) researchId!: string | null;
  @Column({ type: 'text', default: 'single_research' }) scope!: string;
  @Column({ type: 'text', nullable: true }) title!: string | null;
  @Column({ name: 'general_knowledge_enabled', type: 'boolean', default: false }) generalKnowledgeEnabled!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
}

@Entity('ai_messages')
export class AiMessage {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'conversation_id', type: 'uuid' }) conversationId!: string;
  @Column({ type: 'text' }) role!: string;
  @Column({ type: 'text' }) content!: string;
  @Column({ type: 'varchar', nullable: true }) language!: ResearchLanguage | null;
  @Column({ type: 'numeric', nullable: true }) confidence!: string | null;
  @Column({ type: 'text', nullable: true }) model!: string | null;
  @Column({ name: 'prompt_tokens', type: 'int', nullable: true }) promptTokens!: number | null;
  @Column({ name: 'response_tokens', type: 'int', nullable: true }) responseTokens!: number | null;
  @Column({ name: 'total_tokens', type: 'int', nullable: true }) totalTokens!: number | null;
  @Column({ name: 'latency_ms', type: 'int', nullable: true }) latencyMs!: number | null;
  @Column({ name: 'prompt_hash', type: 'text', nullable: true }) promptHash!: string | null;
  @Column({ name: 'rendered_prompt', type: 'text', nullable: true }) renderedPrompt!: string | null;
  @Column({ name: 'finish_reason', type: 'text', nullable: true }) finishReason!: string | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('ai_message_sources')
export class AiMessageSource {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'message_id', type: 'uuid' }) messageId!: string;
  @Column({ name: 'chunk_id', type: 'uuid', nullable: true }) chunkId!: string | null;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ name: 'page_number', type: 'int', nullable: true }) pageNumber!: number | null;
  @Column({ type: 'numeric', nullable: true }) similarity!: string | null;
  @Column({ type: 'smallint', nullable: true }) rank!: number | null;
  @Column({ name: 'was_cited', type: 'boolean', default: false }) wasCited!: boolean;
  @Column({ name: 'quoted_text', type: 'text', nullable: true }) quotedText!: string | null;
  @Column({ name: 'citation_valid', type: 'boolean', nullable: true }) citationValid!: boolean | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('ai_usage_logs')
export class AiUsageLog {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'user_id', type: 'uuid', nullable: true }) userId!: string | null;
  @Column({ name: 'research_id', type: 'uuid', nullable: true }) researchId!: string | null;
  @Column({ type: 'varchar' }) operation!: string;
  @Column({ type: 'text' }) model!: string;
  @Column({ name: 'prompt_tokens', type: 'int', default: 0 }) promptTokens!: number;
  @Column({ name: 'response_tokens', type: 'int', default: 0 }) responseTokens!: number;
  @Column({ name: 'total_tokens', type: 'int', default: 0 }) totalTokens!: number;
  @Column({ name: 'latency_ms', type: 'int', nullable: true }) latencyMs!: number | null;
  @Column({ name: 'cache_hit', type: 'boolean', default: false }) cacheHit!: boolean;
  @Column({ type: 'boolean', default: true }) succeeded!: boolean;
  @Column({ name: 'error_code', type: 'text', nullable: true }) errorCode!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

@Entity('ai_generated_content')
export class AiGeneratedContent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid', nullable: true }) researchId!: string | null;
  @Column({ type: 'varchar' }) kind!: string;
  @Column({ type: 'varchar', default: 'unknown' }) language!: ResearchLanguage;
  @Column({ type: 'text' }) content!: string;
  @Column({ type: 'jsonb', nullable: true }) payload!: unknown;
  @Column({ type: 'varchar', default: 'generated' }) state!: string;
  @Column({ type: 'text' }) model!: string;
  @Column({ name: 'prompt_hash', type: 'text', nullable: true }) promptHash!: string | null;
  @Column({ name: 'total_tokens', type: 'int', nullable: true }) totalTokens!: number | null;
  @Column({ type: 'numeric', nullable: true }) confidence!: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt!: Date | null;
}

@Entity('extraction_fields')
export class ExtractionField {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'research_id', type: 'uuid' }) researchId!: string;
  @Column({ name: 'file_id', type: 'uuid', nullable: true }) fileId!: string | null;
  @Column({ name: 'field_name', type: 'text' }) fieldName!: string;
  @Column({ name: 'field_value', type: 'text', nullable: true }) fieldValue!: string | null;
  @Column({ name: 'extraction_source', type: 'text', nullable: true }) extractionSource!: string | null;
  @Column({ name: 'extraction_method', type: 'varchar', default: 'none' }) extractionMethod!: string;
  @Column({ name: 'page_number', type: 'int', nullable: true }) pageNumber!: number | null;
  @Column({ type: 'text', nullable: true }) evidence!: string | null;
  @Column({ name: 'evidence_verified', type: 'boolean', default: false }) evidenceVerified!: boolean;
  @Column({ name: 'evidence_match_ratio', type: 'numeric', nullable: true }) evidenceMatchRatio!: string | null;
  @Column({ type: 'numeric', default: 0 }) confidence!: string;
  @Column({ name: 'requires_manual_review', type: 'boolean', default: true }) requiresManualReview!: boolean;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}

export const ALL_ENTITIES = [
  Faculty, Department, Author, Research, ResearchAuthor, ResearchFile,
  ResearchPage, ResearchSection, ResearchChunk,
  AiConversation, AiMessage, AiMessageSource, AiUsageLog, AiGeneratedContent,
  ExtractionField,
];
