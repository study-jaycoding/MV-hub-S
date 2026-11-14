import { describe, expect, it } from 'vitest';
import { dataFoldParts, dataFoldSummary } from './SettingsPanel';
import { heldRecoveryCounts } from './settings/CanvasArchiveSection';
import type { StorageRecovery } from '../lib/sceneArchive';

// 접힌 '자료 관리' 묶음 제목 밑 줄 — 진행·결과는 접어 둬도 보여야 한다(Jay 규칙 "실시간 정보는 접기 밖", 배포 전 검토 Claude 2)
describe('settings data fold summary', () => {
  const rest = ['캔버스 3개', '로컬 백업 7세트'];
  it('puts every running task and result first, all of them', () => {
    const text = dataFoldSummary({ state: 'running', received: 42 } as never, ['DB 가져오는 중', '재점검 중', '', 'HF 삭제물 확인 중'], rest);
    expect(text).toBe('과거 생성물 가져오는 중 42건 · DB 가져오는 중 · 재점검 중 · HF 삭제물 확인 중 · 캔버스 3개 · 로컬 백업 7세트');
  });
  it('switches to the result message when the import finishes and to the plain line when idle', () => {
    expect(dataFoldSummary({ state: 'complete', message: '가져오기 끝' } as never, ['', '', '', ''], rest)).toBe('가져오기 끝 · 캔버스 3개 · 로컬 백업 7세트');
    expect(dataFoldSummary({ state: 'failed', message: '가져오기 실패' } as never, ['', '', '', ''], rest)).toBe('가져오기 실패 · 캔버스 3개 · 로컬 백업 7세트');
    expect(dataFoldSummary(null, ['', '', '', ''], rest)).toBe('캔버스 3개 · 로컬 백업 7세트');
  });
  it('never ends with an ellipsis', () => {
    expect(dataFoldSummary({ state: 'running', received: 1 } as never, [], [])).not.toMatch(/(…|\.\.\.)$/);
  });
  it("puts '복원 보류 N' after the backup sets and before the server state, and drops it at zero", () => {
    expect(dataFoldParts('캔버스 3개 · 백업 8세트', 3, '서버 정상')).toEqual(['캔버스 3개 · 백업 8세트', { held: 3 }, '서버 정상']);
    expect(dataFoldParts('캔버스 3개', 0, '서버 정상')).toEqual(['캔버스 3개', '서버 정상']);
    expect(dataFoldParts('', 2, '')).toEqual([{ held: 2 }]);
  });
  it('omits empty legacy archives but keeps control-only recovery in the folded line', () => {
    const recovery: StorageRecovery = { account: 'local', mirror: null, edits: [], cards: null,
      canvases: [{ id: 'empty', createdAt: '2026-11-14', notebookId: '', fromGeneration: null, toGeneration: 'new',
        scenes: { 'local::_none': [] }, conflicts: [], controls: { '["ns","local"]': undefined } }] };
    expect(dataFoldParts('캔버스 3개', heldRecoveryCounts(recovery).total, '서버 정상')).toEqual(['캔버스 3개', '서버 정상']);
    recovery.canvases.push({ ...recovery.canvases[0], id: 'progress', controls: { '["ns","local"]': { id: 'start' } } });
    expect(dataFoldParts('캔버스 3개', heldRecoveryCounts(recovery).total, '서버 정상')).toEqual(['캔버스 3개', { held: 1 }, '서버 정상']);
  });
  it('keeps the last held count alongside a read failure, even when the count is zero', () => {
    expect(dataFoldParts('캔버스 3개', 2, '서버 정상', true)).toEqual(['캔버스 3개', { held: 2 }, { failed: true }, '서버 정상']);
    expect(dataFoldParts('', 0, '', true)).toEqual([{ failed: true }]);
    expect(dataFoldParts('', 0, '', false)).toEqual([]);
  });
});
