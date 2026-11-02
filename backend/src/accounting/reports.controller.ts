import { BadRequestException, Controller, Get, NotFoundException, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { withOrg } from '../db/db';
import { AuthGuard, UserId } from '../common/guard';
import { financialYearOf } from '../ledger/ledger';
import { requireOrg } from '../tenancy/acl';
import { aged, balanceSheet, gstr1, gstr3b, ledgerStatement, profitAndLoss } from './reports';

const D = /^\d{4}-\d{2}-\d{2}$/;
const dateOr = (v: string | undefined, fallback: string, name: string) => {
  if (v === undefined) return fallback;
  if (!D.test(v)) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  return v;
};
const today = () => new Date().toISOString().slice(0, 10);

@Controller('orgs/:orgId/reports')
@UseGuards(AuthGuard)
export class ReportsController {
  private async run<T>(uid: number, orgId: number, fn: Parameters<typeof withOrg<T>>[1]) {
    await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, fn);
  }

  @Get('pnl') pnl(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('from') from?: string, @Query('to') to?: string) {
    const fy = financialYearOf(today());
    return this.run(u, o, (c) => profitAndLoss(c, dateOr(from, fy.start, 'from'), dateOr(to, today(), 'to')));
  }
  @Get('balance-sheet') bs(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('asOf') asOf?: string) {
    return this.run(u, o, (c) => balanceSheet(c, dateOr(asOf, today(), 'asOf')));
  }
  @Get('ledger/:accountId') async ledger(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Param('accountId', ParseIntPipe) a: number, @Query('from') from?: string, @Query('to') to?: string) {
    const r = await this.run(u, o, (c) => ledgerStatement(c, a, from ? dateOr(from, '', 'from') : null, to ? dateOr(to, '', 'to') : null));
    if (!r) throw new NotFoundException('Account not found');
    return r;
  }
  @Get('aged-receivables') ar(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('asOf') asOf?: string) {
    return this.run(u, o, (c) => aged(c, 'receivables', dateOr(asOf, today(), 'asOf')));
  }
  @Get('aged-payables') ap(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('asOf') asOf?: string) {
    return this.run(u, o, (c) => aged(c, 'payables', dateOr(asOf, today(), 'asOf')));
  }
  @Get('gstr1') g1(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('from') from?: string, @Query('to') to?: string) {
    const fy = financialYearOf(today());
    return this.run(u, o, (c) => gstr1(c, dateOr(from, fy.start, 'from'), dateOr(to, today(), 'to')));
  }
  @Get('gstr3b') g3(@UserId() u: number, @Param('orgId', ParseIntPipe) o: number, @Query('from') from?: string, @Query('to') to?: string) {
    const fy = financialYearOf(today());
    return this.run(u, o, (c) => gstr3b(c, dateOr(from, fy.start, 'from'), dateOr(to, today(), 'to')));
  }
}
