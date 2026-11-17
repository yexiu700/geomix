'use client';

import { ARTICLE_STATUS_LABEL, isArticleStatus, type ArticleListQuery } from '@geomix/shared';
import { Alert, Button, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  CategoryApiError,
  httpArticleGateway,
  type ArticleGateway,
  type ArticlePage,
} from '../../lib/categories';
import type { SessionStorageLike } from '../../lib/session';
import type { ShellAction } from '../../lib/tab-stack';

export function ArticleListScreen({
  title,
  tabId,
  categoryId,
  gateway,
  storage,
  onDispatch,
}: {
  title: string;
  tabId: string;
  categoryId: string;
  gateway?: ArticleGateway;
  storage?: SessionStorageLike;
  onDispatch: (action: ShellAction) => void;
}) {
  const client = useMemo(
    () => gateway ?? httpArticleGateway(storage ?? window.sessionStorage),
    [gateway, storage],
  );
  const [query, setQuery] = useState<ArticleListQuery>({
    categoryId,
    page: 1,
    pageSize: 10,
  });
  const [page, setPage] = useState<ArticlePage | null>(null);
  const [loading, setLoading] = useState(Boolean(categoryId));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setQuery((current) =>
      current.categoryId === categoryId
        ? current
        : { categoryId, page: 1, pageSize: current.pageSize },
    );
  }, [categoryId]);

  useEffect(() => {
    if (!query.categoryId) return;
    let live = true;
    setLoading(true);
    void client.list(query).then(
      (result) => {
        if (!live) return;
        setPage(result);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setPage(null);
        setError(messageOf(reason));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, query, reloadKey]);

  function goBack(): void {
    onDispatch({ type: 'back', id: tabId });
  }

  if (!categoryId) {
    return (
      <section>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
        <Alert type="info" showIcon message="请从文章分类的「查看文章」进入。" />
        <Button style={{ marginTop: 16 }} onClick={goBack}>
          返回上一级
        </Button>
      </section>
    );
  }

  const category = page?.category;

  return (
    <section>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {category
          ? `分组名 ${category.name}。文章数量 ${category.total}，文章剩余量 ${category.remaining}。`
          : '正在读取这个分类下的文章。'}
        剩余量只统计状态为正常且发送次数为 0 的文章。这里只查看，不在这里添加或修改文章。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Button style={{ marginBottom: 12 }} onClick={goBack}>
        返回上一级
      </Button>
      <Button
        style={{ marginLeft: 8, marginBottom: 12 }}
        onClick={() => setReloadKey((value) => value + 1)}
      >
        刷新
      </Button>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={page?.items ?? []}
        locale={{ emptyText: '这个分类下还没有文章' }}
        pagination={{
          current: query.page,
          pageSize: query.pageSize,
          total: page?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: ['10', '25', '50'],
          onChange: (nextPage, nextSize) => {
            const pageSize = nextSize === 25 || nextSize === 50 ? nextSize : 10;
            setQuery((current) => ({
              ...current,
              page: pageSize === current.pageSize ? nextPage : 1,
              pageSize,
            }));
          },
        }}
        columns={[
          { title: '标题', dataIndex: 'title', key: 'title' },
          {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            render: (status: string) =>
              isArticleStatus(status) ? ARTICLE_STATUS_LABEL[status] : status,
          },
          { title: '发送次数', dataIndex: 'sendCount', key: 'sendCount' },
          {
            title: '计入剩余量',
            dataIndex: 'countsAsRemaining',
            key: 'countsAsRemaining',
            render: (value: boolean) => (value ? '是' : '否'),
          },
          {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            render: (value: string) => value.replace('T', ' ').slice(0, 16),
          },
        ]}
      />
    </section>
  );
}

function messageOf(reason: unknown): string {
  if (reason instanceof CategoryApiError) return reason.message;
  return '无法连接接口';
}
