'use client';

import { useId, useState } from 'react';

export interface FaqAccordionItem {
  id: string;
  question: string;
  answer: string;
}

export function FaqAccordion({
  items,
  defaultOpenIndex = 0,
}: {
  items: readonly FaqAccordionItem[];
  defaultOpenIndex?: number | null;
}) {
  const baseId = useId();
  const [openId, setOpenId] = useState<string | null>(() => {
    if (defaultOpenIndex === null || defaultOpenIndex < 0 || defaultOpenIndex >= items.length) {
      return null;
    }
    return items[defaultOpenIndex]?.id ?? null;
  });

  return (
    <div className="gm-mkt-faq-list">
      {items.map((item) => {
        const isOpen = openId === item.id;
        const triggerId = `${baseId}-trigger-${item.id}`;
        const panelId = `${baseId}-panel-${item.id}`;

        return (
          <div key={item.id} className={`gm-mkt-faq-item${isOpen ? ' is-open' : ''}`}>
            <h3 className="gm-mkt-faq-heading">
              <button
                id={triggerId}
                type="button"
                className="gm-mkt-faq-trigger"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId((prev) => (prev === item.id ? null : item.id))}
              >
                <span>{item.question}</span>
                <span className={`gm-mkt-faq-icon${isOpen ? ' is-open' : ''}`} aria-hidden="true">
                  +
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              hidden={!isOpen}
              className="gm-mkt-faq-panel"
            >
              <p className="gm-mkt-faq-answer">{item.answer}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
