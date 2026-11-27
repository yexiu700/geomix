'use client';

import { Alert, Button, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountApiError, httpRights, type RightsView } from '../../lib/account-client';
import { SignalSkeleton } from '../geo/primitives';
import { Explain } from '../ui';

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
  const [loading, setLoading] = useState(true);
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
      <div className="gm-rights-head">
        <div className="gm-ui-section-title-row">
          <Typography.Title level={3} className="gm-rights-title">
            {title}
          </Typography.Title>
          <Explain text="展示当前账号的配额使用进度、存储用量与可用点数余额。" label="权益说明" />
        </div>
        <Button
          size="small"
          autoInsertSpace={false}
          loading={loading}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {loading && !view ? (
        <div className="gm-rights" data-testid="rights-loading" aria-busy="true">
          {Array.from({ length: 9 }, (_, idx) => (
            <SignalSkeleton key={`right-sk-${idx}`} variant="kpi" />
          ))}
        </div>
      ) : (
        <div className="gm-rights">
          {(view?.cards ?? []).map((card) => (
            <article key={card.key} className="gm-right-card" aria-label={card.label}>
              <div className="label">{card.label}</div>
              <div className="value">{card.text}</div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
