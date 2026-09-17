// 경량 i18n — 한국어 원문을 키로 쓰고, 영어 선택 시 EN 사전으로 치환한다.
//  · 키 발명 없이 기존 문자열을 t("...") 로 감싸기만 하면 됨(영어 매핑 없으면 한국어 그대로 폴백).
//  · 영어 표현은 짧고 직관적인 UI 용어로(장황한 직역 금지).
//  · 언어 변경은 useSyncExternalStore 로 즉시 리렌더(새로고침 불필요).
import { useSyncExternalStore } from "react";
import { type Lang, loadLang, saveLang } from "./theme";

// 한국어 → 영어. 없으면 한국어를 그대로 보여준다(점진 적용 안전).
const EN: Record<string, string> = {
  "더 보기": "Load more",
  "뒤쪽 페이지에 조건에 맞는 항목이 있을 수 있습니다.": "Matching items may be on a later page.",
  "휴지통 추가 조회에 실패했습니다. 새로고침 후 다시 시도하세요.": "Could not load more trash items. Refresh to try again.",
  "태그 이름 입력 후 Enter": "Enter a tag name and press Enter",
  "공유&리뷰의 워크스페이스 필터는 위쪽 W 메뉴에서 변경하세요.": "Use the W menu above to change the Share & Review workspace filter.",
  "워크스페이스를 확인한 뒤 공유물을 표시합니다.": "Shared items will appear once the workspace is identified.",
  "워크스페이스별 다빈치 확인에는 공유 서버 업데이트가 필요합니다. 임시로 전체 보기를 사용할 수 있습니다.": "Update the shared server for workspace-scoped Resolve selection. You can use All temporarily.",
  "소속 미확인 생성물은 전체 보기에서 확인할 수 있습니다.": "Items with an unknown workspace are available in All.",
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
  "생성자 필터 해제": "Clear creator filter",
  "워크스페이스별 생성자 표시에는 공유 서버 업데이트가 필요합니다.": "Update the shared server to show creators for this workspace.",
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
  // 워크스페이스 필터(라이브러리 툴바) — 공간 이름은 사용자 자료라 번역하지 않는다.
  "워크스페이스로 걸러 보기": "Filter by workspace",
  "현재 워크스페이스 따라가기": "Follow current workspace",
  "워크스페이스 변경 시 자동 적용으로 돌아갑니다.": "Switching workspaces restores automatic filtering.",
  "전체 보기": "Show all",
  "자동": "Auto",
  "수동": "Manual",
  "이 워크스페이스만 빼기": "Remove this workspace",
  "나머지는 버튼을 눌러 목록에서 뺄 수 있습니다": "Open the menu to remove the rest",
  '지금 "{name}" 워크스페이스에 속한 것만 보는 중 (만든 곳이 아니라 현재 소속)':
    'Showing only items now in "{name}" (current workspace, not where it was made)',
  "불러오는 중…": "Loading…",
  "목록을 못 받았습니다 — 다시 시도": "Could not load the list — retry",
  "속한 팀 워크스페이스가 없습니다.": "You are not in any team workspace.",
  // 레퍼런스 역할 메뉴(프롬프트 트레이 우클릭)
  "레퍼런스 역할": "Reference role",
  "첫 프레임": "First frame",
  "끝 프레임": "Last frame",
  "옴니 레퍼런스": "Omni reference",
  "레퍼런스 모드에서만 지정할 수 있습니다.": "Available only in reference mode.",
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
  // 생성 진행 상태 — 작업 공간 격자·캔버스 카드·생성 정보가 함께 쓴다.
  //  짧게: 타일이 작아지면 한 줄에 들어가야 한다(가장 긴 것 기준으로 재 봤다).
  "요청 준비 중": "Preparing",
  "대기": "Queued",
  "준비 중": "Starting",
  "제출 중": "Submitting",
  "생성 중": "Generating",
  "확인 중": "Checking",
  "조치 필요": "Action needed",
  "HF 확인 필요": "Check HF",
  "제출 확인 필요": "Submission check needed",
  // 오류 원인 안내 — 원문은 보존하고 화면에 붙이는 안내만 번역한다.
  "크레딧 한도 초과": "Credit limit reached",
  "워크스페이스 그룹의 월간 크레딧 사용 한도에 도달했습니다.":
    "The workspace group's monthly credit limit has been reached.",
  "워크스페이스 관리자에게 그룹 한도 조정을 요청하거나 한도가 초기화될 때까지 기다리세요.":
    "Ask your workspace admin to adjust the group limit, or wait until it resets.",
  "크레딧 부족": "Insufficient credits",
  "생성에 필요한 크레딧이 부족하다는 응답을 받았습니다.":
    "The service reported insufficient credits for this generation.",
  "Higgsfield에서 이 요청의 계정과 워크스페이스 크레딧 잔액을 확인하세요.":
    "Check the credit balance of this request's account and workspace in Higgsfield.",
  "크레딧 제한 확인": "Check credit limits",
  "크레딧 잔액 또는 사용 한도 관련 오류가 보고되었습니다.":
    "A credit balance or usage limit error was reported.",
  "Higgsfield의 크레딧 잔액과 워크스페이스 그룹 한도를 함께 확인하세요.":
    "Check both the Higgsfield credit balance and workspace group limit.",
  "로그인 필요": "Sign-in needed",
  "Higgsfield 인증을 확인하지 못했습니다.": "Higgsfield authentication could not be verified.",
  "이 PC의 Higgsfield CLI 로그인 상태를 확인하고 필요한 경우 다시 로그인하세요.":
    "Check the Higgsfield CLI sign-in on this PC and sign in again if needed.",
  "접근 권한 확인": "Check permissions",
  "요청한 작업에 대한 접근이 거부되었습니다.": "Access to the requested operation was denied.",
  "선택한 Higgsfield 계정의 워크스페이스 접근 권한과 역할을 관리자에게 확인하세요.":
    "Ask your admin to check the selected Higgsfield account's workspace access and role.",
  "입력값 확인": "Check inputs",
  "입력값 또는 레퍼런스를 처리하지 못했습니다.": "An input or reference could not be processed.",
  "오류 원문을 참고해 생성 설정과 레퍼런스 파일을 확인하세요.":
    "Use the original error to check generation settings and reference files.",
  "요청 한도 초과": "Rate limit reached",
  "짧은 시간에 보낸 요청이 서비스 허용량을 초과했습니다.":
    "Too many requests were sent within the service's time limit.",
  "잠시 기다린 뒤 요청 상태를 확인하세요. 제출 확인이 필요한 요청은 먼저 외부 작업을 확인하세요.":
    "Wait briefly, then check the request status. If submission needs checking, check the external job first.",
  "서비스 오류": "Service error",
  "외부 생성 서비스에서 오류 응답을 받았습니다.": "The external generation service returned an error.",
  "서비스 상태와 오류 원문을 확인하세요. 제출 여부가 불명확하면 먼저 외부 작업을 확인하세요.":
    "Check the service status and original error. If submission is uncertain, check the external job first.",
  "통신 확인 필요": "Check connection",
  "연결이 끊겼거나 응답을 제때 받지 못했습니다.": "The connection failed or a response did not arrive in time.",
  "네트워크 연결을 확인하세요. 응답이 없어도 작업이 생성됐을 수 있으므로 제출 상태를 먼저 확인하세요.":
    "Check your network connection. A job may exist even without a response, so check submission status first.",
  "해결 방법": "Suggested action",
  "오류 원문": "Original error",
  "오류 원문에서 상세 내용을 확인하세요.": "See the original error for details.",
  "자동 재실행 안 함 · 제출 확인 필요": "Auto-retry paused · submission check needed",
  "완료": "Done",
  "실패": "Failed",
  "NSFW 차단": "NSFW blocked",
  "삭제됨": "Deleted",
  "취소됨": "Canceled",
  "원본 없음": "File missing",
  // 카드 툴팁 — 우리가 붙이는 앞말만. 오류 본문은 서버가 만든 글이라 한국어 그대로 나온다.
  "단계": "Phase",
  "Higgsfield 상태": "Higgsfield status",
  "마지막 확인": "Last checked",
  "다음 확인": "Next check",
  "내 PC의 에이전트가 로컬 CLI로 생성 중입니다. 에이전트(push_agent --watch)가 떠 있어야 완료됩니다.":
    "Your PC's agent is generating through the local CLI. It has to stay running to finish.",
  "상세 사유를 받지 못했습니다.": "No details were provided.",
  "{s} 상태입니다. 상세 사유 정보가 없습니다.": "Status: {s}. No details available.",
  "실패 사유 정보가 없습니다.": "No failure details available.",
  // 생성 정보 — HF 확인 안내
  "자동 조사에서 외부 작업을 찾지 못했습니다. 원인을 해결한 뒤 작업이 없는지 직접 확인하고 다시 실행하세요.":
    "The automatic check found no external job. Resolve the cause, personally confirm that no job exists, then run again.",
  "외부 작업이 이미 만들어졌을 수 있어 자동 재생성을 멈췄습니다. 먼저 같은 계정의 Higgsfield 생성 목록에서 해당 작업이 없는지 확인하세요.":
    "An external job may already exist, so auto-retry was stopped. First check the Higgsfield job list on the same account.",
  "다시 실행": "Run again",
  "미제출 확인 후 다시 실행": "Confirm not submitted, then run again",
  "실패 사유": "Failure reason",
  // HF 확인 안내(생성 정보 · 재생성 차단 알림)
  "외부 제출 여부를 먼저 확인해야 합니다. 생성 정보에서 HF 확인을 진행하세요.":
    "Check whether it was already submitted. Open the generation info and run the HF check.",
  "외부 제출 여부를 먼저 확인해야 합니다. 생성 정보에서 제출 확인을 진행하세요.":
    "Check whether it was already submitted. Open the generation info to verify the submission.",
  "Higgsfield에서 이 요청의 작업이 생성되지 않은 것을 직접 확인했습니까?":
    "Have you personally confirmed that no job was created for this request in Higgsfield?",
  "확인을 누르면 기존 요청을 다시 실행하며 크레딧이 사용될 수 있습니다.":
    "Confirming will run the existing request again and may use credits.",
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
