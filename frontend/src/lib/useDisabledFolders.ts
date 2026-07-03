import { useState } from "react";
import { DISABLED_EVENT, loadDisabledFolders, type DisabledFolders } from "./deactivated";
import { useCustomEvent } from "./useCustomEvent";

// 폴더 단위 비활성화 상태 — 어디서 토글하든 DISABLED_EVENT 로 즉시 갱신(생성물 비활성과 한 이벤트 공유).
export function useDisabledFolders(): DisabledFolders {
  const [disabledFolders, setDisabledFolders] = useState<DisabledFolders>(loadDisabledFolders);
  useCustomEvent(DISABLED_EVENT, () => setDisabledFolders(loadDisabledFolders()));
  return disabledFolders;
}
