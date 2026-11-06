// Settings for how exports look: ready-made templates, templates an owner designs, and which one reports and invoices use.
// Anyone in the organisation can read the settings; only the owner can change them.
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { getPool, withOrg } from '../db/db';
import { writeAudit } from '../audit/audit';
import { AuthGuard, Ip, UserId, parse } from '../common/guard';
import { requireOrg } from '../tenancy/acl';
import { renderInvoicesPdf, renderPdfMulti } from './render';
import { DEFAULT_CONFIG, sanitizeConfig, TEMPLATE_INFO } from './styles';
import { resolveRef, SAMPLE_TABLE, sampleInvoice } from './templates';

const MAX_TEMPLATES = 20;
const name = z.string().trim().min(1, 'Give the template a name').max(60);
const ref = z.string().max(20);

async function requireOwner(uid: number, orgId: number) {
  const role = await requireOrg(uid, orgId, 'read');
  if (role !== 'owner') throw new ForbiddenException('Only the owner can change export templates');
}

@Controller('orgs/:orgId')
@UseGuards(AuthGuard)
export class ExportSettingsController {
  @Get('export-settings')
  async settings(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number) {
    const role = await requireOrg(uid, orgId, 'read');
    return withOrg(orgId, async (c) => {
      const templates = (await c.query('SELECT id,name,config FROM export_templates ORDER BY name')).rows.map((r) => ({ id: Number(r.id), name: r.name, config: sanitizeConfig(r.config) }));
      const d = (await c.query('SELECT report_ref, document_ref FROM export_defaults')).rows[0];
      return { canEdit: role === 'owner', presets: TEMPLATE_INFO, templates, defaults: { report: d?.report_ref ?? 'classic', document: d?.document_ref ?? 'classic' }, limit: MAX_TEMPLATES };
    });
  }

  @Post('export-templates')
  async create(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOwner(uid, orgId);
    const b = parse(z.object({ name, config: z.record(z.unknown()) }), body);
    const config = sanitizeConfig(b.config);
    return withOrg(orgId, async (c) => {
      if (Number((await c.query('SELECT count(*) AS n FROM export_templates')).rows[0].n) >= MAX_TEMPLATES) throw new BadRequestException(`You can keep up to ${MAX_TEMPLATES} templates. Delete one you no longer use.`);
      if ((await c.query('SELECT 1 FROM export_templates WHERE lower(name)=lower($1)', [b.name])).rowCount) throw new ConflictException('A template with this name already exists');
      const r = (await c.query('INSERT INTO export_templates(org_id,name,config,created_by) VALUES ($1,$2,$3,$4) RETURNING id', [orgId, b.name, JSON.stringify(config), uid])).rows[0];
      await writeAudit(c, { orgId, userId: uid, action: 'create', entity: 'export_template', entityId: r.id, after: { name: b.name }, ip });
      return { id: Number(r.id) };
    });
  }

  @Put('export-templates/:id')
  async update(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOwner(uid, orgId);
    const b = parse(z.object({ name: name.optional(), config: z.record(z.unknown()).optional() }), body);
    return withOrg(orgId, async (c) => {
      const row = (await c.query('SELECT name, config FROM export_templates WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('Template not found');
      if (b.name && (await c.query('SELECT 1 FROM export_templates WHERE lower(name)=lower($1) AND id<>$2', [b.name, id])).rowCount) throw new ConflictException('A template with this name already exists');
      const config = b.config ? sanitizeConfig(b.config) : sanitizeConfig(row.config);
      await c.query('UPDATE export_templates SET name=$2, config=$3, updated_at=now() WHERE id=$1', [id, b.name ?? row.name, JSON.stringify(config)]);
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'export_template', entityId: id, after: { name: b.name ?? row.name }, ip });
      return { ok: true };
    });
  }

  @Delete('export-templates/:id')
  async remove(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    await requireOwner(uid, orgId);
    return withOrg(orgId, async (c) => {
      if (!(await c.query('DELETE FROM export_templates WHERE id=$1 RETURNING id', [id])).rowCount) throw new NotFoundException('Template not found');
      // Anything that used it goes back to Classic, so exports never point at a deleted design.
      await c.query("UPDATE export_defaults SET report_ref = CASE WHEN report_ref = $1 THEN 'classic' ELSE report_ref END, document_ref = CASE WHEN document_ref = $1 THEN 'classic' ELSE document_ref END", [`custom:${id}`]);
      await writeAudit(c, { orgId, userId: uid, action: 'delete', entity: 'export_template', entityId: id, ip });
      return { ok: true };
    });
  }

  @Put('export-defaults')
  async setDefaults(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Ip() ip: string) {
    await requireOwner(uid, orgId);
    const b = parse(z.object({ report: ref, document: ref }), body);
    return withOrg(orgId, async (c) => {
      for (const r of [b.report, b.document]) if (!(await resolveRef(c, r))) throw new BadRequestException('Choose one of the listed templates');
      await c.query(`INSERT INTO export_defaults(org_id,report_ref,document_ref,updated_by) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (org_id) DO UPDATE SET report_ref=EXCLUDED.report_ref, document_ref=EXCLUDED.document_ref, updated_by=EXCLUDED.updated_by, updated_at=now()`, [orgId, b.report, b.document, uid]);
      await writeAudit(c, { orgId, userId: uid, action: 'update', entity: 'export_defaults', entityId: orgId, after: b, ip });
      return { ok: true };
    });
  }

  /** A sample report or invoice drawn with the design on screen (saved or not), so it can be judged before saving. */
  @Post('export-preview')
  async preview(@UserId() uid: number, @Param('orgId', ParseIntPipe) orgId: number, @Body() body: unknown, @Res() res: Response) {
    await requireOwner(uid, orgId);
    const b = parse(z.object({ config: z.record(z.unknown()), kind: z.enum(['report', 'invoice']) }), body);
    const org = (await getPool().query('SELECT name FROM organizations WHERE id=$1', [orgId])).rows[0];
    const o = { ...sanitizeConfig(b.config, DEFAULT_CONFIG), hide: [] as number[] };
    const pdf = b.kind === 'report' ? await renderPdfMulti([SAMPLE_TABLE], org.name, o) : await renderInvoicesPdf([sampleInvoice(org.name)], o);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.send(pdf);
  }
}
