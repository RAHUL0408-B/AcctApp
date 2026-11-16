// GSTR-1 as a JSON file in the layout the GST portal's offline tool reads (B2B, B2CL, B2CS, CDNR, CDNUR, EXP, HSN).
// Amounts are in rupees with two decimals; dates are dd-mm-yyyy. It is a draft to check before upload, not a filing.
import { PoolClient } from 'pg';

const r2 = (paise: number) => Math.round(paise) / 100;
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const B2CL_LIMIT = 25000000; // Rs 2,50,000: inter-state invoices to unregistered buyers above this are reported one by one

interface Item { rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }

/** Lines of each document grouped by GST rate, as the portal wants them. */
async function itemsByDoc(c: PoolClient, ids: number[]) {
  const rows = ids.length ? (await c.query(
    `SELECT doc_id, gst_rate_bp, SUM(taxable) AS t, SUM(igst) AS i, SUM(cgst) AS c, SUM(sgst) AS s, SUM(cess) AS cs
       FROM document_lines WHERE doc_id = ANY($1) GROUP BY doc_id, gst_rate_bp ORDER BY doc_id, gst_rate_bp`, [ids])).rows : [];
  const by = new Map<number, Item[]>();
  for (const r of rows) {
    const list = by.get(Number(r.doc_id)) ?? [];
    list.push({ rt: Number(r.gst_rate_bp) / 100, txval: r2(Number(r.t)), iamt: r2(Number(r.i)), camt: r2(Number(r.c)), samt: r2(Number(r.s)), csamt: r2(Number(r.cs)) });
    by.set(Number(r.doc_id), list);
  }
  return by;
}
const itms = (list: Item[] = [], igstOnly = false) => list.map((it, k) => ({ num: k + 1, itm_det: igstOnly ? { txval: it.txval, rt: it.rt, iamt: it.iamt, csamt: it.csamt } : it }));

