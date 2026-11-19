import {
  AI_IMAGE_DEFAULT_RATIO,
  AI_IMAGE_PROMPT_MAX,
  AI_IMAGE_PROMPT_MIN,
  AI_IMAGE_STYLES,
  type AiImageJobItem,
  type MediaAssetRecord,
  type TaskStatusName,
} from '@geomix/shared';
import { describe, expect, it } from 'vitest';
import {
  ALL_COLUMN_KEYS,
  buildCreatePayload,
  buildInitialDraft,
  isJobInProgress,
  isJobSavedToGallery,
  resolveGalleryAssetLabel,
  statusTagColor,
  validateCreateDraft,
} from './ai-image-helpers';

function makeJob(overrides: Partial<AiImageJobItem> = {}): AiImageJobItem {
  return {
    id: 'img_1',
    orderNo: 'IMG-1',
    prompt: '现代极简商业办公空间',
    style: '商务科技',
    ratio: '16:9',
    count: 1,
    successCount: 1,
    refAssetId: null,
    saveCategoryId: null,
    saveCategoryName: null,
    status: 'COMPLETED',
    error: null,
    model: 'fake-image',
    unitPoints: 5,
    reservedPoints: 5,
    settledPoints: 5,
    releasedPoints: 0,
    createdAt: '2026-11-17T08:30:00.000Z',
    assets: [
      {
        id: 'med_1',
        categoryId: null,
        categoryName: null,
        url: '/file',
        thumbUrl: '/thumb',
        width: 1280,
        height: 720,
        bytes: 42000,
        usedCount: 0,
        createdAt: '2026-11-17T08:30:02.000Z',
      },
    ],
    ...overrides,
  };
}

function makeAsset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: 'med_mwlsapy3d4cb6885bd68',
    categoryId: 'mcat_01',
    categoryName: '产品实景图库',
    origin: 'UPLOAD',
    objectKey: 't1/prod-1.jpg',
    originalName: '桌面充电器实拍.jpg',
    url: '/file',
    thumbUrl: '/thumb',
    width: 800,
    height: 600,
    bytes: 32000,
    mime: 'image/jpeg',
    usedCount: 0,
    createdAt: '2026-11-17T02:00:00.000Z',
    ...overrides,
  };
}

