import { PoolClient } from 'pg';
import { InvoiceView, renderInvoicePdf } from '../firm/exporter';
import { templateConfigFor } from '../firm/templates';

/** Load a document with its lines and render it as a PDF. Call inside withOrg(). */
export async function buildInvoicePdf(c: PoolClient, orgId: number, id: number): Promise<{ number: string; pdf: Buffer; contactEmail: string | null; contactName: string; docType: string } | null> {
  const org = (await c.query('SELECT name,gstin FROM organizations WHERE id=$1', [orgId])).rows[0];
  const d = (await c.query('SELECT d.*, ct.name AS cname, ct.gstin AS cgstin, ct.email AS cemail FROM documents d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=$1', [id])).rows[0];
  if (!d) return null;
  const lines = (await c.query('SELECT description,hsn_sac,qty_milli,rate,taxable,gst_rate_bp FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows;
  const view: InvoiceView = {
    orgName: org.name, orgGstin: org.gstin, type: d.doc_type, number: d.number, issueDate: d.issue_date, dueDate: d.due_date, contact: d.cname, contactGstin: d.cgstin,
    placeOfSupply: d.place_of_supply, subtotal: Number(d.subtotal), cgst: Number(d.cgst), sgst: Number(d.sgst), igst: Number(d.igst), total: Number(d.total), tdsAmount: Number(d.tds_amount), notes: d.notes,
    lines: lines.map((l) => ({ description: l.description, hsnSac: l.hsn_sac, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), gstRateBp: l.gst_rate_bp })),
  };
  return { number: d.number, pdf: await renderInvoicePdf(view, { ...(await templateConfigFor(c, 'document')), hide: [] }), contactEmail: d.cemail, contactName: d.cname, docType: d.doc_type };
}
