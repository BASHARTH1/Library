import { Injectable, computed, signal } from '@angular/core';

export type Locale = 'ar' | 'en';

const STRINGS = {
  ar: {
    appTitle: 'مستودع البحوث بالجامعة الخليجية',
    appShort: 'مستودع البحوث',
    university: 'الجامعة الخليجية',
    searchPlaceholder: 'ابحث في البحوث بالعنوان أو المؤلف أو الموضوع…',
    search: 'بحث',
    aiAssistant: 'المساعد البحثي الذكي',
    askRepository: 'اسأل المستودع',
    latest: 'أحدث البحوث',
    mostViewed: 'الأكثر مشاهدة',
    browseByFaculty: 'تصفح حسب الكلية',
    browseByYear: 'تصفح حسب السنة',
    statistics: 'إحصائيات المستودع',
    researchCount: 'بحث',
    authorCount: 'باحث',
    facultyCount: 'كلية',
    pageCount: 'صفحة',
    chunkCount: 'مقطع مفهرس',
    results: 'نتيجة',
    noResults: 'لا توجد نتائج مطابقة',
    termMatch: 'مطابقة نصية',
    relatedMatch: 'تشابه دلالي',
    // {0} = total indexed, {1} = semantic-ready
    corpusHint: 'المستودع يحتوي على {0} بحثًا مفهرسًا للبحث النصي الكامل، منها {1} جاهزة للبحث الدلالي.',
    relaxedSearch: 'لم يتم العثور على بحث يطابق جميع الكلمات، لذا يتم عرض النتائج الأقرب التي تطابق بعضها.',
    tryFewerWords: 'جرّب كلمات أقل أو مصطلحات أعم.',
    modeAsk: 'اسأل المستودع',
    modeAskHint: 'إجابة مبنية على محتوى البحوث مع ذكر مصادرها',
    modeFind: 'ابحث عن بحوث',
    modeFindHint: 'اعثر على البحوث ذات الصلة مع شرح سبب ملاءمتها',
    askRepoPlaceholder: 'اطرح سؤالاً على جميع بحوث المستودع…',
    findPlaceholder: 'صف ما تبحث عنه بلغتك الطبيعية…',
    answerSources: 'المصادر المستخدمة في الإجابة',
    retrievalSemantic: 'استرجاع دلالي',
    retrievalLexical: 'استرجاع نصي',
    papersSearched: 'من {0} بحثًا',
    usedInAnswer: 'استُخدم في الإجابة',
    showExcerpts: 'عرض المقتطفات',
    // {0} = semantic-ready, {1} = total. The assistant reads ALL papers via
    // full-text retrieval; only meaning-based retrieval is still partial.
    assistantCoverage: 'المساعد يقرأ من جميع البحوث الـ{1} عبر البحث النصي الكامل. الاسترجاع الدلالي (المعتمد على المعنى) متاح لـ{0} منها حتى الآن، وستتحسن دقة الإجابات بعد توليد بقية المتجهات.',
    signIn: 'تسجيل الدخول',
    signOut: 'تسجيل الخروج',
    createAccount: 'إنشاء حساب',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    fullName: 'الاسم الكامل',
    passwordHint: '١٢ حرفًا على الأقل.',
    authWhy: 'التصفح والبحث متاحان للجميع. يتطلب المساعد الذكي حسابًا لضبط الاستخدام وحماية موارد النظام.',
    authFillFields: 'يرجى إدخال البريد الإلكتروني وكلمة المرور.',
    authPasswordTooShort: 'كلمة المرور يجب أن تكون ١٢ حرفًا على الأقل.',
    authFailed: 'تعذّر إتمام العملية. يرجى المحاولة مرة أخرى.',
    authServerUnreachable: 'تعذّر الوصول إلى الخادم.',
    browseWithoutAccount: 'يمكنك التصفح دون حساب:',
    aiLimitReached: 'تم بلوغ الحد اليومي المشترك للمساعد الذكي، ويُعاد ضبطه عند منتصف الليل.',
    aiUnavailable: 'تعذّر الوصول إلى المساعد الذكي. يُرجى المحاولة مرة أخرى.',
    semanticPartial: 'البحث الدلالي متاح حاليًا لـ {0} من {1} بحثًا — يجري توليد المتجهات لبقية المستودع.',
    semanticOn: 'البحث الدلالي مفعّل',
    abstract: 'المستخلص',
    keywords: 'الكلمات المفتاحية',
    authors: 'المؤلفون',
    supervisors: 'المشرفون',
    faculty: 'الكلية',
    department: 'القسم',
    year: 'سنة النشر',
    pages: 'الصفحات',
    language: 'اللغة',
    degree: 'الدرجة العلمية',
    views: 'المشاهدات',
    sections: 'أقسام البحث',
    viewer: 'عارض البحث',
    askThisResearch: 'اسأل هذا البحث',
    askPlaceholder: 'اطرح سؤالاً عن هذا البحث…',
    send: 'إرسال',
    stop: 'إيقاف',
    copy: 'نسخ',
    copied: 'تم النسخ',
    regenerate: 'إعادة التوليد',
    sources: 'المصادر',
    page: 'صفحة',
    confidence: 'درجة الثقة',
    suggestedQuestions: 'أسئلة مقترحة',
    similarResearch: 'بحوث مشابهة',
    why: 'سبب الاقتراح',
    aiDisclaimer: 'محتوى مولّد بالذكاء الاصطناعي — يستند إلى مقاطع من هذا البحث فقط ويتطلب مراجعة أكاديمية.',
    thinking: 'جارٍ التحليل…',
    retrieving: 'جارٍ استرجاع المقاطع…',
    openPage: 'افتح الصفحة',
    backToSearch: 'العودة للنتائج',
    home: 'الرئيسية',
    all: 'الكل',
    filters: 'التصفية',
    textQualityWarning: 'تنبيه: الطبقة النصية لهذا الملف تحتوي على تشويه في الحروف العربية (مشكلة الخط في ملف PDF). قيد المعالجة عبر المسح الضوئي.',
    high: 'عالية', medium: 'متوسطة', low: 'منخفضة', none: 'لا توجد',
  },
  en: {
    appTitle: 'Gulf University Research Repository',
    appShort: 'Research Repository',
    university: 'Gulf University',
    searchPlaceholder: 'Search research by title, author or topic…',
    search: 'Search',
    aiAssistant: 'AI Research Assistant',
    askRepository: 'Ask the repository',
    latest: 'Latest research',
    mostViewed: 'Most viewed',
    browseByFaculty: 'Browse by faculty',
    browseByYear: 'Browse by year',
    statistics: 'Repository statistics',
    researchCount: 'research',
    authorCount: 'authors',
    facultyCount: 'faculties',
    pageCount: 'pages',
    chunkCount: 'indexed chunks',
    results: 'results',
    noResults: 'No matching results',
    termMatch: 'term match',
    relatedMatch: 'semantic match',
    // {0} = total indexed, {1} = semantic-ready
    corpusHint: 'The repository holds {0} research papers indexed for full-text search, {1} of which are ready for semantic search.',
    relaxedSearch: 'No paper matched every word, so the closest matches are shown instead.',
    tryFewerWords: 'Try fewer words or broader terms.',
    modeAsk: 'Ask the repository',
    modeAskHint: 'An answer grounded in the research, with its sources',
    modeFind: 'Find research',
    modeFindHint: 'Locate relevant papers and why each one fits',
    askRepoPlaceholder: 'Ask a question across all repository research…',
    findPlaceholder: 'Describe what you are looking for, in your own words…',
    answerSources: 'Sources used for this answer',
    retrievalSemantic: 'semantic retrieval',
    retrievalLexical: 'full-text retrieval',
    papersSearched: 'across {0} papers',
    usedInAnswer: 'used in answer',
    showExcerpts: 'Show excerpts',
    // {0} = semantic-ready, {1} = total. The assistant reads ALL papers via
    // full-text retrieval; only meaning-based retrieval is still partial.
    assistantCoverage: 'The assistant reads all {1} papers using full-text retrieval. Meaning-based (semantic) retrieval covers {0} of them so far, so answer quality improves once the remaining vectors are generated.',
    signIn: 'Sign in',
    signOut: 'Sign out',
    createAccount: 'Create account',
    email: 'Email',
    password: 'Password',
    fullName: 'Full name',
    passwordHint: 'At least 12 characters.',
    authWhy: 'Browsing and search are open to everyone. The AI assistant requires an account so usage can be attributed and limited.',
    authFillFields: 'Please enter both email and password.',
    authPasswordTooShort: 'Password must be at least 12 characters.',
    authFailed: 'That did not work. Please try again.',
    authServerUnreachable: 'Could not reach the server.',
    browseWithoutAccount: 'You can browse without an account:',
    aiLimitReached: 'The shared daily limit for the AI assistant has been reached. It resets at midnight.',
    aiUnavailable: 'The AI assistant is unavailable. Please try again.',
    semanticPartial: 'Semantic search currently covers {0} of {1} papers — vectors are still being generated for the rest.',
    semanticOn: 'Semantic search active',
    abstract: 'Abstract',
    keywords: 'Keywords',
    authors: 'Authors',
    supervisors: 'Supervisors',
    faculty: 'Faculty',
    department: 'Department',
    year: 'Year',
    pages: 'Pages',
    language: 'Language',
    degree: 'Degree',
    views: 'Views',
    sections: 'Sections',
    viewer: 'Research viewer',
    askThisResearch: 'Ask This Research',
    askPlaceholder: 'Ask a question about this paper…',
    send: 'Send',
    stop: 'Stop',
    copy: 'Copy',
    copied: 'Copied',
    regenerate: 'Regenerate',
    sources: 'Sources',
    page: 'page',
    confidence: 'Confidence',
    suggestedQuestions: 'Suggested questions',
    similarResearch: 'Similar research',
    why: 'Why recommended',
    aiDisclaimer: 'AI-generated — grounded only in passages from this paper and requires academic review.',
    thinking: 'Analysing…',
    retrieving: 'Retrieving passages…',
    openPage: 'Open page',
    backToSearch: 'Back to results',
    home: 'Home',
    all: 'All',
    filters: 'Filters',
    textQualityWarning: 'Note: this file’s text layer has corrupted Arabic glyphs (a PDF font issue). An OCR pass is planned to correct it.',
    high: 'High', medium: 'Medium', low: 'Low', none: 'None',
  },
} as const;

