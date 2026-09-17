import { flashMsg } from "./flash";
import { HttpError } from "./http";
import { t } from "./i18n";

// 원본 열기 세 진입점의 비차단 안내. 원시 예외/서버 경로는 표시하지 않는다.
export function reportSourceLocationError(error: unknown): void {
  let message = "원본 위치를 열지 못했습니다. 연결 상태와 파일 위치를 확인해 주세요.";
  if (error instanceof HttpError) {
    if (error.status === 404) message = "원본 파일이나 프로젝트를 찾을 수 없습니다.";
    else if (error.status === 401 || error.status === 403) message = "원본 위치를 열 권한이 없습니다.";
    else if (error.status === 500) message = "파일 탐색기를 열지 못했습니다.";
  }
  flashMsg(t(message));
}
