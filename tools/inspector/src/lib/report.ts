import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import ExcelJS from 'exceljs';

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

export interface SheetSpec {
  name: string;
  columns: Array<{ header: string; key: string; width?: number }>;
  rows: Array<Record<string, unknown>>;
}

export async function writeWorkbook(path: string, sheets: SheetSpec[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gulf University Research Repository — Inspector';
  workbook.created = new Date();

  for (const spec of sheets) {
    // Excel sheet names cap at 31 chars and forbid : \ / ? * [ ]
    const sheet = workbook.addWorksheet(spec.name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    sheet.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 22 }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    for (const row of spec.rows) {
      sheet.addRow(
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(' | ') : (value as unknown),
          ]),
        ),
      );
    }
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: spec.columns.length },
    };
  }

  await workbook.xlsx.writeFile(path);
}
