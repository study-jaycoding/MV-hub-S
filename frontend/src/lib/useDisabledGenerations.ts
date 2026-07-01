import { useState } from "react";
import { DISABLED_EVENT, loadDisabledGen } from "./deactivated";
import { useCustomEvent } from "./useCustomEvent";

export function useDisabledGenerations() {
  const [disabledGen, setDisabledGen] = useState<Set<string>>(loadDisabledGen);
  useCustomEvent(DISABLED_EVENT, () => setDisabledGen(loadDisabledGen()));
  return disabledGen;
}
