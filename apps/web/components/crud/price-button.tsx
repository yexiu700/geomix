'use client';

import { priceButtonText, priceUnit } from '@geomix/shared';
import { Button } from 'antd';
import type { PriceItem } from '../../lib/samples';

export function PriceButton({
  action,
  prices,
  loading = false,
  disabled = false,
  htmlType = 'button',
  onClick,
}: {
  action: string;
  prices: PriceItem[] | null;
  loading?: boolean;
  disabled?: boolean;
  htmlType?: 'button' | 'submit';
  onClick?: () => void;
}) {
  const item = prices?.find((price) => price.action === action);
  let text = '读取价格';
  if (!loading && prices && item?.enabled) {
    text = priceButtonText(item.label, item.unitPoints, priceUnit(item.action));
  } else if (!loading && prices) {
    text = '价格未启用';
  }
  return (
    <Button
      type={onClick || htmlType === 'submit' ? 'primary' : 'default'}
      htmlType={htmlType}
      loading={loading}
      disabled={disabled || loading || !item?.enabled}
      aria-label={text}
      onClick={onClick}
    >
      {text}
    </Button>
  );
}
