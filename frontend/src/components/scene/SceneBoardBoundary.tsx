import { Component, type ReactNode } from "react";

// 지연 청크를 못 받거나 캔버스가 실패해도 바깥 탭·툴바는 계속 조작할 수 있게 한다.
export class SceneBoardBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
