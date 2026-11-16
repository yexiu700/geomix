import { Injectable } from '@nestjs/common';
import { SITE_NAME, ok, parseEnv, type ApiEnvelope, type BillingMode } from '@geomix/shared';

export type ApiHealth = {
  service: 'api';
  name: typeof SITE_NAME;
  billingMode: BillingMode;
};

@Injectable()
export class HealthService {
  getHealth(source?: Record<string, string | undefined>): ApiEnvelope<ApiHealth> {
    const env = parseEnv(source ?? process.env);
    return ok({
      service: 'api',
      name: SITE_NAME,
      billingMode: env.BILLING_MODE,
    });
  }
}
