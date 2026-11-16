import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AUTH_ERROR } from '@geomix/shared';
import { AuthService } from '../auth/auth.service';
import { BOARD_PATH, QueueProducer } from './queue.producer';

type HeaderRequest = {
  header(name: string): string | undefined;
};

type JsonResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
};

type BoardHandler = (req: unknown, res: unknown, next: unknown) => void;

/**
 * bull-board 只给管理员。商户和其他租户看到的是 404。
 * 面板里的任务载荷只有租户编号和运行编号。
 */
@Injectable()
export class BullBoardMount implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(QueueProducer) private readonly producer: QueueProducer,
  ) {}

  onModuleInit(): void {
    const server = this.adapterHost.httpAdapter?.getInstance() as
      { use?: (path: string, handler: BoardHandler) => void } | undefined;
    if (!server || typeof server.use !== 'function') return;
    server.use(BOARD_PATH, (req, res, next) => {
      void this.guard(req, res, next);
    });
  }

  private async guard(req: unknown, res: unknown, next: unknown): Promise<void> {
    const token = readToken(req as HeaderRequest);
    const response = res as JsonResponse;
    if (!token) {
      json(response, 401, AUTH_ERROR.UNAUTHORIZED, '未登录');
      return;
    }
    const result = await this.auth.authenticateAccess(token);
    if (!result.ok || result.auth.role !== 'ADMIN') {
      json(response, 404, AUTH_ERROR.NOT_FOUND, '不存在');
      return;
    }
    response.setHeader(
      'Set-Cookie',
      `geomix_board=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${BOARD_PATH}; Max-Age=600`,
    );
    try {
      const router = (await this.producer.boardRouter()) as BoardHandler;
      router(req, res, next);
    } catch {
      json(response, 503, 50000, '队列暂不可用');
    }
  }
}

function readToken(req: HeaderRequest): string | undefined {
  const header = req.header('authorization') ?? '';
  const bearer = /^Bearer\s+(\S+)$/.exec(header);
  if (bearer?.[1]) return bearer[1];
  const cookie = req.header('cookie') ?? '';
  const found = /(?:^|;\s*)geomix_board=([^;]+)/.exec(cookie);
  if (!found?.[1]) return undefined;
  try {
    return decodeURIComponent(found[1]);
  } catch {
    return undefined;
  }
}

function json(res: JsonResponse, status: number, code: number, msg: string): void {
  res.status(status).json({ code, msg, data: null });
}
