'use client';

import { BRAND_TRUTH_AGREEMENT_PARAGRAPHS } from '@geomix/shared';
import { Button, Modal, Space } from 'antd';

export type BrandTruthTermsModalProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * 品牌事实真实性与合规承诺协议预览弹窗。
 */
export function BrandTruthTermsModal({ open, onClose }: BrandTruthTermsModalProps) {
  return (
    <Modal
      open={open}
      title="承诺协议"
      onCancel={onClose}
      footer={[
        <Button key="ok" type="primary" onClick={onClose}>
          知道了
        </Button>,
      ]}
    >
      <Space direction="vertical" size={10} className="gm-brand-terms-list">
        {BRAND_TRUTH_AGREEMENT_PARAGRAPHS.map((para, idx) => (
          <p key={idx} className="gm-brand-terms-para">
            {para}
          </p>
        ))}
      </Space>
    </Modal>
  );
}
