// SVG 는 참조 이미지와 함께 쓸 수 없다 — 프롬프트 창 위에 붙는 띠(메시지 + [png 로 바꾸기]). 막힘이 풀리면 호출 쪽이 이 띠를 그리지 않는다.
//  단추는 출력 형식만 png 로 바꾼다(참조·다른 옵션은 그대로 — 참조는 사용자가 넣은 자료라 자동으로 빼지 않는다).
import { SVG_REF_MESSAGE } from "../../lib/svgReference";

export function SvgReferenceBand({ onFix }: { onFix: () => void }) {
  const [head, ...rest] = SVG_REF_MESSAGE.split(". ");
  return (
    <div className="sl-svg-band" role="alert">
      <span aria-hidden="true">⚠</span>
      <span><b>{head}.</b> {rest.join(". ")}</span>
      <button type="button" className="sl-svg-band-fix" onClick={onFix}>png 로 바꾸기</button>
    </div>
  );
}
