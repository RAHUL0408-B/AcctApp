// Default Indian charts of accounts (Schedule III style grouping). Codes are strings so firms can renumber.
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface TemplateAccount { code: string; name: string; type: AccountType; group: string; }

const base: TemplateAccount[] = [
  { code: '1000', name: 'Cash in Hand', type: 'asset', group: 'Cash and Bank' },
  { code: '1010', name: 'Bank Account', type: 'asset', group: 'Cash and Bank' },
  { code: '1100', name: 'Sundry Debtors', type: 'asset', group: 'Current Assets' },
  { code: '1200', name: 'Inventory / Stock', type: 'asset', group: 'Current Assets' },
  { code: '1300', name: 'Input CGST', type: 'asset', group: 'GST Input Credit' },
  { code: '1310', name: 'Input SGST', type: 'asset', group: 'GST Input Credit' },
  { code: '1320', name: 'Input IGST', type: 'asset', group: 'GST Input Credit' },
  { code: '1400', name: 'TDS Receivable', type: 'asset', group: 'Current Assets' },
  { code: '1500', name: 'Advances and Deposits', type: 'asset', group: 'Current Assets' },
  { code: '1600', name: 'Fixed Assets', type: 'asset', group: 'Fixed Assets' },
  { code: '1690', name: 'Accumulated Depreciation', type: 'asset', group: 'Fixed Assets' },
  { code: '2000', name: 'Sundry Creditors', type: 'liability', group: 'Current Liabilities' },
  { code: '2100', name: 'Output CGST', type: 'liability', group: 'GST Payable' },
  { code: '2110', name: 'Output SGST', type: 'liability', group: 'GST Payable' },
  { code: '2120', name: 'Output IGST', type: 'liability', group: 'GST Payable' },
  { code: '2200', name: 'TDS Payable', type: 'liability', group: 'Statutory Dues' },
  { code: '2210', name: 'PF / ESI Payable', type: 'liability', group: 'Statutory Dues' },
  { code: '2300', name: 'Salary Payable', type: 'liability', group: 'Current Liabilities' },
  { code: '2400', name: 'Loans (Secured)', type: 'liability', group: 'Long-term Borrowings' },
  { code: '2410', name: 'Loans (Unsecured)', type: 'liability', group: 'Long-term Borrowings' },
  { code: '3000', name: "Owner's Capital", type: 'equity', group: 'Capital' },
  { code: '3100', name: 'Reserves and Surplus', type: 'equity', group: 'Capital' },
  { code: '3200', name: 'Drawings', type: 'equity', group: 'Capital' },
  { code: '4100', name: 'Other Income', type: 'income', group: 'Other Income' },
  { code: '4200', name: 'Interest Income', type: 'income', group: 'Other Income' },
  { code: '5400', name: 'Salaries and Wages', type: 'expense', group: 'Employee Cost' },
  { code: '5500', name: 'Rent', type: 'expense', group: 'Operating Expenses' },
  { code: '5510', name: 'Electricity and Utilities', type: 'expense', group: 'Operating Expenses' },
  { code: '5520', name: 'Telephone and Internet', type: 'expense', group: 'Operating Expenses' },
  { code: '5530', name: 'Professional Fees', type: 'expense', group: 'Operating Expenses' },
  { code: '5540', name: 'Travel and Conveyance', type: 'expense', group: 'Operating Expenses' },
  { code: '5550', name: 'Office Expenses', type: 'expense', group: 'Operating Expenses' },
  { code: '5560', name: 'Bank Charges', type: 'expense', group: 'Finance Cost' },
  { code: '5570', name: 'Interest Expense', type: 'expense', group: 'Finance Cost' },
  { code: '5580', name: 'Depreciation', type: 'expense', group: 'Operating Expenses' },
];

const trading: TemplateAccount[] = [
  { code: '4000', name: 'Sales', type: 'income', group: 'Revenue from Operations' },
  { code: '4010', name: 'Sales Returns', type: 'income', group: 'Revenue from Operations' },
  { code: '5000', name: 'Purchases', type: 'expense', group: 'Cost of Goods Sold' },
  { code: '5010', name: 'Purchase Returns', type: 'expense', group: 'Cost of Goods Sold' },
  { code: '5020', name: 'Freight Inward', type: 'expense', group: 'Cost of Goods Sold' },
];

const services: TemplateAccount[] = [
  { code: '4000', name: 'Service Revenue', type: 'income', group: 'Revenue from Operations' },
  { code: '5000', name: 'Subcontractor Costs', type: 'expense', group: 'Direct Costs' },
];

const manufacturing: TemplateAccount[] = [
  ...trading,
  { code: '1210', name: 'Raw Material Stock', type: 'asset', group: 'Current Assets' },
  { code: '1220', name: 'Work in Progress', type: 'asset', group: 'Current Assets' },
  { code: '1230', name: 'Finished Goods', type: 'asset', group: 'Current Assets' },
  { code: '5030', name: 'Direct Labour', type: 'expense', group: 'Cost of Goods Sold' },
  { code: '5040', name: 'Factory Overheads', type: 'expense', group: 'Cost of Goods Sold' },
];

export const COA_TEMPLATES: Record<string, TemplateAccount[]> = {
  trading: [...base, ...trading],
  services: [...base, ...services],
  manufacturing: [...base, ...manufacturing],
};

export function templateFor(name: string): TemplateAccount[] {
  const t = COA_TEMPLATES[name];
  if (!t) throw new Error(`Unknown chart of accounts template: ${name}`);
  return t;
}