describe('ai-image-helpers', () => {
  it('buildInitialDraft returns default ratio/style, 1 张 and no reference image (#94)', () => {
    const draft = buildInitialDraft();
    expect(draft).toEqual({
      prompt: '',
      ratio: AI_IMAGE_DEFAULT_RATIO,
      style: AI_IMAGE_STYLES[0],
      count: 1,
      refMode: 'none',
      refAssetId: '',
      refImageBase64: '',
      refImageFilename: '',
      saveCategoryId: '',
      optKeywordId: '',
      optKbId: '',
    });
    // 每次返回新对象，避免草稿间共享引用
    expect(buildInitialDraft()).not.toBe(draft);
  });

  it('isJobSavedToGallery detects job-level or asset-level gallery category', () => {
    expect(isJobSavedToGallery(makeJob())).toBe(false);
    expect(isJobSavedToGallery(makeJob({ saveCategoryId: 'mcat_01' }))).toBe(true);
    expect(isJobSavedToGallery(makeJob({ saveCategoryName: '产品实景图库' }))).toBe(true);
    const base = makeJob();
    expect(
      isJobSavedToGallery(
        makeJob({ assets: [{ ...base.assets[0]!, categoryName: '办公场景图库' }] }),
      ),
    ).toBe(true);
    expect(isJobSavedToGallery(makeJob({ assets: [] }))).toBe(false);
  });

  it('statusTagColor maps every task status to an antd Tag color', () => {
    const expected: Record<TaskStatusName, string> = {
      QUEUED: 'blue',
      RUNNING: 'processing',
      COMPLETED: 'success',
      PARTIAL: 'warning',
      FAILED: 'error',
    } as Record<TaskStatusName, string>;
    for (const [status, color] of Object.entries(expected)) {
      expect(statusTagColor(status as TaskStatusName)).toBe(color);
    }
    expect(statusTagColor('UNKNOWN' as TaskStatusName)).toBe('default');
  });

  it('resolveGalleryAssetLabel prefers displayName, then original name, never raw med_ id', () => {
    expect(resolveGalleryAssetLabel(makeAsset({ displayName: '  主图  ' }))).toBe('主图');
    expect(resolveGalleryAssetLabel(makeAsset())).toBe('桌面充电器实拍.jpg');
    const aiLabel = resolveGalleryAssetLabel(
      makeAsset({ id: 'med_office_002', origin: 'AI_IMAGE', originalName: null }),
    );
    expect(aiLabel).toBe('AI生成图片-ce_002.jpg');
    expect(aiLabel).not.toContain('med_office_002');
  });

  it('isJobInProgress is true only for QUEUED / RUNNING', () => {
    expect(isJobInProgress({ status: 'QUEUED' })).toBe(true);
    expect(isJobInProgress({ status: 'RUNNING' })).toBe(true);
    expect(isJobInProgress({ status: 'COMPLETED' })).toBe(false);
    expect(isJobInProgress({ status: 'FAILED' })).toBe(false);
  });

  it('validateCreateDraft prioritizes missing reference image and merges prompt length errors', () => {
    const okPrompt = '极'.repeat(AI_IMAGE_PROMPT_MIN);
    expect(validateCreateDraft({ ...buildInitialDraft(), prompt: okPrompt })).toEqual({
      refError: null,
      modalError: null,
    });
    expect(validateCreateDraft(buildInitialDraft()).modalError).toBe(
      `画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字`,
    );
    expect(
      validateCreateDraft({ ...buildInitialDraft(), prompt: '极'.repeat(AI_IMAGE_PROMPT_MAX + 1) })
        .modalError,
    ).toBe(`画面提示词不能超过 ${AI_IMAGE_PROMPT_MAX} 个字`);

    const gallery = validateCreateDraft({ ...buildInitialDraft(), refMode: 'gallery' });
    expect(gallery.refError).toBe('请从图库中选择一张参考图片');
    expect(gallery.modalError).toBe(
      `请从图库中选择一张参考图片，且画面提示词至少填写 ${AI_IMAGE_PROMPT_MIN} 个字`,
    );
    expect(
      validateCreateDraft({ ...buildInitialDraft(), refMode: 'gallery', prompt: okPrompt }),
    ).toEqual({ refError: '请从图库中选择一张参考图片', modalError: '请从图库中选择一张参考图片' });

    const upload = validateCreateDraft({
      ...buildInitialDraft(),
      refMode: 'upload',
      prompt: okPrompt,
    });
    expect(upload.refError).toBe('请选择需要上传的本地参考图片，或切换为「不使用参考图」');
    expect(upload.modalError).toBe(upload.refError);
  });

  it('buildCreatePayload keeps only the fields relevant to the selected reference mode', () => {
    const draft = {
      ...buildInitialDraft(),
      prompt: '  办公桌面产品陈列  ',
      refAssetId: 'med_1',
      refImageBase64: 'data:image/png;base64,AAA',
      refImageFilename: 'a.png',
      saveCategoryId: 'mcat_01',
    };
    expect(buildCreatePayload({ ...draft, refMode: 'gallery' })).toMatchObject({
      prompt: '办公桌面产品陈列',
      refAssetId: 'med_1',
      refImageBase64: undefined,
      refImageFilename: undefined,
      saveCategoryId: 'mcat_01',
    });
    expect(buildCreatePayload({ ...draft, refMode: 'upload' })).toMatchObject({
      refAssetId: undefined,
      refImageBase64: 'data:image/png;base64,AAA',
      refImageFilename: 'a.png',
    });
    expect(buildCreatePayload({ ...draft, refMode: 'none' })).toMatchObject({
      refAssetId: undefined,
      refImageBase64: undefined,
      refImageFilename: undefined,
    });
  });

  it('ALL_COLUMN_KEYS keeps the 订单编号-first column order', () => {
    expect(ALL_COLUMN_KEYS.map((c) => c.label)).toEqual([
      '订单编号',
      '缩略图',
      '提示词',
      '风格/比例',
      '张数',
      '归属分类',
      '状态',
      '消耗点数',
      '创建时间',
      '操作',
    ]);
  });
});
