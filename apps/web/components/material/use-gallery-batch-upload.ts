'use client';

import { Tag, Typography } from 'antd';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type RefObject,
} from 'react';
import {
  GALLERY_UPLOAD_MAX_FILES,
  checkImageWidthWarning,
  safeMediaDisplayName,
  sanitizeMediaOriginalName,
  validateClientUploadFile,
  type MediaAssetRecord,
  type MediaStorageSummary,
  type MediaUploadResponse,
  type MediaUploadResultItem,
} from '@geomix/shared';
import { readImageDimensions, type GalleryGateway } from '../../lib/gallery';

export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export type PendingUploadItem = {
  key: string;
  file: File;
  width?: number;
  height?: number;
  widthWarning?: string;
};

export type UseGalleryBatchUploadOptions = {
  categoryId: string;
  gateway: Pick<GalleryGateway, 'uploadAssets'>;
  readOnly?: boolean;
  onUploadSuccess?: (res: MediaUploadResponse) => void;
};

export type UseGalleryBatchUploadResult = {
  pendingItems: PendingUploadItem[];
  pendingWidthWarnings: string[];
  uploadError: string | null;
  modalFooterError: string | null;
  uploading: boolean;
  uploadStatus: UploadStatus;
  uploadProgress: number;
  showProgress: boolean;
  progressStatus: 'exception' | 'success' | 'active';
  isUploadComplete: boolean;
  dragActive: boolean;
  lastUploaded: MediaUploadResultItem[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  openFilePicker: () => void;
  appendFiles: (fileList: FileList | readonly File[] | null) => void;
  removePendingItem: (key: string) => void;
  resetUpload: () => void;
  submitUpload: () => Promise<boolean>;
  dropzoneProps: {
    'data-testid': string;
    style: CSSProperties;
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  fileInputProps: {
    'aria-label': string;
    type: 'file';
    multiple: true;
    disabled: boolean;
    accept: string;
    className: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  };
};

export function resolveAssetDisplayName(
  asset: Pick<MediaAssetRecord, 'id' | 'origin' | 'displayName' | 'originalName'>,
  fallbackOriginalName?: string | null,
): string {
  const explicit = asset.displayName?.trim();
  if (explicit) return explicit;
  const original = sanitizeMediaOriginalName(asset.originalName ?? fallbackOriginalName);
  if (original) return original;
  return safeMediaDisplayName({
    id: asset.id,
    origin: asset.origin,
    originalName: asset.originalName ?? fallbackOriginalName,
  });
}

export function StorageQuotaBanner({ storage }: { storage: MediaStorageSummary | null }) {
  if (!storage) return null;
  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
        padding: '8px 12px',
        background: 'var(--gm-bg-elevated)',
        borderRadius: 6,
        border: '1px solid var(--gm-line-1)',
      },
    },
    createElement(Typography.Text, { strong: true }, '图片存储空间：'),
    createElement(
      Tag,
      { color: 'blue', style: { margin: 0 } },
      '已用 ',
      storage.usedText,
      ' / 上限 ',
      storage.limitText,
    ),
  );
}

