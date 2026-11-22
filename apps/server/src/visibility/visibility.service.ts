import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AUTH_ERROR,
  type GeoMarket,
  type ParsedVisibilityRunV2CreateInput,
  type VisibilityCitationListResponse,
  type VisibilityEngineAvailabilityResponse,
  type VisibilityOpportunitiesResponse,
  type VisibilityOverviewResponse,
  type VisibilityRunDetailRecord,
  type VisibilityRunListResponse,
  type VisibilityV2CitationQuery,
  type VisibilityV2OpportunitiesQuery,
  type VisibilityV2OverviewQuery,
  type VisibilityV2RunListQuery,
} from '@geomix/shared';
import { BrandsService } from '../brands/brands.service';
import { ApiError } from '../common/api-error';
import {
  VISIBILITY_CONFIG,
  readVisibilityConfig,
  type VisibilityConfig,
} from './visibility.config';
import { VisibilityAnalyticsService } from './visibility-analytics.service';
import { VisibilityEngineHealthService } from './visibility-engine-health.service';
import { VisibilityRunLifecycleService } from './visibility-run-lifecycle.service';

export { deriveVisibilityRunId } from './visibility.mapper';

@Injectable()
export class VisibilityService {
  private readonly config: VisibilityConfig;

  constructor(
    @Inject(BrandsService) private readonly brands: BrandsService,
    @Inject(VisibilityRunLifecycleService)
    private readonly runLifecycle: VisibilityRunLifecycleService,
    @Inject(VisibilityAnalyticsService) private readonly analytics: VisibilityAnalyticsService,
    @Optional() @Inject(VISIBILITY_CONFIG) config?: VisibilityConfig,
    @Optional()
    @Inject(VisibilityEngineHealthService)
    private readonly engineHealth?: VisibilityEngineHealthService,
  ) {
    this.config = config ?? readVisibilityConfig(process.env);
  }

  private assertFeatureEnabled(): void {
    if (!this.config.featureEnabled) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, 'AI可见性监测功能未启用');
    }
  }

  // ===================== Engines Availability =====================

  async listEngines(
    brandId: string,
    market?: GeoMarket,
  ): Promise<VisibilityEngineAvailabilityResponse> {
    this.assertFeatureEnabled();
    const resolved = await this.brands.resolveBrandMarket(brandId, market);
    if (!this.engineHealth) {
      return new VisibilityEngineHealthService(this.config).getAvailability(resolved.market.market);
    }
    return this.engineHealth.getAvailability(resolved.market.market);
  }

  // ===================== Runs CRUD & Control =====================

  async listRuns(
    brandId: string,
    query: VisibilityV2RunListQuery,
  ): Promise<VisibilityRunListResponse> {
    return this.runLifecycle.listRuns(brandId, query);
  }

  async getRunDetail(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.getRunDetail(brandId, runId, market);
  }

  async detailForTenant(
    tenantId: string,
    runId: string,
    scope?: { brandId?: string; brandMarketId?: string },
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.detailForTenant(tenantId, runId, scope);
  }

  async createRun(
    brandId: string,
    input: ParsedVisibilityRunV2CreateInput,
    idempotencyKey: string,
    userId: string,
    queryMarket?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.createRun(brandId, input, idempotencyKey, userId, queryMarket);
  }

  async pauseRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.pauseRun(brandId, runId, market);
  }

  async resumeRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.resumeRun(brandId, runId, market);
  }

  async cancelRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.cancelRun(brandId, runId, market);
  }

  async deleteRun(
    brandId: string,
    runId: string,
    market?: GeoMarket,
  ): Promise<{ deleted: number }> {
    return this.runLifecycle.deleteRun(brandId, runId, market);
  }

  async bulkDeleteRuns(
    brandId: string,
    ids: string[],
    market?: GeoMarket,
  ): Promise<{ deleted: number }> {
    return this.runLifecycle.bulkDeleteRuns(brandId, ids, market);
  }

  // ===================== Analytics =====================

  async overview(
    brandId: string,
    query: VisibilityV2OverviewQuery,
  ): Promise<VisibilityOverviewResponse> {
    return this.analytics.overview(brandId, query);
  }

  async citations(
    brandId: string,
    query: VisibilityV2CitationQuery,
  ): Promise<VisibilityCitationListResponse> {
    return this.analytics.listCitations(brandId, query);
  }

  async opportunities(
    brandId: string,
    query: VisibilityV2OpportunitiesQuery,
  ): Promise<VisibilityOpportunitiesResponse> {
    return this.analytics.opportunities(brandId, query);
  }
}
