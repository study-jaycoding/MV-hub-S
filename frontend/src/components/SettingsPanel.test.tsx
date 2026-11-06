import { describe, expect, it } from 'vitest';
import { dataFoldSummary } from './SettingsPanel';

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
});
