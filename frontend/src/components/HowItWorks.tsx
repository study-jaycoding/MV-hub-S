// How it works 탭 — 자리표시자. 이미지/영상 슬롯만 잡아두고 내용은 추후 채운다.
const STEPS = [
  { kind: "video", title: "1 · 동기화", desc: "힉스필드 생성 이력을 불러옵니다." },
  { kind: "image", title: "2 · 생성", desc: "프롬프트로 이미지·영상을 만듭니다." },
  { kind: "image", title: "3 · 보관", desc: "소스·결과물을 로컬에 출처와 함께 저장합니다." },
  { kind: "video", title: "4 · 공유", desc: "팀이 재사용·변형할 수 있게 공유합니다." },
];

export function HowItWorks() {
  return (
    <div className="how-it-works">
      <div className="how-grid">
        {STEPS.map((s) => (
          <div key={s.title} className="how-card">
            <div className={"how-media " + s.kind}>
              <span className="how-media-tag">
                {s.kind === "video" ? "🎬 영상" : "🖼 이미지"}
              </span>
              <span className="how-media-ph">자리표시자</span>
            </div>
            <div className="how-body">
              <div className="how-title">{s.title}</div>
              <div className="how-desc">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="how-note">
        ※ 이미지·영상 자리만 잡아둔 자리표시자입니다. 내용은 추후 채웁니다.
      </div>
    </div>
  );
}
