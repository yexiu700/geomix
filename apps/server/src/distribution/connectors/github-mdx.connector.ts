import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  isSafeDistributionHttpUrl,
  serializeJsonLdSafe,
  type ChannelRemoteTargetDto,
  type TestChannelConnectionInput,
} from '@geomix/shared';
import { OutboundHttpClient } from '../../infra/outbound-http';
import {
  collectSecretCandidates,
  ConnectorError,
  joinBasePath,
  mapHttpStatusError,
  mapTransportError,
  parseJsonSafe,
  slugifyAscii,
  trimTrailingSlashes,
  validatePublishedUrl,
  type CmsConnector,
  type ConnectorConnectionContext,
  type ConnectorPublishPayload,
  type ConnectorPublishResult,
  type ConnectorSecrets,
  type ConnectorTestResult,
} from './types';

export const GITHUB_API_BASE_URL = Symbol('GITHUB_API_BASE_URL');
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

const GITHUB_SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_API_VERSION = '2022-11-28';

type GitHubRepoResponse = {
  id?: number | string;
  full_name?: string;
  name?: string;
  default_branch?: string;
  html_url?: string;
  permissions?: {
    push?: boolean;
    admin?: boolean;
  };
};

type GitHubUserResponse = {
  login?: string;
  name?: string;
};

type GitHubRefResponse = {
  ref?: string;
  object?: {
    sha?: string;
  };
};

type GitHubContentGetResponse = {
  sha?: string;
  path?: string;
};

type GitHubContentPutResponse = {
  content?: {
    path?: string;
    sha?: string;
    html_url?: string;
  };
  commit?: {
    sha?: string;
    html_url?: string;
  };
};

type GitHubPullResponse = {
  number?: number;
  html_url?: string;
};

/**
 * 解析并校验 GitHub 仓库坐标（`owner` + `repo`），严禁 `..` 或路径分隔符注入。
 */
export function resolveGitHubRepoCoords(
  conn: ConnectorConnectionContext,
): { owner: string; repo: string } | null {
  let owner = conn.configJson.repoOwner?.trim() ?? '';
  let repo = conn.configJson.repoName?.trim() ?? '';

  if ((!owner || !repo) && conn.siteBaseUrl) {
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      if (host === 'github.com' || host === 'www.github.com') {
        const parts = parsed.pathname
          .split('/')
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length >= 2) {
          owner = owner || parts[0]!;
          repo = repo || parts[1]!.replace(/\.git$/i, '');
        }
      }
    } catch {
      // Ignore malformed siteBaseUrl; validated elsewhere
    }
  }

  if (!owner && !repo) {
    return null;
  }

  if (
    !owner ||
    !repo ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..' ||
    !GITHUB_SEGMENT_RE.test(owner) ||
    !GITHUB_SEGMENT_RE.test(repo)
  ) {
    throw new ConnectorError(
      'GITHUB_MDX',
      'CONFIG_ERROR',
      'GitHub 仓库配置格式不正确（repoOwner / repoName 含非法字符）',
    );
  }

  return { owner, repo };
}

/**
 * 规范化仓库内容目录，阻断 `..`、`.` 及控制字符路径穿越。
 */
export function normalizeGitHubContentDir(raw?: string): string {
  const input = (raw ?? 'content/blog').trim();
  if (!input || input === '/') {
    return '';
  }
  const stripped = input.replace(/^\/+|\/+$/g, '');
  if (!stripped) {
    return '';
  }
  const segments = stripped.split('/');
  for (const seg of segments) {
    if (
      !seg ||
      seg === '.' ||
      seg === '..' ||
      seg.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(seg)
    ) {
      throw new ConnectorError(
        'GITHUB_MDX',
        'CONFIG_ERROR',
        'GitHub contentDir 包含非法路径段（禁止 .. 或控制字符）',
      );
    }
  }
  return segments.join('/');
}

/**
 * 校验并规范化 GitHub 分支名，阻断路径穿越（`.` / `..`）与非法 git-ref 字符。
 */