export async function gstr1Json(c: PoolClient, from: string, to: string) {
  const org = (await c.query('SELECT gstin, state_code FROM organizations WHERE id = current_org()')).rows[0];
  if (!org?.gstin) throw new Error('Add the GSTIN in organisation settings first: GSTR-1 is filed against a GSTIN');
  const docs = (await c.query(
    `SELECT d.id, d.doc_type, d.number, d.issue_date::text AS date, d.total, d.place_of_supply AS pos, d.supply_type, ct.gstin AS ctin
       FROM documents d JOIN contacts ct ON ct.id=d.contact_id
      WHERE d.status='posted' AND d.doc_type IN ('invoice','credit_note') AND d.issue_date BETWEEN $1 AND $2 AND d.replaced_by IS NULL ORDER BY d.issue_date, d.id`, [from, to])).rows;
  const items = await itemsByDoc(c, docs.map((d) => Number(d.id)));
  const isExport = (d: any) => String(d.supply_type).startsWith('export');
  const invTyp = (d: any) => (d.supply_type === 'sez_igst' ? 'SEWP' : d.supply_type === 'sez_lut' ? 'SEWOP' : 'R');

  const group = <T>(list: any[], key: (d: any) => string, make: (k: string, ds: any[]) => T) => {
    const m = new Map<string, any[]>();
    for (const d of list) m.set(key(d), [...(m.get(key(d)) ?? []), d]);
    return [...m.entries()].map(([k, ds]) => make(k, ds));
  };
  const inv = docs.filter((d) => d.doc_type === 'invoice' && !isExport(d)), notes = docs.filter((d) => d.doc_type === 'credit_note');
  const reg = inv.filter((d) => d.ctin), unreg = inv.filter((d) => !d.ctin);
  const large = (d: any) => d.pos !== org.state_code && Number(d.total) > B2CL_LIMIT;

  const b2b = group(reg, (d) => d.ctin, (ctin, ds) => ({ ctin, inv: ds.map((d) => ({ inum: d.number, idt: ddmmyyyy(d.date), val: r2(Number(d.total)), pos: d.pos, rchrg: 'N', inv_typ: invTyp(d), itms: itms(items.get(Number(d.id))) })) }));
  const b2cl = group(unreg.filter(large), (d) => d.pos, (pos, ds) => ({ pos, inv: ds.map((d) => ({ inum: d.number, idt: ddmmyyyy(d.date), val: r2(Number(d.total)), itms: itms(items.get(Number(d.id)), true) })) }));
  // B2CS: everything else to unregistered buyers, summed by place of supply and rate (credit notes to them reduce it).
  const small = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const addSmall = (d: any, sign: number) => {
    for (const it of items.get(Number(d.id)) ?? []) {
      const k = `${d.pos}|${it.rt}`;
      const e = small.get(k) ?? { sply_ty: d.pos === org.state_code ? 'INTRA' : 'INTER', pos: d.pos, typ: 'OE', rt: it.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      for (const f of ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const) e[f] = Math.round((e[f] + sign * it[f]) * 100) / 100;
      small.set(k, e);
    }
  };
  unreg.filter((d) => !large(d)).forEach((d) => addSmall(d, 1));
  notes.filter((d) => !d.ctin && !large(d)).forEach((d) => addSmall(d, -1));
  const noteRow = (d: any) => ({ ntty: 'C', nt_num: d.number, nt_dt: ddmmyyyy(d.date), val: r2(Number(d.total)), pos: d.pos, rchrg: 'N', inv_typ: invTyp(d), itms: itms(items.get(Number(d.id))) });
  const cdnr = group(notes.filter((d) => d.ctin), (d) => d.ctin, (ctin, ds) => ({ ctin, nt: ds.map(noteRow) }));
  const cdnur = notes.filter((d) => !d.ctin && large(d)).map((d) => ({ typ: 'B2CL', ntty: 'C', nt_num: d.number, nt_dt: ddmmyyyy(d.date), val: r2(Number(d.total)), pos: d.pos, itms: itms(items.get(Number(d.id)), true) }));
  const exps = docs.filter((d) => d.doc_type === 'invoice' && isExport(d));
  const exp = group(exps, (d) => (d.supply_type === 'export_igst' ? 'WPAY' : 'WOPAY'), (t, ds) => ({ exp_typ: t,
    inv: ds.map((d) => ({ inum: d.number, idt: ddmmyyyy(d.date), val: r2(Number(d.total)), itms: (items.get(Number(d.id)) ?? []).map((it) => ({ txval: it.txval, rt: it.rt, iamt: it.iamt, csamt: it.csamt })) })) }));
  const hsnRows = (await c.query(
    `SELECT COALESCE(l.hsn_sac,'') AS hsn, l.gst_rate_bp, SUM(CASE WHEN d.doc_type='credit_note' THEN -l.qty_milli ELSE l.qty_milli END) AS q,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.taxable ELSE l.taxable END) AS t, SUM(CASE WHEN d.doc_type='credit_note' THEN -l.igst ELSE l.igst END) AS i,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.cgst ELSE l.cgst END) AS c, SUM(CASE WHEN d.doc_type='credit_note' THEN -l.sgst ELSE l.sgst END) AS s,
            SUM(CASE WHEN d.doc_type='credit_note' THEN -l.cess ELSE l.cess END) AS cs
       FROM document_lines l JOIN documents d ON d.id=l.doc_id
      WHERE d.id = ANY($1) GROUP BY 1,2 ORDER BY 1,2`, [docs.map((d) => Number(d.id))])).rows;
  const hsn = { data: hsnRows.map((r, k) => {
    const txval = r2(Number(r.t)), iamt = r2(Number(r.i)), camt = r2(Number(r.c)), samt = r2(Number(r.s)), csamt = r2(Number(r.cs));
    return { num: k + 1, hsn_sc: r.hsn, desc: '', uqc: 'NOS', qty: Number(r.q) / 1000, rt: Number(r.gst_rate_bp) / 100, txval, iamt, camt, samt, csamt, val: Math.round((txval + iamt + camt + samt + csamt) * 100) / 100 };
  }) };
  const fp = `${to.slice(5, 7)}${to.slice(0, 4)}`;
  const out: Record<string, unknown> = { gstin: org.gstin, fp };
  if (b2b.length) out.b2b = b2b;
  if (b2cl.length) out.b2cl = b2cl;
  if (small.size) out.b2cs = [...small.values()];
  if (cdnr.length) out.cdnr = cdnr;
  if (cdnur.length) out.cdnur = cdnur;
  if (exp.length) out.exp = exp;
  if (hsn.data.length) out.hsn = hsn;
  return out;
}
