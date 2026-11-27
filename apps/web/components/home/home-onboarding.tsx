'use client';

import { Button } from 'antd';
import type { JSX } from 'react';
import { EmptyState } from '../ui';

export type HomeOnboardingProps = {
  readOnly: boolean;
  onCreateBrand: () => void;
};

/**
 * 零品牌首次引导视图：独立拆分以保证每个组件文件内最多仅含 1 个实心主按钮（Primary CTA）。
 */
export function HomeOnboarding({ readOnly, onCreateBrand }: HomeOnboardingProps): JSX.Element {
  return (
    <section className="gm-home-page" aria-label="行动首页" data-testid="home-onboarding">
      <EmptyState
        size="full"
        title="欢迎使用 GeoMix"
        description="先建品牌并填事实卡，即可开启监测、写作与复测。"
        action={
          readOnly ? undefined : (
            <Button
              type="primary"
              autoInsertSpace={false}
              data-testid="home-onboarding-create-brand-btn"
              onClick={onCreateBrand}
            >
              新建品牌
            </Button>
          )
        }
      />
    </section>
  );
}
