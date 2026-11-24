import { describe, expect, it } from 'vitest';
import {
  CN_SUPPORTED_LOCALES,
  GLOBAL_SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_CODES,
  SUPPORTED_LOCALES,
  detectLocaleLeakage,
  getLocaleMeta,
  isSupportedLocale,
  resolveEffectiveLocale,
  resolveLocaleWritingDirective,
  supportedLocalesForMarket,
} from './locales';

describe('locales.ts — catalog, leakage detection & writing directives', () => {
  it('registers all 7 supported locales with required metadata and market partition', () => {
    expect(SUPPORTED_LOCALE_CODES).toEqual([
      'zh-CN',
      'en-US',
      'en-GB',
      'de-DE',
      'ja-JP',
      'es-ES',
      'fr-FR',
    ]);
    expect(CN_SUPPORTED_LOCALES).toEqual(['zh-CN']);
    expect(GLOBAL_SUPPORTED_LOCALES).toEqual([
      'en-US',
      'en-GB',
      'de-DE',
      'ja-JP',
      'es-ES',
      'fr-FR',
    ]);
    expect(supportedLocalesForMarket('CN')).toEqual(['zh-CN']);
    expect(supportedLocalesForMarket('GLOBAL')).toEqual(GLOBAL_SUPPORTED_LOCALES);

    for (const code of SUPPORTED_LOCALE_CODES) {
      const meta = SUPPORTED_LOCALES[code];
      expect(meta.code).toBe(code);
      expect(meta.nativeLabel.length).toBeGreaterThan(0);
      expect(meta.htmlLang).toBe(code);
      expect(meta.complianceNoticeKey.length).toBeGreaterThan(0);
      expect(isSupportedLocale(code)).toBe(true);
      expect(getLocaleMeta(code)).toEqual(meta);
    }
    expect(isSupportedLocale('xx-YY')).toBe(false);
    expect(resolveEffectiveLocale(undefined, 'CN')).toBe('zh-CN');
    expect(resolveEffectiveLocale(undefined, 'GLOBAL')).toBe('en-US');
    expect(resolveEffectiveLocale('ja-JP', 'GLOBAL')).toBe('ja-JP');
    expect(resolveEffectiveLocale('de', 'GLOBAL')).toBe('de-DE');
  });

  it('produces zero false positives on natural Japanese prose with Joyo Kanji + Kana and short Kanji headers', () => {
    const naturalJapanese =
      '2026年最新の家庭用ホームプロジェクター徹底比較。法律や景品表示法、総合評価の基準に基づき、国内メーカーの本体設計、静音性、明るさ、消費電力、参加ユーザーの声を点数と写真で検証しました。学会や会社の会議室でも活用できます。';
    const result = detectLocaleLeakage(naturalJapanese, 'ja-JP');
    expect(result.leaked).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.samples).toEqual([]);

    // Short Kanji-only table header / title (< 24 kanji) must also pass without false positive
    const shortHeader = '2026年 製品仕様一覧・実測比較表';
    expect(detectLocaleLeakage(shortHeader, 'ja-JP').leaked).toBe(false);

    // Allowed Chinese brand name embedded in Japanese prose passes cleanly
    const withAllowedBrand =
      '星辰存储の最新ストレージ製品は、日本市場向けに高い信頼性と省電力性能を実現しています。';
    expect(detectLocaleLeakage(withAllowedBrand, 'ja-JP', ['星辰存储']).leaked).toBe(false);
  });

  it('catches Simplified Chinese leakage and Kana-less Chinese paragraphs inside ja-JP', () => {
    const mixedSimplified = '製品仕様のまとめ：这里混入了简体中文评测结论，请尽快修改后再发布。';
    const scLeak = detectLocaleLeakage(mixedSimplified, 'ja-JP');
    expect(scLeak.leaked).toBe(true);
    expect(scLeak.reason).toBe('JA_SIMPLIFIED_CHINESE_LEAK');
    expect(scLeak.samples.length).toBeGreaterThan(0);

    // Long Traditional Chinese paragraph (no Simplified-only chars, 0 Kana, >= 24 Hanzi)
    const traditionalChineseOnly =
      '本產品採用高效能無刷馬達與多層精密濾網設計，經過第三方實驗室連續運轉測試與嚴格品質檢驗，適合家庭日常清潔維護使用。';
    const missingKana = detectLocaleLeakage(traditionalChineseOnly, 'ja-JP');
    expect(missingKana.leaked).toBe(true);
    expect(missingKana.reason).toBe('JA_MISSING_KANA');
    expect(missingKana.samples.length).toBeGreaterThan(0);

    // 100+ Hanzi Chinese paragraph with 1 stray Katakana still triggers JA_MISSING_KANA
    const strayKatakanaChinese =
      '本產品採用高效能無刷馬達與多層精密濾網設計，經過第三方實驗室連續運轉測試與嚴格品質檢驗，適合家庭日常清潔維護使用。本產品同時具備低噪音運轉模式、可拆洗濾芯結構、長時間穩定輸出能力、完善售後保固支援與安全認證標準，全面滿足居家環境需求ア。';
    const strayResult = detectLocaleLeakage(strayKatakanaChinese, 'ja-JP');
    expect(strayResult.leaked).toBe(true);
    expect(strayResult.reason).toBe('JA_MISSING_KANA');
  });

  it('allows standalone Kanji-heavy Japanese spec and pricing tables without JA_MISSING_KANA false positives', () => {
    // ~82 Kanji + 6 Kana (2 Hiragana より + 4 Katakana ケーブル => ~6.8% Kana)
    const jpSpecTable =
      '製品型番：AV-4000｜本体寸法：幅210×奥行230×高165mm｜本体質量：約3.2kg｜電源仕様：AC100V 50/60Hz｜最大消費電力：42W｜待機時消費電力：11W｜静音性能：通常運転28dB｜動作環境温度：5℃より40℃｜対応容量：最大80TB｜有線通信規格：2.5GbE×2｜付属部品：電源ケーブル、取扱説明書、保証書、固定用ネジ一式｜標準保証期間：3年間国内無償修理対応｜安全規格：電気用品安全法適合、国内正規認証取得済';
    const specResult = detectLocaleLeakage(jpSpecTable, 'ja-JP');
    expect(specResult.leaked).toBe(false);
    expect(specResult.reason).toBeNull();

    // ~72 Kanji + 3 Katakana (プラン => ~4.0% Kana, 0 Hiragana)
    const jpPricingTable =
      '料金プラン比較表｜個人利用版：月額1,980円｜法人標準版：月額9,800円｜大規模導入版：月額29,800円｜初期設定費用：無料｜最低契約期間：12ヶ月｜支払方法：銀行振込、請求書発行対応｜導入支援体制：専任担当者配置、運用設計相談、定期保守点検、障害復旧対応、年間稼働率保証、国内拠点電話窓口、営業日当日回答保証';
    const pricingResult = detectLocaleLeakage(jpPricingTable, 'ja-JP');
    expect(pricingResult.leaked).toBe(false);
    expect(pricingResult.reason).toBeNull();
  });

  it('blocks non-brand CJK in all Latin locales while allowing native European diacritics and brand names', () => {
    const cleanGerman =
      'Größter Vorteil im Praxistest: Überzeugende Helligkeit, niedrige Geräuschentwicklung und klare Maßstäbe.';
    expect(detectLocaleLeakage(cleanGerman, 'de-DE').leaked).toBe(false);

    const cleanSpanish =
      'Análisis técnico completo: comparación de rendimiento, diseño compacto y relación calidad-precio en España.';
    expect(detectLocaleLeakage(cleanSpanish, 'es-ES').leaked).toBe(false);

    const cleanFrench =
      'Guide comparatif détaillé : performances mesurées, efficacité énergétique et critères de sélection français.';
    expect(detectLocaleLeakage(cleanFrench, 'fr-FR').leaked).toBe(false);

    for (const locale of ['en-US', 'en-GB', 'de-DE', 'es-ES', 'fr-FR'] as const) {
      const leaked = detectLocaleLeakage('Verified benchmark guide 混合中文说明', locale);
      expect(leaked.leaked).toBe(true);
      expect(leaked.reason).toBe('LATIN_CJK_LEAK');
      expect(leaked.samples).toContain('混合中文说明');

      const brandOnly = detectLocaleLeakage('Verified benchmark guide for 极米Pro', locale, [
        '极米Pro',
      ]);
      expect(brandOnly.leaked).toBe(false);
    }

    // zh-CN allows Chinese freely
    expect(detectLocaleLeakage('中文评测与参数对比指南', 'zh-CN').leaked).toBe(false);
  });

  it('returns distinct localized writing directives for every supported locale', () => {
    const faqHeadings = new Set<string>();
    for (const code of SUPPORTED_LOCALE_CODES) {
      const directive = resolveLocaleWritingDirective(code);
      expect(directive.locale).toBe(code);
      expect(directive.htmlLang).toBe(code);
      expect(directive.writingLanguageInstruction.length).toBeGreaterThan(20);
      expect(directive.complianceInstruction.length).toBeGreaterThan(20);
      expect(directive.faqHeading.length).toBeGreaterThan(5);
      faqHeadings.add(directive.faqHeading);
    }
    // en-US & en-GB share English FAQ heading, remaining 5 locales have distinct headings
    expect(faqHeadings.size).toBeGreaterThanOrEqual(6);
  });
});
