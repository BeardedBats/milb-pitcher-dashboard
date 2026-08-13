// Shared CSV export helpers.
//
// Columns are { key, label, value? }: `label` becomes the header cell, and the
// cell value is value(row) when provided, else row[key]. Values are exported
// RAW — numbers stay numbers (26.3, not "26%"), missing values become empty
// cells (not "—"), dates stay ISO. The UI's formatting is for reading; a CSV
// is for feeding a spreadsheet, where "43%" is a string and 43 is a number.

export function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  // Quote when the value contains a delimiter, quote, or newline; double any
  // embedded quotes per RFC 4180.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(columns, rows) {
  const header = columns.map(c => csvEscape(c.label || c.key)).join(",");
  const lines = rows.map(row =>
    columns.map(c => csvEscape(c.value ? c.value(row) : row[c.key])).join(",")
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

export function downloadCsv(filename, columns, rows) {
  // BOM so Excel opens UTF-8 names (Jesús Luzardo) correctly.
  const blob = new Blob(["\uFEFF" + rowsToCsv(columns, rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on a delay — revoking synchronously cancels the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Filename-safe slug: "Jackson Kent" -> "jackson-kent".
export function csvSlug(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
