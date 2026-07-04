import { useState } from 'react';

export default function DataTable({ columns, data, onRowClick, onRowDoubleClick, emptyMessage = 'No data' }) {
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  function handleSort(colKey) {
    if (sortCol === colKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(colKey); setSortDir('asc'); }
  }

  let sorted = data || [];
  if (sortCol) {
    sorted = [...sorted].sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  if (!data || data.length === 0) {
    return <div className="chart-empty">{emptyMessage}</div>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.key} className={col.align === 'right' ? 'num' : ''} onClick={() => col.sortable !== false && handleSort(col.key)} style={col.sortable !== false ? { cursor: 'pointer' } : {}}>
              {col.label}
              {sortCol === col.key && <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, ri) => (
          <tr key={row.id || ri} onClick={() => onRowClick?.(row)} onDoubleClick={() => onRowDoubleClick?.(row)} style={(onRowClick || onRowDoubleClick) ? { cursor: 'pointer' } : {}}>
            {columns.map(col => (
              <td key={col.key} className={col.align === 'right' ? 'num' : col.className || ''}>
                {col.render ? col.render(row[col.key], row) : row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
