import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { extensionTasksQuerySchema, ok } from '@geomix/shared';
import { parseBody } from '../common/parse-body';
import { flattenQuery, parseEntityId } from '../studio/studio.controller';
import { ExtensionAuthGuard } from './extension-auth.guard';
import { getExtensionAuth } from './extension-auth.types';
import { ExtensionBridgeService } from './extension-bridge.service';

@Controller({ path: 'extension', version: '2' })
@UseGuards(ExtensionAuthGuard)
export class ExtensionBridgeController {
  constructor(
    @Inject(ExtensionBridgeService)
    private readonly bridgeService: ExtensionBridgeService,
  ) {}

  @Get('me')
  async getMe(@Req() req: unknown) {
    const auth = getExtensionAuth(req);
    const result = await this.bridgeService.getMe(auth);
    return ok(result);
  }

  @Get('tasks')
  async listTasks(@Req() req: unknown, @Query() rawQuery: Record<string, unknown>) {
    const auth = getExtensionAuth(req);
    const query = parseBody(extensionTasksQuerySchema, flattenQuery(rawQuery ?? {}));
    const result = await this.bridgeService.listTasks(query, auth);
    return ok(result);
  }

  @Post('tasks/:taskId/confirm-published')
  @HttpCode(200)
  async confirmPublished(
    @Req() req: unknown,
    @Param('taskId') rawTaskId: string,
    @Body() body: unknown,
  ) {
    const auth = getExtensionAuth(req);
    const taskId = parseEntityId(rawTaskId, '分发任务编号');
    const result = await this.bridgeService.confirmPublished(taskId, body, auth);
    return ok(result);
  }
}
