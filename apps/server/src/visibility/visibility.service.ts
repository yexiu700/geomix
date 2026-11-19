import { Inject, Injectable } from '@nestjs/common';
import type {
  ImportQuestionsInput,
  ImportQuestionsResult,
  VisibilityCitationListResponse,
  VisibilityCitationQuery,
  VisibilityOpportunitiesQuery,
  VisibilityOpportunitiesResponse,
  VisibilityOverviewQuery,
  VisibilityOverviewResponse,
  VisibilityProfileCreateWithPrefillInput,
  VisibilityProfileListResponse,
  VisibilityProfileRecord,
  VisibilityProfileUpdateInput,
  VisibilityRunCreateInput,
  VisibilityRunDetailRecord,
  VisibilityRunListQuery,
  VisibilityRunListResponse,
} from '@geomix/shared';
import { VisibilityAnalyticsService } from './visibility-analytics.service';
import { VisibilityProfileService } from './visibility-profile.service';
import { VisibilityRunLifecycleService } from './visibility-run-lifecycle.service';

export { deriveVisibilityRunId } from './visibility.mapper';

@Injectable()
export class VisibilityService {
  constructor(
    @Inject(VisibilityProfileService) private readonly profiles: VisibilityProfileService,
    @Inject(VisibilityRunLifecycleService)
    private readonly runLifecycle: VisibilityRunLifecycleService,
    @Inject(VisibilityAnalyticsService) private readonly analytics: VisibilityAnalyticsService,
  ) {}

  // ===================== Profiles CRUD =====================

  async listProfiles(): Promise<VisibilityProfileListResponse> {
    return this.profiles.listProfiles();
  }

  async getProfile(id: string): Promise<VisibilityProfileRecord> {
    return this.profiles.getProfile(id);
  }

  async createProfile(
    input: VisibilityProfileCreateWithPrefillInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    return this.profiles.createProfile(input, userId);
  }

  async updateProfile(
    id: string,
    input: VisibilityProfileUpdateInput,
    userId: string,
  ): Promise<VisibilityProfileRecord> {
    return this.profiles.updateProfile(id, input, userId);
  }

  async deleteProfile(id: string): Promise<{ deleted: number }> {
    return this.profiles.deleteProfile(id);
  }

  // ===================== Runs CRUD & Control =====================

  async listRuns(query: VisibilityRunListQuery): Promise<VisibilityRunListResponse> {
    return this.runLifecycle.listRuns(query);
  }

  async getRunDetail(id: string): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.getRunDetail(id);
  }

  async detailForTenant(tenantId: string, id: string): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.detailForTenant(tenantId, id);
  }

  async createRun(
    input: VisibilityRunCreateInput,
    idempotencyKey: string,
    userId: string,
  ): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.createRun(input, idempotencyKey, userId);
  }

  async pauseRun(id: string): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.pauseRun(id);
  }

  async resumeRun(id: string): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.resumeRun(id);
  }

  async cancelRun(id: string): Promise<VisibilityRunDetailRecord> {
    return this.runLifecycle.cancelRun(id);
  }

  async bulkDeleteRuns(ids: string[]): Promise<{ deleted: number }> {
    return this.runLifecycle.bulkDeleteRuns(ids);
  }

  // ===================== Analytics & Opportunity Closure =====================

  async overview(query: VisibilityOverviewQuery): Promise<VisibilityOverviewResponse> {
    return this.analytics.overview(query);
  }

  async citations(query: VisibilityCitationQuery): Promise<VisibilityCitationListResponse> {
    return this.analytics.listCitations(query);
  }

  async opportunities(
    query: VisibilityOpportunitiesQuery,
  ): Promise<VisibilityOpportunitiesResponse> {
    return this.analytics.opportunities(query);
  }

  async importOpportunityQuestions(
    input: ImportQuestionsInput,
    userId: string,
  ): Promise<ImportQuestionsResult> {
    return this.analytics.importOpportunityQuestions(input, userId);
  }
}