export function useGalleryBatchUpload({
  categoryId,
  gateway,
  readOnly = false,
  onUploadSuccess,
}: UseGalleryBatchUploadOptions): UseGalleryBatchUploadResult {
  const [pendingItems, setPendingItems] = useState<PendingUploadItem[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [lastUploaded, setLastUploaded] = useState<MediaUploadResultItem[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSeqRef = useRef(0);
  const uploadSessionRef = useRef(0);
  const uploadAttemptRef = useRef(0);
  const uploadingRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingItemsRef = useRef<PendingUploadItem[]>([]);
  const uploadStatusRef = useRef<UploadStatus>('idle');
  const onUploadSuccessRef = useRef(onUploadSuccess);
  onUploadSuccessRef.current = onUploadSuccess;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadSessionRef.current += 1;
      uploadAttemptRef.current += 1;
      uploadingRef.current = false;
    };
  }, []);

  const resetUpload = useCallback(() => {
    uploadSessionRef.current += 1;
    uploadAttemptRef.current += 1;
    uploadingRef.current = false;
    pendingItemsRef.current = [];
    uploadStatusRef.current = 'idle';
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (!mountedRef.current) return;
    setPendingItems([]);
    setUploadError(null);
    setUploading(false);
    setUploadStatus('idle');
    setUploadProgress(0);
    setDragActive(false);
    setLastUploaded([]);
  }, []);

  const appendFiles = useCallback(
    (fileList: FileList | readonly File[] | null) => {
      if (!fileList || fileList.length === 0) return;
      if (uploadingRef.current || readOnly || !mountedRef.current) return;
      setUploadError(null);
      if (uploadStatusRef.current === 'error' || uploadStatusRef.current === 'success') {
        uploadStatusRef.current = 'idle';
        setUploadStatus('idle');
        setUploadProgress(0);
      }
      const chosen = Array.from(fileList);
      const currentItems = pendingItemsRef.current;
      if (currentItems.length + chosen.length > GALLERY_UPLOAD_MAX_FILES) {
        setUploadError(`单次最多选择 ${GALLERY_UPLOAD_MAX_FILES} 张图片`);
        return;
      }
      const valid: PendingUploadItem[] = [];
      for (const file of chosen) {
        const check = validateClientUploadFile({
          name: file.name,
          size: file.size,
          type: file.type,
        });
        if (!check.ok) {
          setUploadError(`${file.name}：${check.message}`);
          return;
        }
        pendingSeqRef.current += 1;
        valid.push({ key: `pending_${pendingSeqRef.current}`, file });
      }
      const nextItems = [...currentItems, ...valid];
      pendingItemsRef.current = nextItems;
      setPendingItems(nextItems);
      const session = uploadSessionRef.current;
      for (const entry of valid) {
        void readImageDimensions(entry.file)
          .then((dims) => {
            if (
              !dims ||
              !mountedRef.current ||
              uploadSessionRef.current !== session ||
              !pendingItemsRef.current.some((item) => item.key === entry.key)
            ) {
              return;
            }
            const widthWarning = checkImageWidthWarning(dims.width);
            const updated = pendingItemsRef.current.map((item) =>
              item.key === entry.key
                ? { ...item, width: dims.width, height: dims.height, widthWarning }
                : item,
            );
            pendingItemsRef.current = updated;
            setPendingItems(updated);
          })
          .catch(() => undefined);
      }
    },
    [readOnly],
  );

  const removePendingItem = useCallback((key: string) => {
    if (uploadingRef.current || !mountedRef.current) return;
    const nextItems = pendingItemsRef.current.filter((entry) => entry.key !== key);
    pendingItemsRef.current = nextItems;
    setPendingItems(nextItems);
  }, []);

  const openFilePicker = useCallback(() => {
    if (uploadingRef.current || readOnly || !mountedRef.current) return;
    fileInputRef.current?.click();
  }, [readOnly]);

  const submitUpload = useCallback(async (): Promise<boolean> => {
    if (uploadingRef.current || readOnly || !mountedRef.current) return false;
    const itemsToUpload = pendingItemsRef.current;
    if (itemsToUpload.length === 0) {
      setUploadError('请至少选择一张图片');
      return false;
    }
    const session = uploadSessionRef.current;
    uploadAttemptRef.current += 1;
    const attempt = uploadAttemptRef.current;
    uploadingRef.current = true;
    uploadStatusRef.current = 'uploading';
    setUploading(true);
    setUploadStatus('uploading');
    setUploadError(null);
    setUploadProgress(10);
    try {
      const res = await gateway.uploadAssets(
        categoryId,
        itemsToUpload.map((item) => item.file),
        (percent) => {
          if (
            mountedRef.current &&
            uploadingRef.current &&
            uploadSessionRef.current === session &&
            uploadAttemptRef.current === attempt
          ) {
            setUploadProgress(percent);
          }
        },
      );
      if (
        !mountedRef.current ||
        uploadSessionRef.current !== session ||
        uploadAttemptRef.current !== attempt
      ) {
        return false;
      }
      uploadSessionRef.current += 1;
      uploadingRef.current = false;
      pendingItemsRef.current = [];
      uploadStatusRef.current = 'success';
      setUploadProgress(100);
      setUploadStatus('success');
      setUploading(false);
      setLastUploaded(res.items);
      setPendingItems([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onUploadSuccessRef.current?.(res);
      return true;
    } catch (err) {
      if (
        !mountedRef.current ||
        uploadSessionRef.current !== session ||
        uploadAttemptRef.current !== attempt
      ) {
        return false;
      }
      uploadingRef.current = false;
      uploadStatusRef.current = 'error';
      setUploadStatus('error');
      setUploadError(err instanceof Error ? err.message : '上传图片失败');
      setUploading(false);
      return false;
    }
  }, [categoryId, gateway, readOnly]);

  const pendingWidthWarnings = useMemo(
    () =>
      pendingItems
        .filter((item) => Boolean(item.widthWarning))
        .map((item) => `${item.file.name}：${item.widthWarning}`),
    [pendingItems],
  );

  const dropzoneProps = useMemo(
    () => ({
      'data-testid': 'gallery-upload-dropzone',
      style: {
        border: `1px dashed ${dragActive ? 'var(--gm-phosphor)' : 'var(--gm-line-2)'}`,
        borderRadius: 8,
        padding: 16,
        textAlign: 'center' as const,
        background: dragActive ? 'var(--gm-phosphor-a08)' : 'var(--gm-bg-surface)',
        transition: 'border-color 120ms ease, background-color 120ms ease',
        display: 'grid',
        gap: 8,
        justifyItems: 'center' as const,
      },
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!uploadingRef.current && !readOnly && mountedRef.current) {
          setDragActive(true);
        }
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!uploadingRef.current && !readOnly && mountedRef.current) {
          setDragActive(true);
        }
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && mountedRef.current) {
          setDragActive(false);
        }
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!mountedRef.current) return;
        setDragActive(false);
        if (!uploadingRef.current && !readOnly) {
          appendFiles(e.dataTransfer?.files ?? null);
        }
      },
    }),
    [appendFiles, dragActive, readOnly],
  );

  const fileInputProps = useMemo(
    () => ({
      'aria-label': '选择图片文件',
      type: 'file' as const,
      multiple: true as const,
      disabled: Boolean(uploading || readOnly),
      accept: 'image/jpeg,image/png,image/webp',
      className: 'gm-sr-only',
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        appendFiles(e.target.files);
      },
    }),
    [appendFiles, readOnly, uploading],
  );

  const modalFooterError = uploadStatus === 'error' ? null : uploadError;
  const showProgress = uploading || uploadProgress > 0 || uploadStatus === 'error';
  const progressStatus =
    uploadStatus === 'error' ? 'exception' : uploadStatus === 'success' ? 'success' : 'active';
  const isUploadComplete = uploadStatus === 'success' && pendingItems.length === 0;

  return {
    pendingItems,
    pendingWidthWarnings,
    uploadError,
    modalFooterError,
    uploading,
    uploadStatus,
    uploadProgress,
    showProgress,
    progressStatus,
    isUploadComplete,
    dragActive,
    lastUploaded,
    fileInputRef,
    openFilePicker,
    appendFiles,
    removePendingItem,
    resetUpload,
    submitUpload,
    dropzoneProps,
    fileInputProps,
  };
}