export function normalizeGitHubBranch(raw: string): string {
  if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ConnectorError(
      'GITHUB_MDX',
      'CONFIG_ERROR',
      'GitHub branch 包含非法控制字符或格式无效',
    );
  }
  const branch = raw.trim();
  if (
    !branch ||
    branch.length > 255 ||
    branch === '@' ||
    /\s/.test(branch) ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('\\') ||
    branch.includes('@{') ||
    /[~^:?*[\]]/.test(branch)
  ) {
    throw new ConnectorError(
      'GITHUB_MDX',
      'CONFIG_ERROR',
      'GitHub branch 包含非法 git-ref 字符或路径穿越段',
    );
  }
  const segments = branch.split('/');
  for (const seg of segments) {
    if (
      !seg ||
      seg === '.' ||
      seg === '..' ||
      seg.startsWith('.') ||
      seg.endsWith('.') ||
      seg.endsWith('.lock')
    ) {
      throw new ConnectorError(
        'GITHUB_MDX',
        'CONFIG_ERROR',
        'GitHub branch 包含非法路径段或 .lock 后缀',
      );
    }
  }
  return branch;
}

/**
 * 根据 `publicUrlTemplate` 渲染公开文章链接（支持 `{{slug}}`/`{slug}`、`{{locale}}`/`{locale}`、`{{date}}`/`{date}`、`{{path}}`/`{path}`）。
 */
export function renderGitHubPublicUrl(
  template: string,
  vars: { slug: string; locale: string; date: string; path: string },
): string {
  const encodedPath = vars.path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return template
    .trim()
    .replace(/\{\{slug\}\}|\{slug\}/g, encodeURIComponent(vars.slug))
    .replace(/\{\{locale\}\}|\{locale\}/g, encodeURIComponent(vars.locale))
    .replace(/\{\{date\}\}|\{date\}/g, encodeURIComponent(vars.date))
    .replace(/\{\{path\}\}|\{path\}/g, encodedPath);
}

/**
 * 生成带 YAML Frontmatter 与安全 JSON-LD 的 `.mdx` / `.md` 文档。
 */
