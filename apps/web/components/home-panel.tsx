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
          先启动数据库、Redis 和对象存储，再运行 pnpm
          dev。登录会校验图形验证码和租户有效期。登录后进入多标签后台。
        </Typography.Paragraph>
        <Link href="/login" legacyBehavior>
          <Button type="primary">登录</Button>
        </Link>
      </Card>
    </main>
  );
}
