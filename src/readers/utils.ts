import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTurn } from './types.js';

export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

/** エンコードされたパス名からプロジェクト名を復元する */
export function extractProjectName(encodedDirName: string): string {
  const parts = encodedDirName.split('-');
  return parts.findLast((p: string) => p.length > 0) ?? encodedDirName;
}

/** ファイルの更新日が対象日から ±1 日以内かチェック（タイムゾーンずれ吸収） */
export function isWithinDate(fileDate: Date, targetDate: Date): boolean {
  const target = targetDate.getTime();
  const day = 86_400_000;
  const file = new Date(fileDate).setHours(0, 0, 0, 0);
  const t = new Date(targetDate).setHours(0, 0, 0, 0);
  return Math.abs(file - t) <= day;
}

/** 先頭3 + 末尾3 + 中間均等サンプリング */
export function selectTurns(turns: AgentTurn[], maxTurns: number): AgentTurn[] {
  if (turns.length <= maxTurns) return turns;

  const headReserve = 3;
  const tailReserve = 3;
  const head = Math.min(headReserve, maxTurns);
  const tail = Math.min(tailReserve, maxTurns - head);
  const midBudget = maxTurns - head - tail;

  const selected = turns.slice(0, head);

  if (midBudget > 0) {
    const midStart = head;
    const midEnd = turns.length - tail;
    const midCount = midEnd - midStart;
    if (midCount > 0) {
      const step = midCount / (midBudget + 1);
      for (let i = 0; i < midBudget; i++) {
        const idx = midStart + Math.round(step * (i + 1));
        if (idx < midEnd && !selected.includes(turns[idx]!)) {
          selected.push(turns[idx]!);
        }
      }
    }
  }

  for (const t of turns.slice(-tail)) {
    if (!selected.includes(t)) selected.push(t);
  }

  return selected;
}

export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return path.normalize(fileURLToPath(uri));
  } catch {
    return null;
  }
}
