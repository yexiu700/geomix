'use client';

import { HOME_LEAD, homeTitle } from '../lib/site';
import { Card, Typography } from 'antd';

export function HomePanel() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <Card style={{ maxWidth: 560, width: '100%' }}>
        <Typography.Title level={2} style={{ marginTop: 0 }}>
          {homeTitle()}
        </Typography.Title>
        <Typography.Paragraph>{HOME_LEAD}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          先启动数据库、Redis 和对象存储，再运行 pnpm dev。业务页面会在后续迭代接入。
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
