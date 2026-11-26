import './marketing.css';
import { MarketingFooter } from '../../components/marketing/marketing-footer';
import { MarketingHeader } from '../../components/marketing/marketing-header';

export const dynamic = 'force-dynamic';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="gm-mkt-root">
      <MarketingHeader />
      <main className="gm-mkt-main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
