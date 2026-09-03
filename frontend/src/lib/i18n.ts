// 경량 i18n — 한국어 원문을 키로 쓰고, 영어 선택 시 EN 사전으로 치환한다.
//  · 키 발명 없이 기존 문자열을 t("...") 로 감싸기만 하면 됨(영어 매핑 없으면 한국어 그대로 폴백).
//  · 영어 표현은 짧고 직관적인 UI 용어로(장황한 직역 금지).
//  · 언어 변경은 useSyncExternalStore 로 즉시 리렌더(새로고침 불필요).
import { useSyncExternalStore } from "react";
import { type Lang, loadLang, saveLang } from "./theme";

// 한국어 → 영어. 없으면 한국어를 그대로 보여준다(점진 적용 안전).
const EN: Record<string, string> = {
  // 상단바·탭
  "작업 공간": "Workspace",
  "공유 & 리뷰": "Share & Review",
  "히스토리": "History",
  "캔버스": "Canvas",
  "캔버스 — 씬 캔버스 · 히스토리 뷰": "Canvas — scene canvas & History view",
  "히스토리 보기": "History view",
  "관리자 — 멤버 등급·프로젝트 관리": "Admin — roles & projects",
  "Assets (구성) — 별도 창": "Assets — separate window",
  // 알림 센터 — 알림 본문(코멘트 내용)은 사용자 데이터라 번역하지 않고, UI 문구만 치환한다.
  "알림 센터": "Notifications",
  "전체 알림": "All notifications",
  "코멘트": "Comments",
  "시스템": "System",
  "안읽음": "Unread",
  "읽음": "Read",
  "읽은 알림이 없습니다.": "No read notifications.",
  "모두 읽음": "Mark all as read",
  "처리 중…": "Working…",
  "알림을 불러오는 중…": "Loading notifications…",
  "새 알림이 없습니다.": "No new notifications.",
  "최근 알림이 없습니다.": "No recent notifications.",
  "팀원": "Teammate",
  "{v}로 업데이트되었습니다": "Updated to {v}",
  "{v}(으)로 업데이트하시겠습니까?": "Update to {v} now?",
  "예, 업데이트": "Yes, update",
  "나중에": "Later",
  // 공유 서버 이사 공지(주소 전환) — 확인창 없이 클릭이 곧 전환이라 본문이 결과를 밝힌다
  "공유 서버가 새 주소로 이사했습니다: {url}. 누르면 전환되고 다시 로그인합니다.":
    "The shared server moved to {url}. Click to switch and sign in again.",
  "'{name}' 서버가 새 위치로 이동했습니다. 누르면 전환되고 다시 로그인합니다.":
    "'{name}' moved to a new location. Click to switch and sign in again.",
  "공유 서버 주소를 전환하는 중…": "Switching the shared server address…",
  "전환하지 못했습니다 — 옛 주소를 그대로 씁니다":
    "Could not switch — still using the old address",
  "업데이트 실행기를 준비하는 중…": "Preparing the updater…",
  "업데이트를 시작하지 못했습니다": "Could not start the update",
  "업데이트 확인이 오래 걸립니다 — 설정의 업데이트 섹션에서 상태를 확인하세요.":
    "The update is taking long — check the update section in Settings.",
  "{v} 업데이트가 완료됐습니다. 새 버전으로 다시 시작됩니다.":
    "Updated to {v}. Restarting on the new version.",
  "업데이트 상태를 확인하세요.": "Check the update status.",
  "알림 목록은 백엔드 업데이트 후 사용할 수 있습니다.":
    "The notification list needs a backend update.",
  "코멘트 알림을 불러오지 못했습니다.": "Could not load comment notifications.",
  "코멘트 알림을 모두 읽음 처리하지 못했습니다.": "Could not mark all comments as read.",
  "목록 범위 밖 미확인 코멘트 {n}개 · 모두 읽음으로 정리할 수 있습니다.":
    "{n} unread comments outside this list · use Mark all as read.",
  // 설정
  "설정": "Settings",
  "모션": "Motion",
  "모션 끄기 (골드 글로우 등 애니메이션 정지)": "Reduce motion (stop gold glow etc.)",
  "켜면 최종(골드) 카드의 흐르는 빛 같은 장식 애니메이션이 멈춥니다.": "When on, decorative animations like the gold sheen on final cards stop.",
  "내 힉스필드 연결 (에이전트)": "Connect my Higgsfield (agent)",
  "팀 크레딧": "Team credits",
  "팀 전체": "Team total",
  "각 구성원 에이전트가 동기화할 때 보고한 잔액입니다(실시간 아님).":
    "Last balance each member's agent reported on sync (not live).",
  "닫기": "Close",
  "강조색": "Accent",
  "선택 즉시 적용되고 다음 접속에도 유지됩니다.": "Applied instantly, kept next time.",
  "언어 · Language": "Language",
  "선택은 저장됩니다. 영어 UI 번역은 순차 적용 예정입니다.":
    "More of the UI is translated over time.",
  "생성물 전체 가져오기": "Import all",
  "가져오는 중…": "Importing…",
  "↺ 지금 전체 가져오기": "↺ Import now",
  // 계정 메뉴
  "⚙ 설정": "⚙ Settings",
  "⚙ Manage Account": "⚙ Manage Account",
  "워크스페이스": "Workspace",
  "개인": "Personal",
  "개": "", // 개수 단위 생략 ("13" instead of "13개")
  // 사이드바 필터 섹션
  "전역 태그": "Global tags",
  "생성자": "Creator",
  "컬러": "Color",
  "프로젝트": "Projects",
  "공유": "Shared",
  "내보내기": "Sent",
  "가져오기": "Received",
  "휴지통": "Trash",
  "전체": "All",
  "숨김": "Hidden",
  "라이브러리": "Library",
  "휴지통 보기": "Deleted",
  "휴지통 비우기": "Empty trash",
  "함께 보기 (흐리게)": "Show dimmed",
  "지운 것만 보기": "Trash only",
  "미분류": "Unsorted",
  "없음": "None",
  // 라이브러리 툴바
  "필터 사이드바 닫기": "Hide filter sidebar",
  "필터 사이드바 열기": "Show filter sidebar",
  "힉스필드 날짜별로 구분": "Group by date",
  "날짜 구분 끄기 (한 번 더)": "Ungroup (click again)",
  "리스트": "List",
  "그리드": "Grid",
  // 캔버스 노드
  "미리보기": "View", // View 노드 헤더(한글 UI=미리보기, 영문 UI=View)
  // 미디어 타입
  "이미지": "Image",
  "영상": "Video",
  "오디오": "Audio",
  "건": "", // 영어에선 단위 생략 ("All · 140")
  // 그리드/공통
  "로딩…": "Loading…",
  "선택": "selected",
  "개 선택": " selected",
  "↗ 팀에 공유": "↗ Share to team",
  "◆ Resolve로 보내기": "◆ Send to Resolve",
  "◆ Resolve에 추가": "◆ Add to Resolve",
  "Resolve 전송 중…": "Sending to Resolve…",
  "항목이 없습니다.": "Nothing here yet.",
  "+ 새 생성": "+ New",
  // Assets
  "폴더 등록": "Folders",
  "파일 날짜별로 구분": "Group by date",
  "이 폴더에 미디어가 없습니다.": "No media in this folder.",
};

let _lang: Lang = loadLang();
const _subs = new Set<() => void>();

/** 언어 변경(영속 + 즉시 리렌더). */
export function setLang(lang: Lang): void {
  if (lang === _lang) return;
  _lang = lang;
  saveLang(lang); // localStorage + <html lang>
  _subs.forEach((f) => f());
}

export function getLang(): Lang {
  return _lang;
}

/** 한국어 원문 → 현재 언어 문자열. 영어 매핑 없으면 한국어 그대로. */
export function t(ko: string): string {
  return _lang === "en" ? EN[ko] ?? ko : ko;
}

function subscribe(cb: () => void): () => void {
  _subs.add(cb);
  return () => _subs.delete(cb);
}

/** 컴포넌트에서 사용 — 언어 변경 시 리렌더되고 t 를 돌려준다. */
export function useT(): typeof t {
  useSyncExternalStore(
    subscribe,
    () => _lang,
    () => _lang,
  );
  return t;
}
