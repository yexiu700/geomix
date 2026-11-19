'use client';

import type { MediaAssetRecord } from '@geomix/shared';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useState } from 'react';
import type { ArticleFormOptions, ArticleManageGateway } from '../../lib/articles';
import {
  buildDefaultCreateDraft,
  type ArticleEditorDraft,
  type EditorModalState,
} from './article-manage-helpers';

export type UseArticleEditorControllerOptions = {
  client: Pick<ArticleManageGateway, 'detail' | 'listGalleryAssets'>;
  readOnly: boolean;
  formOptions: ArticleFormOptions | null;
  refreshFormOptions: () => Promise<ArticleFormOptions | null>;
  onLoadError: (message: string) => void;
};

export type ArticleEditorController = {
  editor: EditorModalState | null;
  setEditor: Dispatch<SetStateAction<EditorModalState | null>>;
  editorLoading: boolean;
  formError: string | null;
  setFormError: Dispatch<SetStateAction<string | null>>;
  galleryAssets: MediaAssetRecord[];
  setGalleryAssets: Dispatch<SetStateAction<MediaAssetRecord[]>>;
  galleryLoading: boolean;
  loadAssetsForMediaCategory: (mediaCategoryId: string, autoPickCover: boolean) => Promise<void>;
  openCreateModal: () => Promise<void>;
  openEditModal: (articleId: string) => Promise<void>;
};

function freshEditorState(
  mode: EditorModalState['mode'],
  initial: ArticleEditorDraft,
  articleId?: string,
): EditorModalState {
  return {
    mode,
    ...(articleId ? { articleId } : {}),
    initial,
    draft: initial,
    minimized: false,
    maximized: false,
    editorTab: 'visual',
  };
}

/**
 * 文章编辑弹窗的打开流程与共享状态（草稿、加载态、图库候选），
 * 供列表容器触发打开、并供 `<ArticleEditorModal>` 渲染与编辑。
 */
export function useArticleEditorController({
  client,
  readOnly,
  formOptions,
  refreshFormOptions,
  onLoadError,
}: UseArticleEditorControllerOptions): ArticleEditorController {
  const [editor, setEditor] = useState<EditorModalState | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [galleryAssets, setGalleryAssets] = useState<MediaAssetRecord[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

  const loadAssetsForMediaCategory = useCallback(
    async (mediaCategoryId: string, autoPickCover: boolean) => {
      if (!mediaCategoryId) {
        setGalleryAssets([]);
        return;
      }
      setGalleryLoading(true);
      try {
        const assets = await client.listGalleryAssets(mediaCategoryId);
        setGalleryAssets(assets);
        if (autoPickCover && assets[0]) {
          setEditor((cur) =>
            cur
              ? {
                  ...cur,
                  draft: {
                    ...cur.draft,
                    coverUrl: assets[0]?.url ?? cur.draft.coverUrl,
                  },
                }
              : cur,
          );
        }
      } catch {
        setGalleryAssets([]);
      } finally {
        setGalleryLoading(false);
      }
    },
    [client],
  );

  const openCreateModal = useCallback(async () => {
    if (readOnly) return;
    setFormError(null);
    setEditorLoading(true);
    try {
      const opts = (await refreshFormOptions()) ?? formOptions;
      const initial = buildDefaultCreateDraft(opts);
      setEditor(freshEditorState('create', initial));
      if (initial.mediaCategoryId) {
        await loadAssetsForMediaCategory(initial.mediaCategoryId, !initial.coverUrl);
      } else {
        setGalleryAssets([]);
      }
    } finally {
      setEditorLoading(false);
    }
  }, [formOptions, loadAssetsForMediaCategory, readOnly, refreshFormOptions]);

  const openEditModal = useCallback(
    async (articleId: string) => {
      if (readOnly) return;
      setFormError(null);
      setEditorLoading(true);
      try {
        const [detail, opts] = await Promise.all([client.detail(articleId), refreshFormOptions()]);
        const resolvedOptions = opts ?? formOptions;
        const defaultMediaCatId = resolvedOptions?.mediaCategories[0]?.id ?? '';
        const initial: ArticleEditorDraft = {
          title: detail.title,
          categoryId: detail.categoryId ?? resolvedOptions?.categories[0]?.id ?? '',
          mediaCategoryId: defaultMediaCatId,
          coverUrl: detail.coverUrl,
          status: detail.status,
          contentHtml: detail.contentHtml || '<p></p>',
        };
        setEditor(freshEditorState('edit', initial, detail.id));
        if (defaultMediaCatId) {
          await loadAssetsForMediaCategory(defaultMediaCatId, false);
        } else {
          setGalleryAssets([]);
        }
      } catch (err: unknown) {
        onLoadError(err instanceof Error ? err.message : '读取文章详情失败');
      } finally {
        setEditorLoading(false);
      }
    },
    [client, formOptions, loadAssetsForMediaCategory, onLoadError, readOnly, refreshFormOptions],
  );

  return {
    editor,
    setEditor,
    editorLoading,
    formError,
    setFormError,
    galleryAssets,
    setGalleryAssets,
    galleryLoading,
    loadAssetsForMediaCategory,
    openCreateModal,
    openEditModal,
  };
}
