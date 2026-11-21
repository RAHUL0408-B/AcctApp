import { PoolClient } from 'pg';
import { InvoiceView, renderInvoicePdf } from '../firm/exporter';
import { templateConfigFor } from '../firm/templates';
import { brandingFor } from '../settings/settings';

const iso = (x: unknown) => (x == null ? null : typeof x === 'string' ? x.slice(0, 10) : new Date((x as Date).getTime() - (x as Date).getTimezoneOffset() * 60000).toISOString().slice(0, 10));

/**
 * A document as it is printed. Carries what Rule 46 of the CGST Rules asks for on a tax invoice: the customer's name,
 * address and GSTIN, the delivery address where it differs, HSN, quantity with its unit, place of supply with the state
 * name, whether tax is payable on reverse charge, and the supplier's signature. Call inside withOrg().
 */
export async function loadInvoiceView(c: PoolClient, orgId: number, id: number): Promise<(InvoiceView & { contactEmail: string | null }) | null> {
  const org = (await c.query('SELECT name,legal_name,gstin FROM organizations WHERE id=$1', [orgId])).rows[0];
  const d = (await c.query(`SELECT d.*, ct.name AS cname, ct.gstin AS cgstin, ct.email AS cemail, ct.address_line1, ct.address_line2, ct.city, ct.pincode, ct.state_code AS cstate,
      ct.ship_line1, ct.ship_line2, ct.ship_city, ct.ship_state_code, ct.ship_pincode, ct.country, ct.is_sez,
      (SELECT name FROM gst_states WHERE code=d.place_of_supply) AS pos_name, (SELECT name FROM gst_states WHERE code=ct.state_code) AS cstate_name,
      (SELECT name FROM gst_states WHERE code=ct.ship_state_code) AS ship_state_name
    FROM documents d JOIN contacts ct ON ct.id=d.contact_id WHERE d.id=$1`, [id])).rows[0];
  if (!d) return null;
  const lines = (await c.query('SELECT description,hsn_sac,unit,qty_milli,rate,taxable,gst_rate_bp FROM document_lines WHERE doc_id=$1 ORDER BY id', [id])).rows;
  const place = (a: string | null, b: string | null, city: string | null, pin: string | null, state: string | null) =>
    [a, b, [city, pin].filter(Boolean).join(' - '), state].filter((x) => x && String(x).trim()) as string[];
  const billAddress = place(d.address_line1, d.address_line2, d.city, d.pincode, d.cstate_name ? `${d.cstate_name} (${d.cstate})` : null);
  const shipAddress = d.ship_line1 || d.ship_city || d.ship_pincode
    ? place(d.ship_line1, d.ship_line2, d.ship_city, d.ship_pincode, d.ship_state_name ? `${d.ship_state_name} (${d.ship_state_code})` : null) : null;
  const pos = d.place_of_supply === '96' ? 'Outside India (96)' : d.place_of_supply ? `${d.pos_name ?? ''} (${d.place_of_supply})`.trim() : null;
  return {
    orgName: org.name, orgLegalName: org.legal_name ?? null, orgGstin: org.gstin, type: d.doc_type, number: d.number, issueDate: iso(d.issue_date)!, dueDate: iso(d.due_date),
    contact: d.cname, contactGstin: d.cgstin, contactAddress: billAddress, shipTo: shipAddress, contactEmail: d.cemail,
    placeOfSupply: pos, reverseCharge: d.supply_type === 'reverse_charge', supplyNote: SUPPLY_NOTE[d.supply_type as string] ?? null,
    subtotal: Number(d.subtotal), cgst: Number(d.cgst), sgst: Number(d.sgst), igst: Number(d.igst), cess: Number(d.cess ?? 0), total: Number(d.total), tdsAmount: Number(d.tds_amount), notes: d.notes,
    lines: lines.map((l) => ({ description: l.description, hsnSac: l.hsn_sac, unit: l.unit, qtyMilli: Number(l.qty_milli), rate: Number(l.rate), taxable: Number(l.taxable), gstRateBp: l.gst_rate_bp })),
    branding: await brandingFor(c, { type: d.doc_type, number: d.number, total: Number(d.total), tdsAmount: Number(d.tds_amount), currency: d.currency }),
  };
}

/** Wording printed for supplies that are not ordinary taxable ones. */
const SUPPLY_NOTE: Record<string, string> = {
  export_lut: 'Supply meant for export under Letter of Undertaking without payment of integrated tax',
  export_igst: 'Supply meant for export on payment of integrated tax',
  sez_lut: 'Supply to SEZ unit or developer for authorised operations under LUT without payment of integrated tax',
  sez_igst: 'Supply to SEZ unit or developer for authorised operations on payment of integrated tax',
  unregistered: 'Purchase from a supplier not registered under GST',
};

/** Load a document with its lines and render it as a PDF. Call inside withOrg(). */
export async function buildInvoicePdf(c: PoolClient, orgId: number, id: number): Promise<{ number: string; pdf: Buffer; contactEmail: string | null; contactName: string; docType: string; total: number; dueDate: string | null } | null> {
  const view = await loadInvoiceView(c, orgId, id);
  if (!view) return null;
  return { number: view.number, pdf: await renderInvoicePdf(view, { ...(await templateConfigFor(c, 'document')), hide: [] }), contactEmail: view.contactEmail, contactName: view.contact, docType: view.type, total: view.total, dueDate: view.dueDate };
}
