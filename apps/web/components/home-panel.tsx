'use client';

import { HOME_LEAD, homeTitle } from '../lib/site';
import { Button, Card, Typography } from 'antd';
import Link from 'next/link';

export function HomePanel() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card style={{ maxWidth: 560, width: '100%' }}>
        <Typography.Title level={2} style={{ marginTop: 0 }}>
          {homeTitle()}
        </Typography.Title>
        <Typography.Paragraph>{HOME_LEAD}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          请使用管理员开通的账号登录控制台，管理关键词、素材图库、AI 写作任务与账号权益。
        </Typography.Paragraph>
        <Link href="/login">
          <Button type="primary">登录</Button>
        </Link>
      </Card>
    </main>
  );
}