export type StringKey = keyof typeof STRINGS.ar;

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly locale = signal<Locale>((localStorage.getItem('locale') as Locale) ?? 'ar');
  readonly dir = computed<'rtl' | 'ltr'>(() => (this.locale() === 'ar' ? 'rtl' : 'ltr'));

  constructor() {
    this.apply();
  }

  t(key: StringKey): string {
    return STRINGS[this.locale()][key];
  }

  /**
   * Interpolate positional placeholders: tf('corpusHint', 79, 3) fills {0}, {1}.
   *
   * A missing or non-finite value renders as an em dash rather than leaving the
   * raw "{1}" in the page — a template placeholder must never reach the user,
   * even when an API response is stale or a field is absent.
   */
  tf(key: StringKey, ...values: Array<string | number | null | undefined>): string {
    return STRINGS[this.locale()][key].replace(/\{(\d+)\}/g, (_match, index: string) => {
      const value = values[Number(index)];
      if (value === undefined || value === null) return '—';
      if (typeof value === 'number' && !Number.isFinite(value)) return '—';
      return String(value);
    });
  }

  toggle(): void {
    this.locale.set(this.locale() === 'ar' ? 'en' : 'ar');
    localStorage.setItem('locale', this.locale());
    this.apply();
  }

  private apply(): void {
    document.documentElement.lang = this.locale();
    document.documentElement.dir = this.dir();
  }

  /** Prefer the title in the active locale, falling back to whichever exists. */
  title(item: { title_ar?: string | null; title_en?: string | null; titleAr?: string | null; titleEn?: string | null }): string {
    const ar = item.title_ar ?? item.titleAr ?? null;
    const en = item.title_en ?? item.titleEn ?? null;
    return this.locale() === 'ar' ? (ar ?? en ?? '') : (en ?? ar ?? '');
  }
}
