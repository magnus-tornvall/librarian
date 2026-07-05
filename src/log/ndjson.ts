import fs from 'node:fs';
import path from 'node:path';

export function appendRecord(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

export function readAll(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line)];
    } catch (err) {
      if (index === lines.length - 1) {
        return [];
      }
      throw err;
    }
  });
}
