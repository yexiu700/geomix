'use client';

import { Alert, Button, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountApiError, httpRights, type RightsView } from '../../lib/account-client';

export function RightsScreen({
  title,
  active = true,
  load,
}: {
  title: string;
  active?: boolean;
  load?: () => Promise<RightsView>;
}) {
  const fallback = useMemo(() => () => httpRights(window.sessionStorage), []);
  const read = load ?? fallback;
  const [view, setView] = useState<RightsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const wasActiveRef = useRef(active);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await read();
      if (seq !== seqRef.current) return;
      setView(next);
      setError(null);
    } catch (reason: unknown) {
      if (seq !== seqRef.current) return;
      setError(reason instanceof AccountApiError ? reason.message : '无法加载账号权益');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [read]);

  useEffect(() => {
    void refresh();
    return () => {
      seqRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const becameActive = !wasActiveRef.current && active;
    wasActiveRef.current = active;
    if (becameActive) {
      void refresh();
    }
  }, [active, refresh]);

  return (
    <section aria-label="账号权益">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Button size="small" loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
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
