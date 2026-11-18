// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GALLERY_CATEGORY_EMPTY_MSG,
  GALLERY_FILE_TOO_LARGE_MSG,
  IMAGE_MAX_INPUT_BYTES,
  buildStorageSummary,
  type MediaAssetRecord,
  type MediaCategoryRecord,
} from '@geomix/shared';
import type { GalleryGateway } from '../../lib/gallery';
import type { ShellAction } from '../../lib/tab-stack';
import { GalleryAssetScreen, GalleryCategoryScreen } from './gallery-screen';

function clickBtn(pattern: RegExp | string, index = 0): void {
  const buttons = Array.from(document.querySelectorAll('button'));
  const matches = buttons.filter((btn) => {
    const label = btn.getAttribute('aria-label') ?? '';
    const text = (btn.textContent ?? '').replace(/\s+/g, '');
    if (typeof pattern === 'string') {
      const needle = pattern.replace(/\s+/g, '');
      return label === pattern || text.includes(needle);
    }
    return pattern.test(label) || pattern.test(text);
  });
  const target = matches[index];
  if (!target) {
    throw new Error(`Button not found: ${String(pattern)}`);
  }
  fireEvent.click(target);
}

function makeGateway(overrides: Partial<GalleryGateway> = {}): GalleryGateway {
  const storage = buildStorageSummary(256n * 1024n, 100n * 1024n * 1024n);
  const sampleCategories: MediaCategoryRecord[] = [
    {
      id: 'cat_1',
      name: '车间实拍',
      type: 1,
      assetCount: 4,
      previewAssets: [
        {
          id: 'med_1',
          url: '/api/v1/media-assets/med_1/file',
          thumbUrl: '/api/v1/media-assets/med_1/thumb',
          width: 1200,
          height: 800,
        },
        {
          id: 'med_2',
          url: '/api/v1/media-assets/med_2/file',
          thumbUrl: '/api/v1/media-assets/med_2/thumb',
          width: 1200,
          height: 800,
        },
        {
          id: 'med_3',
          url: '/api/v1/media-assets/med_3/file',
          thumbUrl: '/api/v1/media-assets/med_3/thumb',
          width: 1200,
          height: 800,
        },
      ],
      createdAt: '2026-11-17T04:00:00.000Z',
    },
  ];

  const sampleAssets: MediaAssetRecord[] = [
    {
      id: 'med_1',
      categoryId: 'cat_1',
      categoryName: '车间实拍',
      origin: 'UPLOAD',
      objectKey: 'tenants/t1/media-med_1.jpg',
      url: '/api/v1/media-assets/med_1/file',
      thumbUrl: '/api/v1/media-assets/med_1/thumb',
      width: 1200,
      height: 800,
      bytes: 65536,
      mime: 'image/jpeg',
      usedCount: 2,
      createdAt: '2026-11-17T04:00:00.000Z',
    },
  ];

  return {
    listCategories: vi.fn(async () => ({
      items: sampleCategories,
      total: 1,
      page: 1,
      pageSize: 10,
      storage,
    })),
    createCategory: vi.fn(async ({ name }) => ({
      id: 'cat_new',
      name,
      type: 1,
      assetCount: 0,
      previewAssets: [],
      createdAt: '2026-11-17T04:10:00.000Z',
    })),
    updateCategory: vi.fn(async (id, { name }) => ({
      id,
      name,
      type: 1,
      assetCount: 4,
      previewAssets: sampleCategories[0]!.previewAssets,
      createdAt: '2026-11-17T04:00:00.000Z',
    })),
    deleteCategories: vi.fn(async () => ({ deleted: 1 })),
    downloadCategories: vi.fn(async () => ({
      filename: 'media-categories.csv',
      mime: 'text/csv',
      body: new Uint8Array([1, 2]),
    })),
    listAssets: vi.fn(async () => ({
      category: { id: 'cat_1', name: '车间实拍' },
      items: sampleAssets,
      total: 1,
      page: 1,
      pageSize: 10,
      storage,
    })),
    uploadAssets: vi.fn(async (_categoryId: string, files: File[]) => ({
      items: files.map((f: File, idx: number) => ({
        asset: {
          id: `med_up_${idx}`,
          categoryId: 'cat_1',
          categoryName: '车间实拍',
          origin: 'UPLOAD' as const,
          objectKey: `tenants/t1/media-up-${idx}.jpg`,
          url: `/api/v1/media-assets/med_up_${idx}/file`,
          thumbUrl: `/api/v1/media-assets/med_up_${idx}/thumb`,
          width: 360,
          height: 260,
          bytes: 24576,
          mime: 'image/jpeg',
          usedCount: 0,
          createdAt: '2026-11-17T04:15:00.000Z',
        },
        warning: `${f.name}：图片宽度 360px 小于建议值 500px（仅提示，已完成上传）`,
      })),
      warnings: ['small.png：图片宽度 360px 小于建议值 500px（仅提示，已完成上传）'],
      storage,
    })),
    deleteAssets: vi.fn(async () => ({ deleted: 1, releasedBytes: 65536 })),
    downloadAssets: vi.fn(async () => ({
      filename: 'media-assets.csv',
      mime: 'text/csv',
      body: new Uint8Array([1, 2]),
    })),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('GalleryCategoryScreen & GalleryAssetScreen', () => {
  it('renders 3 preview thumbnails, storage usage, single-field category validation, and opens /material/gallery/:id in new tab', async () => {
    const dispatched: ShellAction[] = [];
    const gateway = makeGateway();

    render(
      <GalleryCategoryScreen
        title="企业画像图库"
        tabId="/material/gallery"
        onDispatch={(a) => dispatched.push(a)}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('车间实拍')).toBeTruthy();
    });

    // Shows used storage & 3 thumbnails
    expect(screen.getByText(/已用 256 KB \/ 上限 100 MB/)).toBeTruthy();
    expect(screen.getByTestId('cat-thumb-med_1')).toBeTruthy();
    expect(screen.getByTestId('cat-thumb-med_2')).toBeTruthy();
    expect(screen.getByTestId('cat-thumb-med_3')).toBeTruthy();

    // Open add modal -> empty submit blocked -> valid submit calls createCategory
    clickBtn('添加');
    clickBtn('确定');
    expect(screen.getByText(GALLERY_CATEGORY_EMPTY_MSG)).toBeTruthy();
    expect(gateway.createCategory).not.toHaveBeenCalled();

    const input = document.querySelector('[aria-label="分类"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '产品细节图' } });
    clickBtn('确定');
    await waitFor(() => {
      expect(gateway.createCategory).toHaveBeenCalledWith({ name: '产品细节图' });
    });

    // Clicking 图片列表 opens subpage tab
    clickBtn('图片列表', 0);
    expect(dispatched).toContainEqual({
      type: 'open',
      href: '/material/gallery/cat_1',
      sourceId: '/material/gallery',
    });
  });

  it('rejects >100MB file selection, surfaces <500px warning without blocking multi-upload, has delete-only row action, and dispatches back', async () => {
    const dispatched: ShellAction[] = [];
    const gateway = makeGateway();

    render(
      <GalleryAssetScreen
        title="企业画像图库 · cat_1"
        tabId="/material/gallery/cat_1"
        categoryId="cat_1"
        onDispatch={(a) => dispatched.push(a)}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('图片列表 · 车间实拍')).toBeTruthy();
    });

    // Row actions have 删除 and NO 编辑 button
    expect(screen.queryByText('编辑')).toBeNull();

    // Open upload modal -> select >100MB file -> rejected with 100MB message
    clickBtn('添加');
    const fileInput = document.querySelector('[aria-label="选择图片文件"]') as HTMLInputElement;
    const hugeFile = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(hugeFile, 'size', { value: IMAGE_MAX_INPUT_BYTES + 10 });
    fireEvent.change(fileInput, { target: { files: [hugeFile] } });
    expect(screen.getByText(`huge.jpg：${GALLERY_FILE_TOO_LARGE_MSG}`)).toBeTruthy();
    expect(gateway.uploadAssets).not.toHaveBeenCalled();

    // Select 2 valid files -> upload succeeds and shows <500px warning banner
    const smallFile1 = new File(['a'], 'small.png', { type: 'image/png' });
    const smallFile2 = new File(['b'], 'ok.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [smallFile1, smallFile2] } });
    clickBtn('确定');

    await waitFor(() => {
      expect(gateway.uploadAssets).toHaveBeenCalledTimes(1);
      expect(screen.getByText('图片清晰度提示（不影响使用）')).toBeTruthy();
    });

    // 返回上一级 dispatches back
    clickBtn('关闭');
    clickBtn('返回上一级');
    expect(dispatched).toContainEqual({ type: 'back', id: '/material/gallery/cat_1' });
  });

  it('auto-refreshes category assetCount, 3 preview thumbnails, and storage quota after uploading in child tab and returning (#71)', async () => {
    let uploaded = false;
    const initialStorage = buildStorageSummary(0n, 100n * 1024n * 1024n);
    const updatedStorage = buildStorageSummary(512n * 1024n, 100n * 1024n * 1024n);

    const gateway = makeGateway({
      listCategories: vi.fn(async () => ({
        items: [
          {
            id: 'cat_empty',
            name: '精密注塑车间实拍图库',
            type: 1,
            assetCount: uploaded ? 3 : 0,
            previewAssets: uploaded
              ? [1, 2, 3].map((idx) => ({
                  id: `med_new_${idx}`,
                  url: `/api/v1/media-assets/med_new_${idx}/file`,
                  thumbUrl: `/api/v1/media-assets/med_new_${idx}/thumb`,
                  width: 1200,
                  height: 800,
                }))
              : [],
            createdAt: '2026-11-17T04:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
        storage: uploaded ? updatedStorage : initialStorage,
      })),
      uploadAssets: vi.fn(async (_categoryId: string, files: File[]) => {
        uploaded = true;
        return {
          items: files.map((_f, idx) => ({
            asset: {
              id: `med_new_${idx + 1}`,
              categoryId: 'cat_empty',
              categoryName: '精密注塑车间实拍图库',
              origin: 'UPLOAD' as const,
              objectKey: `tenants/t1/med_new_${idx + 1}.jpg`,
              url: `/api/v1/media-assets/med_new_${idx + 1}/file`,
              thumbUrl: `/api/v1/media-assets/med_new_${idx + 1}/thumb`,
              width: 1200,
              height: 800,
              bytes: 170000,
              mime: 'image/jpeg',
              usedCount: 0,
              createdAt: '2026-11-17T04:20:00.000Z',
            },
            warning: undefined,
          })),
          warnings: [],
          storage: updatedStorage,
        };
      }),
    });

    const { rerender } = render(
      <div>
        <div hidden>
          <GalleryCategoryScreen
            title="企业画像图库"
            tabId="/material/gallery"
            active={false}
            onDispatch={vi.fn()}
            gateway={gateway}
          />
        </div>
        <div>
          <GalleryAssetScreen
            title="企业画像图库 · cat_empty"
            tabId="/material/gallery/cat_empty"
            categoryId="cat_empty"
            onDispatch={vi.fn()}
            gateway={gateway}
          />
        </div>
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('精密注塑车间实拍图库')).toBeTruthy();
    });
    expect(screen.queryByTestId('cat-thumb-med_new_1')).toBeNull();

    // Upload 3 images in child tab
    const addButtons = Array.from(document.querySelectorAll('button')).filter(
      (b) => (b.textContent ?? '').replace(/\s+/g, '') === '添加',
    );
    fireEvent.click(addButtons[addButtons.length - 1]!);

    const fileInput = document.querySelector('[aria-label="选择图片文件"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['1'], 'a.jpg', { type: 'image/jpeg' }),
          new File(['2'], 'b.jpg', { type: 'image/jpeg' }),
          new File(['3'], 'c.jpg', { type: 'image/jpeg' }),
        ],
      },
    });
    clickBtn('确定');

    await waitFor(() => {
      expect(gateway.uploadAssets).toHaveBeenCalledTimes(1);
    });

    // Simulate returning to parent tab (active false -> true, child tab closed) without manual 刷新
    rerender(
      <div>
        <div>
          <GalleryCategoryScreen
            title="企业画像图库"
            tabId="/material/gallery"
            active={true}
            onDispatch={vi.fn()}
            gateway={gateway}
          />
        </div>
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cat-thumb-med_new_1')).toBeTruthy();
      expect(screen.getByTestId('cat-thumb-med_new_2')).toBeTruthy();
      expect(screen.getByTestId('cat-thumb-med_new_3')).toBeTruthy();
      expect(screen.getByText(/已用 512 KB \/ 上限 100 MB/)).toBeTruthy();
    });
  });

  it('renders only one 图片列表 button per category row and accurate route copy (#145)', async () => {
    const gateway = makeGateway({
      listCategories: vi.fn(async () => ({
        items: [
          {
            id: 'cat_empty_1',
            name: '空素材分类',
            type: 1,
            assetCount: 0,
            previewAssets: [],
            createdAt: '2026-11-17T04:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
        storage: buildStorageSummary(0n, 100n * 1024n * 1024n),
      })),
    });

    render(
      <GalleryCategoryScreen
        title="企业画像图库"
        tabId="/material/gallery"
        onDispatch={vi.fn()}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('空素材分类')).toBeTruthy();
    });

    const row = document.querySelector('tbody tr') as HTMLTableRowElement;
    const listButtonsInRow = Array.from(row.querySelectorAll('button')).filter(
      (b) => (b.textContent ?? '').replace(/\s+/g, '') === '图片列表',
    );
    expect(listButtonsInRow).toHaveLength(1);
    expect(screen.getByText('暂无图片')).toBeTruthy();
    expect(screen.queryByText(/在新标签打开/)).toBeNull();
  });

  it('switches progress to exception state with retry on upload error, supports dropzone, and warns <500px before submit (#138)', async () => {
    let attempt = 0;
    const closeBitmap = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 320, height: 240, close: closeBitmap })),
    );

    const gateway = makeGateway({
      uploadAssets: vi.fn(
        async (_categoryId: string, files: File[], onProgress?: (percent: number) => void) => {
          attempt += 1;
          onProgress?.(90);
          if (attempt === 1) {
            throw new Error('图片解码失败，请确认文件未损坏');
          }
          onProgress?.(100);
          return {
            items: files.map((f, idx) => ({
              asset: {
                id: `med_retry_${idx}`,
                categoryId: 'cat_1',
                categoryName: '车间实拍',
                origin: 'UPLOAD' as const,
                objectKey: `tenants/t1/media-retry-${idx}.jpg`,
                originalName: f.name,
                displayName: f.name,
                url: `/api/v1/media-assets/med_retry_${idx}/file`,
                thumbUrl: `/api/v1/media-assets/med_retry_${idx}/thumb`,
                width: 320,
                height: 240,
                bytes: 12000,
                mime: 'image/png',
                usedCount: 0,
                createdAt: '2026-11-18T02:00:00.000Z',
              },
              originalName: f.name,
            })),
            warnings: [],
            storage: buildStorageSummary(12000n, 100n * 1024n * 1024n),
          };
        },
      ),
    });

    render(
      <GalleryAssetScreen
        title="企业画像图库 · cat_1"
        tabId="/material/gallery/cat_1"
        categoryId="cat_1"
        onDispatch={vi.fn()}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('图片列表 · 车间实拍')).toBeTruthy();
    });

    clickBtn('添加');
    const dropzone = screen.getByTestId('gallery-upload-dropzone');
    const smallFile = new File(['x'], 'tiny-device.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [smallFile] } });

    await waitFor(() => {
      expect(screen.getByText('上传前清晰度提示（仅提示，不影响上传）')).toBeTruthy();
      expect(screen.getByText(/320px 小于建议值 500px/)).toBeTruthy();
    });

    clickBtn('确定');

    await waitFor(() => {
      expect(screen.getByText('图片上传失败')).toBeTruthy();
      expect(screen.getByText('图片解码失败，请确认文件未损坏')).toBeTruthy();
      expect(document.querySelector('.ant-progress-status-exception')).toBeTruthy();
    });

    clickBtn('重新上传');

    await waitFor(() => {
      expect(gateway.uploadAssets).toHaveBeenCalledTimes(2);
      expect(screen.getByText('最近上传成功（1 张）：')).toBeTruthy();
      expect(screen.getByLabelText('完成').tagName).toBe('BUTTON');
    });

    vi.unstubAllGlobals();
  });

  it('unlocks upload CTA immediately at 100% before background reload finishes and never leaks objectKey (#204)', async () => {
    let listCalls = 0;
    let resolveReload: (() => void) | null = null;
    const storage = buildStorageSummary(65536n, 100n * 1024n * 1024n);

    const gateway = makeGateway({
      listAssets: vi.fn(async () => {
        listCalls += 1;
        if (listCalls > 1) {
          await new Promise<void>((resolve) => {
            resolveReload = resolve;
          });
        }
        return {
          category: { id: 'cat_1', name: '车间实拍' },
          items: [
            {
              id: 'med_1',
              categoryId: 'cat_1',
              categoryName: '车间实拍',
              origin: 'UPLOAD' as const,
              objectKey: 'tenants/seed_tenant_platform/media-secret.jpg',
              originalName: '车间主机实拍.png',
              displayName: '车间主机实拍.png',
              url: '/api/v1/media-assets/med_1/file',
              thumbUrl: '/api/v1/media-assets/med_1/thumb',
              width: 1200,
              height: 800,
              bytes: 65536,
              mime: 'image/jpeg',
              usedCount: 2,
              createdAt: '2026-11-17T04:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 10,
          storage,
        };
      }),
      uploadAssets: vi.fn(
        async (_categoryId: string, files: File[], onProgress?: (percent: number) => void) => {
          onProgress?.(100);
          return {
            items: files.map((f, idx) => ({
              asset: {
                id: `med_ok_${idx}`,
                categoryId: 'cat_1',
                categoryName: '车间实拍',
                origin: 'UPLOAD' as const,
                objectKey: `tenants/seed_tenant_platform/media-ok-${idx}.jpg`,
                originalName: f.name,
                displayName: f.name,
                url: `/api/v1/media-assets/med_ok_${idx}/file`,
                thumbUrl: `/api/v1/media-assets/med_ok_${idx}/thumb`,
                width: 800,
                height: 600,
                bytes: 24576,
                mime: 'image/jpeg',
                usedCount: 0,
                createdAt: '2026-11-18T02:10:00.000Z',
              },
              originalName: f.name,
            })),
            warnings: [],
            storage,
          };
        },
      ),
    });

    render(
      <GalleryAssetScreen
        title="企业画像图库 · cat_1"
        tabId="/material/gallery/cat_1"
        categoryId="cat_1"
        onDispatch={vi.fn()}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('车间主机实拍.png')).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain('tenants/');
    expect(document.body.innerHTML).not.toContain('media-secret.jpg');

    clickBtn('添加');
    const fileInput = document.querySelector('[aria-label="选择图片文件"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['img'], 'laser-bench.png', { type: 'image/png' })] },
    });
    clickBtn('确定');

    // Even before background reload resolves, modal switches to 完成 without spinning 确定
    await waitFor(() => {
      expect(screen.getByText('最近上传成功（1 张）：')).toBeTruthy();
      expect(screen.getByText('laser-bench.png')).toBeTruthy();
      expect(screen.getByLabelText('完成').tagName).toBe('BUTTON');
    });
    expect(document.body.textContent).not.toContain('tenants/');
    expect(document.body.innerHTML).not.toContain('media-ok-0.jpg');
    expect(document.querySelector('.gm-crud-footer .ant-btn-loading')).toBeNull();

    // Ensure Playwright substring matching for '关闭' resolves to only the header close button
    const closeMatches = Array.from(document.querySelectorAll('button')).filter(
      (btn) =>
        (btn.getAttribute('aria-label') ?? '').includes('关闭') ||
        (btn.textContent ?? '').includes('关闭'),
    );
    expect(closeMatches).toHaveLength(1);

    clickBtn('完成');
    await waitFor(() => {
      expect(screen.queryByLabelText('添加图片素材')).toBeNull();
    });

    (resolveReload as (() => void) | null)?.();
  });

  it('enforces create-first toolbar, link action buttons, required * markers, [取消, 重置, 确定] footer order, and ESC close (#141)', async () => {
    const gateway = makeGateway();
    const catView = render(
      <GalleryCategoryScreen
        title="企业画像图库"
        tabId="/material/gallery"
        onDispatch={vi.fn()}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('车间实拍')).toBeTruthy();
    });

    // Toolbar order: 添加 before 刷新 before 删除
    const catToolbarBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((b) => (b.textContent ?? '').replace(/\s+/g, ''));
    expect(catToolbarBtns.slice(0, 3)).toEqual(['添加', '刷新', '删除']);

    // Action column buttons are uniform ant-btn-link ant-btn-sm
    const catRowBtns = Array.from(document.querySelectorAll('tbody td:last-child button'));
    expect(catRowBtns.map((b) => (b.textContent ?? '').replace(/\s+/g, ''))).toEqual([
      '图片列表',
      '编辑',
      '删除',
    ]);
    for (const btn of catRowBtns) {
      expect(btn.classList.contains('ant-btn-link')).toBe(true);
      expect(btn.classList.contains('ant-btn-sm')).toBe(true);
    }

    // Category modal: required *, [取消, 重置, 确定] order, and ESC closes modal
    clickBtn('添加');
    const catDialog = screen.getByRole('dialog', { name: '添加素材分类' });
    const catLabel = catDialog.querySelector('label[for="gallery-category-input"]') as HTMLElement;
    expect(catLabel).toBeTruthy();
    expect(catLabel.textContent).toContain('*');
    expect(catLabel.style.display).toBe('block');

    const catFooterBtns = Array.from(catDialog.querySelectorAll('.gm-crud-footer button')).map(
      (b) => (b.textContent ?? '').replace(/\s+/g, ''),
    );
    expect(catFooterBtns).toEqual(['取消', '重置', '确定']);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '添加素材分类' })).toBeNull();
    });

    catView.unmount();

    // Asset screen: toolbar, link action button, required *, footer order, and ESC close
    render(
      <GalleryAssetScreen
        title="企业画像图库 · cat_1"
        tabId="/material/gallery/cat_1"
        categoryId="cat_1"
        onDispatch={vi.fn()}
        gateway={gateway}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('图片列表 · 车间实拍')).toBeTruthy();
    });

    const assetToolbarBtns = Array.from(
      document.querySelectorAll('.gm-crud-toolbar > .ant-space:first-child button'),
    ).map((b) => (b.textContent ?? '').replace(/\s+/g, ''));
    expect(assetToolbarBtns.slice(0, 3)).toEqual(['添加', '刷新', '删除']);

    const assetRowBtns = Array.from(document.querySelectorAll('tbody td:last-child button'));
    expect(assetRowBtns).toHaveLength(1);
    expect(assetRowBtns[0]?.classList.contains('ant-btn-link')).toBe(true);

    clickBtn('添加');
    const uploadDialog = screen.getByRole('dialog', { name: '添加图片素材' });
    expect(uploadDialog.textContent).toContain('* 图片文件');
    const uploadFooterBtns = Array.from(
      uploadDialog.querySelectorAll('.gm-crud-footer button'),
    ).map((b) => (b.textContent ?? '').replace(/\s+/g, ''));
    expect(uploadFooterBtns).toEqual(['取消', '重置', '确定']);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '添加图片素材' })).toBeNull();
    });
  });
});
