'use client';

import { Alert, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { AccountApiError, httpRights, type RightsView } from '../../lib/account-client';

export function RightsScreen({ title, load }: { title: string; load?: () => Promise<RightsView> }) {
  const fallback = useMemo(() => () => httpRights(window.sessionStorage), []);
  const read = load ?? fallback;
  const [view, setView] = useState<RightsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void read().then(
      (next) => {
        if (!live) return;
        setView(next);
        setError(null);
      },
      (reason: unknown) => {
        if (!live) return;
        setError(reason instanceof AccountApiError ? reason.message : '无法加载账号权益');
      },
    );
    return () => {
      live = false;
    };
  }, [read]);

  return (
    <section aria-label="账号权益">
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        展示当前账号的配额使用进度、存储用量、可用点数余额及各 AI 平台收录统计。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="gm-rights">
        {(view?.cards ?? []).map((card) => (
          <article key={card.key} className="gm-right-card" aria-label={card.label}>
            <div className="label">{card.label}</div>
            <div className="value">{card.text}</div>
          </article>
        ))}
      </div>
      <h3 className="gm-models-title">模型收录</h3>
      <div className="gm-rights">
        {(view?.models ?? []).map((model) => (
          <article key={model.key} className="gm-right-card" aria-label={model.label}>
            <div className="label">{model.label}</div>
            <div className="value">{model.count}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