export function buildGitHubMdxDocument(
  payload: ConnectorPublishPayload,
  fileExtension: 'mdx' | 'md',
  inlineJsonLd: boolean,
  mergedTags: readonly string[],
  canonicalUrl?: string,
  nowDateIso?: string,
): string {
  const dateStr = nowDateIso ?? new Date().toISOString().slice(0, 10);
  const slug = payload.slug?.trim() || slugifyAscii(payload.title);
  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(payload.title)}`,
    `slug: ${JSON.stringify(slug)}`,
  ];

  if (payload.metaDesc?.trim()) {
    lines.push(`description: ${JSON.stringify(payload.metaDesc.trim())}`);
  }
  lines.push(`date: ${JSON.stringify(dateStr)}`);
  if (payload.targetLocale?.trim()) {
    lines.push(`locale: ${JSON.stringify(payload.targetLocale.trim())}`);
  }
  if (canonicalUrl) {
    lines.push(`canonicalUrl: ${JSON.stringify(canonicalUrl)}`);
  }
  lines.push(`draft: ${payload.publishAsDraft ? 'true' : 'false'}`);
  if (mergedTags.length > 0) {
    lines.push(`tags: [${mergedTags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  lines.push('---', '');

  const body = (payload.markdown?.trim() || payload.html).trimEnd();
  lines.push(body);

  if (payload.schemaJsonLd && inlineJsonLd) {
    const safeJson = serializeJsonLdSafe(payload.schemaJsonLd);
    if (fileExtension === 'mdx') {
      lines.push(
        '',
        `export const jsonLd = ${safeJson};`,
        '',
        `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\\\u003c').replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029') }} />`,
      );
    } else {
      lines.push('', `<script type="application/ld+json">\n${safeJson}\n</script>`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function encodePathSegments(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

@Injectable()
export class GithubMdxConnector implements CmsConnector {
  readonly provider = 'GITHUB_MDX' as const;

  constructor(
    @Inject(OutboundHttpClient) private readonly http: OutboundHttpClient,
    @Optional() @Inject(GITHUB_API_BASE_URL) private readonly apiBaseOverride?: string,
  ) {}

  async testConnection(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    _input?: TestChannelConnectionInput,
  ): Promise<ConnectorTestResult> {
    const token = this.resolveToken(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const apiBase = this.resolveApiBaseUrl(conn);
    const coords = resolveGitHubRepoCoords(conn);

    if (coords) {
      const repoUrl = joinBasePath(
        apiBase,
        `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}`,
      );
      const repo = await this.requestJson<GitHubRepoResponse>(
        repoUrl,
        'GET',
        token,
        undefined,
        secretCandidates,
      );
      if (repo.permissions && repo.permissions.push === false) {
        throw new ConnectorError(
          this.provider,
          'FORBIDDEN',
          'GitHub Token 缺少目标仓库写入权限（push=false）',
          403,
        );
      }
      const defaultBranch = repo.default_branch?.trim() || conn.configJson.branch?.trim() || 'main';
      const fullName = repo.full_name?.trim() || `${coords.owner}/${coords.repo}`;
      const target: ChannelRemoteTargetDto = {
        id: `${coords.owner}/${coords.repo}`,
        name: fullName,
        handle: defaultBranch,
        ...(repo.html_url && isSafeDistributionHttpUrl(repo.html_url)
          ? { url: repo.html_url }
          : {}),
      };
      return {
        ok: true,
        message: `GitHub 仓库连接正常：${fullName}（默认分支 ${defaultBranch}）`,
        targets: [target],
        discoveredConfig: { branch: defaultBranch },
      };
    }

    const user = await this.requestJson<GitHubUserResponse>(
      joinBasePath(apiBase, '/user'),
      'GET',
      token,
      undefined,
      secretCandidates,
    );
    const repos = await this.requestJson<GitHubRepoResponse[]>(
      joinBasePath(apiBase, '/user/repos', { per_page: 20, sort: 'updated' }),
      'GET',
      token,
      undefined,
      secretCandidates,
    );
    const targets: ChannelRemoteTargetDto[] = [];
    if (Array.isArray(repos)) {
      for (const r of repos) {
        const fullName = r.full_name?.trim();
        if (!fullName) continue;
        targets.push({
          id: fullName,
          name: fullName,
          ...(r.default_branch?.trim() ? { handle: r.default_branch.trim() } : {}),
          ...(r.html_url && isSafeDistributionHttpUrl(r.html_url) ? { url: r.html_url } : {}),
        });
      }
    }

    return {
      ok: true,
      message: `GitHub 账号连接正常：${user.login?.trim() || 'GitHub User'}，发现 ${targets.length} 个仓库`,
      targets,
    };
  }

  async listTargets(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    input?: TestChannelConnectionInput,
  ): Promise<ChannelRemoteTargetDto[]> {
    const res = await this.testConnection(conn, secrets, input);
    return res.targets;
  }

  async publish(
    conn: ConnectorConnectionContext,
    secrets: ConnectorSecrets,
    payload: ConnectorPublishPayload,
  ): Promise<ConnectorPublishResult> {
    const token = this.resolveToken(secrets);
    const secretCandidates = collectSecretCandidates(
      secrets,
      conn.configJson as Record<string, unknown>,
    );
    await this.assertSafeSiteBaseUrl(conn.siteBaseUrl, secretCandidates);

    const coords = resolveGitHubRepoCoords(conn);
    if (!coords) {
      throw new ConnectorError(
        this.provider,
        'CONFIG_ERROR',
        '请配置 GitHub 仓库信息（repoOwner 与 repoName）',
      );
    }

    const contentDir = normalizeGitHubContentDir(conn.configJson.contentDir);
    const fileExtension: 'mdx' | 'md' = conn.configJson.fileExtension === 'md' ? 'md' : 'mdx';
    const slug = slugifyAscii(payload.slug?.trim() || payload.title);
    const filePath = contentDir
      ? `${contentDir}/${slug}.${fileExtension}`
      : `${slug}.${fileExtension}`;
    const encodedPath = encodePathSegments(filePath);
    const apiBase = this.resolveApiBaseUrl(conn);
    const nowDateIso = new Date().toISOString().slice(0, 10);

    let baseBranch =
      conn.configJson.branch !== undefined && conn.configJson.branch !== ''
        ? normalizeGitHubBranch(conn.configJson.branch)
        : '';

    // 正式发布模式下提前执行公开链接模板/主域名 SSRF 校验，阻断时绝不向远端仓库写入孤儿提交
    let prevalidatedPublishedUrl: string | undefined;
    if (!payload.publishAsDraft) {
      const urlTemplate = conn.configJson.publicUrlTemplate?.trim();
      if (urlTemplate) {
        const rendered = renderGitHubPublicUrl(urlTemplate, {
          slug,
          locale: payload.targetLocale?.trim() || 'en-US',
          date: nowDateIso,
          path: filePath,
        });
        prevalidatedPublishedUrl = await validatePublishedUrl(this.http, this.provider, rendered);
      } else if (conn.configJson.primaryDomain?.trim()) {
        const candidate = `${trimTrailingSlashes(conn.configJson.primaryDomain)}/${encodeURIComponent(slug)}`;
        prevalidatedPublishedUrl = await validatePublishedUrl(this.http, this.provider, candidate);
      }
    }

    if (!baseBranch) {
      const repoInfo = await this.requestJson<GitHubRepoResponse>(
        joinBasePath(
          apiBase,
          `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}`,
        ),
        'GET',
        token,
        undefined,
        secretCandidates,
      );
      baseBranch = normalizeGitHubBranch(repoInfo.default_branch?.trim() || 'main');
    }

    const mergedTags = this.mergeTags(payload.tags, conn.configJson.tags);
    const canonicalUrl = this.resolveCanonicalUrl(payload);
    const documentContent = buildGitHubMdxDocument(
      payload,
      fileExtension,
      conn.configJson.inlineJsonLd !== false,
      mergedTags,
      canonicalUrl,
      nowDateIso,
    );
    const contentBase64 = Buffer.from(documentContent, 'utf8').toString('base64');

    if (payload.publishAsDraft) {
      // 1. 获取基线分支 HEAD SHA
      const refData = await this.requestJson<GitHubRefResponse>(
        joinBasePath(
          apiBase,
          `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/git/ref/heads/${encodePathSegments(baseBranch)}`,
        ),
        'GET',
        token,
        undefined,
        secretCandidates,
      );
      const baseSha = refData?.object?.sha?.trim() ?? '';
      if (!baseSha) {
        throw new ConnectorError(
          this.provider,
          'UPSTREAM_ERROR',
          `无法获取 GitHub 分支 ${baseBranch} 的最新提交 SHA`,
        );
      }

      // 2. 创建草稿分支
      const headBranch = `geomix/${slug.slice(0, 40)}-${randomBytes(3).toString('hex')}`;
      await this.requestJson<unknown>(
        joinBasePath(
          apiBase,
          `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/git/refs`,
        ),
        'POST',
        token,
        { ref: `refs/heads/${headBranch}`, sha: baseSha },
        secretCandidates,
      );

      // 3. 在草稿分支上写入/更新 MDX 文件
      const existingSha = await this.fetchExistingFileSha(
        apiBase,
        coords.owner,
        coords.repo,
        encodedPath,
        headBranch,
        token,
        secretCandidates,
      );
      await this.requestJson<GitHubContentPutResponse>(
        joinBasePath(
          apiBase,
          `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/contents/${encodedPath}`,
        ),
        'PUT',
        token,
        {
          message: `docs(geo): add draft ${slug}.${fileExtension}`,
          content: contentBase64,
          branch: headBranch,
          ...(existingSha ? { sha: existingSha } : {}),
        },
        secretCandidates,
      );

      // 4. 开启 Draft PR
      const pr = await this.requestJson<GitHubPullResponse>(
        joinBasePath(
          apiBase,
          `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/pulls`,
        ),
        'POST',
        token,
        {
          title: `GEO Draft: ${payload.title}`.slice(0, 240),
          head: headBranch,
          base: baseBranch,
          body: `Automated GeoMix GEO draft commit for \`${filePath}\`.`,
          draft: true,
        },
        secretCandidates,
      );

      const prNumber = typeof pr?.number === 'number' ? pr.number : undefined;
      const prUrl = pr?.html_url?.trim();
      if (!prNumber && !prUrl) {
        throw new ConnectorError(
          this.provider,
          'UPSTREAM_ERROR',
          'GitHub 未返回 Pull Request 信息',
        );
      }

      return {
        remotePostId: prNumber !== undefined ? `pr#${prNumber}` : filePath,
        remoteAdminUrl: prUrl && isSafeDistributionHttpUrl(prUrl) ? prUrl : undefined,
        remotePublishedUrl: undefined,
        publishedAsDraft: true,
      };
    }

    // 正式发布模式：幂等检查已有文件 SHA，直接提交至目标分支
    const existingSha = await this.fetchExistingFileSha(
      apiBase,
      coords.owner,
      coords.repo,
      encodedPath,
      baseBranch,
      token,
      secretCandidates,
    );
    const putRes = await this.requestJson<GitHubContentPutResponse>(
      joinBasePath(
        apiBase,
        `/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/contents/${encodedPath}`,
      ),
      'PUT',
      token,
      {
        message: existingSha
          ? `docs(geo): update ${slug}.${fileExtension}`
          : `docs(geo): publish ${slug}.${fileExtension}`,
        content: contentBase64,
        branch: baseBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      },
      secretCandidates,
    );

    const remotePostId = putRes?.commit?.sha?.trim() || putRes?.content?.sha?.trim() || filePath;
    const rawAdminUrl = putRes?.content?.html_url?.trim() || putRes?.commit?.html_url?.trim();
    const remoteAdminUrl =
      rawAdminUrl && isSafeDistributionHttpUrl(rawAdminUrl) ? rawAdminUrl : undefined;

    let remotePublishedUrl: string | undefined = prevalidatedPublishedUrl;
    if (!remotePublishedUrl && putRes?.content?.html_url?.trim()) {
      remotePublishedUrl = await validatePublishedUrl(
        this.http,
        this.provider,
        putRes.content.html_url,
      );
    }

    return {
      remotePostId,
      remoteAdminUrl,
      remotePublishedUrl,
      publishedAsDraft: false,
    };
  }

  private resolveToken(secrets: ConnectorSecrets): string {
    const token = secrets.token?.trim() ?? '';
    if (!token) {
      throw new ConnectorError(this.provider, 'CONFIG_ERROR', '缺少 GitHub Personal Access Token');
    }
    return token;
  }

  private async assertSafeSiteBaseUrl(
    siteBaseUrl: string,
    secretCandidates: readonly string[],
  ): Promise<void> {
    try {
      await this.http.assertAllowedUrl(siteBaseUrl);
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }
  }

  private resolveApiBaseUrl(conn: ConnectorConnectionContext): string {
    const configApiBase = (conn.configJson as Record<string, unknown>).apiBaseUrl;
    if (typeof configApiBase === 'string' && configApiBase.trim()) {
      return configApiBase.trim();
    }
    if (this.apiBaseOverride?.trim()) {
      return this.apiBaseOverride.trim();
    }
    try {
      const parsed = new URL(conn.siteBaseUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const bareHost = host.replace(/^\[|\]$/g, '');
      if (
        host === 'api.github.com' ||
        host.endsWith('.e2e.example') ||
        isIP(bareHost) !== 0 ||
        parsed.pathname.startsWith('/github')
      ) {
        return conn.siteBaseUrl.trim();
      }
    } catch {
      // Fallback to official GitHub REST API base
    }
    return DEFAULT_GITHUB_API_BASE_URL;
  }

  private async fetchExistingFileSha(
    apiBase: string,
    owner: string,
    repo: string,
    encodedPath: string,
    branch: string,
    token: string,
    secretCandidates: readonly string[],
  ): Promise<string | undefined> {
    const url = joinBasePath(
      apiBase,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
      { ref: branch },
    );
    let response;
    try {
      response = await this.http.request({
        url,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status === 404) {
      return undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<GitHubContentGetResponse>(response.body);
    return typeof parsed?.sha === 'string' && parsed.sha.trim() ? parsed.sha.trim() : undefined;
  }

  private mergeTags(payloadTags?: readonly string[], configTags?: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const source of [payloadTags ?? [], configTags ?? []]) {
      for (const raw of source) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
    return out;
  }

  private resolveCanonicalUrl(payload: ConnectorPublishPayload): string | undefined {
    const candidates = [
      payload.canonicalUrl,
      typeof payload.extras?.canonicalUrl === 'string' ? payload.extras.canonicalUrl : undefined,
      typeof payload.extras?.canonicalGuideHint === 'string'
        ? payload.extras.canonicalGuideHint
        : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isSafeDistributionHttpUrl(candidate.trim())) {
        return candidate.trim();
      }
    }
    return undefined;
  }

  private async requestJson<T>(
    url: string,
    method: 'GET' | 'POST' | 'PUT',
    token: string,
    body: unknown,
    secretCandidates: readonly string[],
  ): Promise<T> {
    let response;
    try {
      response = await this.http.request({
        url,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw mapTransportError(this.provider, error, secretCandidates);
    }

    if (response.status < 200 || response.status >= 300) {
      throw mapHttpStatusError(this.provider, response.status, response.body, secretCandidates);
    }

    const parsed = parseJsonSafe<T>(response.body);
    if (!parsed || typeof parsed !== 'object') {
      throw new ConnectorError(this.provider, 'UPSTREAM_ERROR', 'GitHub 接口返回了无效 JSON 响应');
    }
    return parsed;
  }
}
