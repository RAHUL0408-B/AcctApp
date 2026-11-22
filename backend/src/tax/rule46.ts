// What a tax invoice must show under Rule 46 of the CGST Rules, 2017, checked before it is issued.
import { PoolClient } from 'pg';

export interface Rule46Input {
  docType: string; supplyType: string; issueDate: string; total: number;
  lines: { description: string; hsnSac?: string; unit?: string }[];
}

/**
 * Problems that would make the printed invoice non-compliant, in plain words, each saying what to do.
 * Only documents we issue to a customer (invoices and credit notes) are checked. Call inside withOrg().
 */
export interface Rule46Issue { text: string; /** the invoice cannot be issued while this is open (when strict checks are on) */ block: boolean }
export async function rule46Issues(c: PoolClient, orgId: number, contactId: number, b: Rule46Input): Promise<Rule46Issue[]> {
  if (b.docType !== 'invoice' && b.docType !== 'credit_note') return [];
  const org = (await c.query('SELECT name,legal_name,gstin,gst_scheme,address_line1,city,pincode FROM organizations WHERE id=$1', [orgId])).rows[0];
  const ct = (await c.query('SELECT name,gstin,country,address_line1,city,pincode,ship_line1,ship_city FROM contacts WHERE id=$1', [contactId])).rows[0];
  if (!org || !ct) return [];
  const out: Rule46Issue[] = [];
  const add = (text: string, block = true) => out.push({ text, block });
  const t = b.docType === 'credit_note' ? 'credit note' : 'tax invoice';
  if (org.gst_scheme !== 'composition' && !org.gstin) add(`Your own GSTIN is missing: add it in Settings, Duties and taxes. A ${t} must show the supplier's GSTIN.`);
  if (!org.address_line1 || !org.city) add(`Your business address is missing: add it in Settings, Organisation details. A ${t} must show the supplier's name and address.`);
  const addressed = !!(ct.address_line1 && ct.city);
  // Rule 46(e): the recipient's name, address and GSTIN for a registered buyer; for an unregistered one when the value is Rs 50,000 or more.
  if (ct.gstin && !addressed) add(`${ct.name} has a GSTIN but no address: add the billing address on the customer (Rule 46(e)).`);
  else if (!ct.gstin && b.total >= 5_000_000 && !addressed) add(`${ct.name} is not registered and the invoice is Rs 50,000 or more: the buyer's name and address are required (Rule 46(e)). Add the address on the customer.`);
  if (ct.country && ct.country !== 'IN' && !addressed) add(`${ct.name} is overseas: add the buyer's address for the export invoice.`);
  const noHsn = b.lines.filter((l) => !l.hsnSac).length;
  if (noHsn) add(`${noHsn} line(s) have no HSN/SAC code (Rule 46(d)).`);
  const noUnit = b.lines.filter((l) => !l.unit).length;
  if (noUnit) add(`${noUnit} line(s) have no unit: the invoice will print NOS for goods or OTH for services. Choose the unit of measurement (Rule 46(f)).`, false);
  return out;
}
