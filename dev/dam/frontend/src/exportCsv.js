// Download tabular data as a CSV file.
// headers: string[]; rows: Array<Array<string|number|null>>
export function exportCsv(filename, headers, rows) {
  const esc = (v) => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
