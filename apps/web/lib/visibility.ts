import type {
  ImportQuestionsInput,
  ImportQuestionsResult,
  KeywordRecord,
  QuestionRecord,
  VisibilityCitationListResponse,
  VisibilityCitationQuery,
  VisibilityEngineAvailabilityResponse,
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
import { authorizedRequest } from './api';
import { GatewayApiError, createEnvelopeUnwrapper } from './envelope';
import { httpQuestionGateway } from './questions';
import { httpSampleGateway, type PriceItem } from './samples';
import type { SessionStorageLike } from './session';

export class VisibilityApiError extends GatewayApiError {}

export type VisibilityGateway = {
  listProfiles(): Promise<VisibilityProfileListResponse>;
  createProfile(input: VisibilityProfileCreateWithPrefillInput): Promise<VisibilityProfileRecord>;
  updateProfile(id: string, input: VisibilityProfileUpdateInput): Promise<VisibilityProfileRecord>;
  deleteProfile(id: string): Promise<{ deleted: number }>;

  listRuns(query: VisibilityRunListQuery): Promise<VisibilityRunListResponse>;
  getRun(id: string): Promise<VisibilityRunDetailRecord>;
  createRun(
    input: VisibilityRunCreateInput,
    idempotencyKey: string,
  ): Promise<VisibilityRunDetailRecord>;
  pauseRun(id: string): Promise<VisibilityRunDetailRecord>;
  resumeRun(id: string): Promise<VisibilityRunDetailRecord>;
  cancelRun(id: string): Promise<VisibilityRunDetailRecord>;
  bulkDeleteRuns(ids: string[]): Promise<{ deleted: number }>;

  listKeywords(): Promise<KeywordRecord[]>;
  listQuestionsByKeyword(keywordId: string): Promise<QuestionRecord[]>;
  listPrices(): Promise<PriceItem[]>;

  getOverview(query: VisibilityOverviewQuery): Promise<VisibilityOverviewResponse>;
  listCitations(query: VisibilityCitationQuery): Promise<VisibilityCitationListResponse>;

  // Reserved extension hooks for Issue #60 (Query Fan-out & Citation Gap loop)
  listOpportunities?(query: VisibilityOpportunitiesQuery): Promise<VisibilityOpportunitiesResponse>;
  importOpportunityQuestions?(input: ImportQuestionsInput): Promise<ImportQuestionsResult>;
  listEngines?(): Promise<VisibilityEngineAvailabilityResponse>;
};

export function createVisibilityIdempotencyKey(prefix = 'vrun'): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
      : `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
}

export function buildVisibilityRunQueryString(query: VisibilityRunListQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.profileId?.trim()) params.set('profileId', query.profileId.trim());
  if (query.status) params.set('status', query.status);
  if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
  return params.toString();
}

export function buildVisibilityOverviewQueryString(query: VisibilityOverviewQuery): string {
  const params = new URLSearchParams();
  params.set('days', String(query.days));
  if (query.profileId?.trim()) params.set('profileId', query.profileId.trim());
  if (query.engine) params.set('engine', query.engine);
  if (query.from?.trim()) params.set('from', query.from.trim());
  if (query.to?.trim()) params.set('to', query.to.trim());
  return params.toString();
}

export function buildVisibilityCitationQueryString(query: VisibilityCitationQuery): string {
  const params = new URLSearchParams();
  params.set('days', String(query.days));
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  if (query.profileId?.trim()) params.set('profileId', query.profileId.trim());
  if (query.engine) params.set('engine', query.engine);
  if (query.sourceKind) params.set('sourceKind', query.sourceKind);
  if (query.from?.trim()) params.set('from', query.from.trim());
  if (query.to?.trim()) params.set('to', query.to.trim());
  return params.toString();
}

export function buildVisibilityOpportunitiesQueryString(
  query: VisibilityOpportunitiesQuery,
): string {
  const params = new URLSearchParams();
  params.set('days', String(query.days));
  params.set('limit', String(query.limit));
  if (query.profileId?.trim()) params.set('profileId', query.profileId.trim());
  if (query.engine) params.set('engine', query.engine);
  if (query.from?.trim()) params.set('from', query.from.trim());
  if (query.to?.trim()) params.set('to', query.to.trim());
  return params.toString();
}

const unwrap = createEnvelopeUnwrapper(VisibilityApiError);

export function httpVisibilityGateway(storage: SessionStorageLike): VisibilityGateway {
  const questionGw = httpQuestionGateway(storage);
  const sampleGw = httpSampleGateway(storage);

  return {
    async listProfiles() {
      const res = await authorizedRequest(storage, 'GET', '/visibility/profiles');
      return unwrap<VisibilityProfileListResponse>(res);
    },

    async createProfile(input) {
      const res = await authorizedRequest(storage, 'POST', '/visibility/profiles', input);
      return unwrap<VisibilityProfileRecord>(res);
    },

    async updateProfile(id, input) {
      const res = await authorizedRequest(
        storage,
        'PATCH',
        `/visibility/profiles/${encodeURIComponent(id)}`,
        input,
      );
      return unwrap<VisibilityProfileRecord>(res);
    },

    async deleteProfile(id) {
      const res = await authorizedRequest(
        storage,
        'DELETE',
        `/visibility/profiles/${encodeURIComponent(id)}`,
      );
      return unwrap<{ deleted: number }>(res);
    },

    async listRuns(query) {
      const qs = buildVisibilityRunQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/visibility/runs?${qs}`);
      return unwrap<VisibilityRunListResponse>(res);
    },

    async getRun(id) {
      const res = await authorizedRequest(
        storage,
        'GET',
        `/visibility/runs/${encodeURIComponent(id)}`,
      );
      return unwrap<VisibilityRunDetailRecord>(res);
    },

    async createRun(input, idempotencyKey) {
      const res = await authorizedRequest(storage, 'POST', '/visibility/runs', input, {
        'Idempotency-Key': idempotencyKey,
      });
      return unwrap<VisibilityRunDetailRecord>(res);
    },

    async pauseRun(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/visibility/runs/${encodeURIComponent(id)}/pause`,
        {},
      );
      return unwrap<VisibilityRunDetailRecord>(res);
    },

    async resumeRun(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/visibility/runs/${encodeURIComponent(id)}/resume`,
        {},
      );
      return unwrap<VisibilityRunDetailRecord>(res);
    },

    async cancelRun(id) {
      const res = await authorizedRequest(
        storage,
        'POST',
        `/visibility/runs/${encodeURIComponent(id)}/cancel`,
        {},
      );
      return unwrap<VisibilityRunDetailRecord>(res);
    },

    async bulkDeleteRuns(ids) {
      const res = await authorizedRequest(storage, 'POST', '/visibility/runs/bulk-delete', { ids });
      return unwrap<{ deleted: number }>(res);
    },

    async listKeywords() {
      return questionGw.listKeywords();
    },

    async listQuestionsByKeyword(keywordId) {
      if (!keywordId.trim()) return [];
      const data = await questionGw.list({
        page: 1,
        pageSize: 50,
        keyword: '',
        keywordId: keywordId.trim(),
        sort: 'createdAt',
        order: 'desc',
      });
      return data.items;
    },

    async listPrices() {
      return sampleGw.prices();
    },

    async getOverview(query) {
      const qs = buildVisibilityOverviewQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/visibility/overview?${qs}`);
      return unwrap<VisibilityOverviewResponse>(res);
    },

    async listCitations(query) {
      const qs = buildVisibilityCitationQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/visibility/citations?${qs}`);
      return unwrap<VisibilityCitationListResponse>(res);
    },

    async listOpportunities(query) {
      const qs = buildVisibilityOpportunitiesQueryString(query);
      const res = await authorizedRequest(storage, 'GET', `/visibility/opportunities?${qs}`);
      return unwrap<VisibilityOpportunitiesResponse>(res);
    },

    async importOpportunityQuestions(input) {
      const res = await authorizedRequest(
        storage,
        'POST',
        '/visibility/opportunities/import-questions',
        input,
      );
      return unwrap<ImportQuestionsResult>(res);
    },

    async listEngines() {
      const res = await authorizedRequest(storage, 'GET', '/visibility/engines');
      return unwrap<VisibilityEngineAvailabilityResponse>(res);
    },
  };
}
