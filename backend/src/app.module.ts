import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { OrgController } from './tenancy/org.controller';
import { LedgerController } from './ledger/ledger.controller';
import { DocumentsController } from './accounting/documents.controller';
import { BankController } from './accounting/bank.controller';
import { ReportsController } from './accounting/reports.controller';
import { FirmController } from './firm/firm.controller';
import { LaunchController } from './ops/launch.controller';
import { ExtrasController } from './extras/extras.controller';
import { InventoryController } from './inventory/inventory.controller';
import { WorkflowController } from './workflow/workflow.controller';
import { PlanningController } from './planning/planning.controller';
import { PracticeController } from './practice/practice.controller';
import { InsightsController } from './insights/insights.controller';
import { MoneyController } from './banking/money.controller';
import { ProjectsController } from './projects/projects.controller';
import { log } from './ops/metrics';
import { LedgerError } from './ledger/ledger';

/** Turn accounting-rule and database-rule failures into clean 400 responses instead of 500s. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse(), req = http.getRequest();
    if (e instanceof HttpException) return res.status(e.getStatus()).json(e.getResponse());
    if (e instanceof LedgerError) return res.status(400).json({ message: e.message });
    if (e?.code === 'P0001') return res.status(400).json({ message: e.message }); // our database RAISE EXCEPTION rules
    if (e?.type === 'entity.too.large') return res.status(413).json({ message: 'Request is too large' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON' });
    log('error', 'unhandled error', { id: req.id, path: String(req.originalUrl ?? '').split('?')[0], error: e?.message, stack: String(e?.stack).split('\n').slice(0, 6) });
    return res.status(500).json({ message: 'Internal server error', requestId: req.id });
  }
}

@Module({ controllers: [AuthController, OrgController, LedgerController, DocumentsController, BankController, ReportsController, FirmController, LaunchController, ExtrasController,
  InventoryController, WorkflowController, PlanningController, PracticeController, InsightsController, MoneyController, ProjectsController] })
export class AppModule {}
