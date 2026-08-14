import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SceneVariantPopup } from "../src/components/scene/SceneVariantPopup";

describe("SceneVariantPopup card drag", () => {
  it("uses the full-card hit layer as an explicit drag source", () => {
    const generation = {
      id: "gen-1",
      prompt: "drag me",
      status: "done",
      created_at: "2026-08-14T00:00:00Z",
      assets: [
        {
          id: "asset-1",
          generation_id: "gen-1",
          type: "image",
          file_path: "/result.png",
          thumbnail_path: null,
          source_url: null,
          cached: true,
        },
      ],
      references: [],
      tags: [],
      auto_tags: [],
      shared: false,
      parent_gen_id: null,
      is_source: false,
      source_name: null,
      comment: null,
      error: null,
      comment_count: 0,
      has_unread: false,
      local_only: false,
      creator_uid: null,
      creator_name: null,
      is_mine: true,
      workspace_scope: "personal",
      workspace_id: null,
      workspace_name: null,
      project_id: null,
      deleted: false,
      worker_id: "worker-1",
      worker_name: null,
      display_prompt: null,
      model: null,
      params: null,
      color: null,
    };
    const noop = vi.fn();
    const html = renderToStaticMarkup(
      createElement(SceneVariantPopup, {
        cardId: "card-1",
        cards: [
          {
            id: "card-1",
            kind: "generation",
            x: 0,
            y: 0,
            genId: "gen-1",
            genIds: ["gen-1"],
          },
        ],
        genData: { "gen-1": generation },
        disabledIds: new Set(),
        projects: [],
        autoTagOptions: [],
        ui: {
          popupSel: new Set(),
          setPopupSel: noop,
          popupAnchorRef: { current: null },
          popupMarq: null,
          gripDragging: false,
          setGripDragging: noop,
          tagEditGid: null,
          setTagEditGid: noop,
          tagEditorPos: null,
          varGridRef: createRef<HTMLDivElement>(),
          varpopWrapRef: createRef<HTMLDivElement>(),
          onVarGridMouseDown: noop,
        },
        gen: {
          sConfirm: null,
          onNodeSClick: noop,
          onNodeSDouble: noop,
          onNodeSConfirmYes: noop,
          onNodeSConfirmNo: noop,
          tagsEnabled: false,
          hasAutoTags: false,
          applyCardTags: noop,
          applyCardAutoTags: noop,
        },
        actions: {
          setCardMenu: noop,
          setCardVariant: noop,
          pruneVariants: noop,
          latestCard: () => undefined,
        },
      } as never),
    );

    expect(html).toMatch(/class="scene-varpop-draglayer"[^>]*draggable="true"/);
    expect(html.match(/draggable="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/class="scene-varpop-item[^"]*"[^>]*draggable="true"/);
  });
});
