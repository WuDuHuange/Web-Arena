import type { ReactElement } from "react";
import { CONTENT_LIBRARY, TAG_LABELS } from "../content/library.ts";
import { DRAFT_CATALOG, behaviorOf } from "../content/deployment.ts";
import type { Faction } from "../simulation/types.ts";
import { summariseDraft } from "../editor/draft.ts";
import type { DeploymentDraft, DraftBounds, DraftIssue } from "../editor/draft.ts";

/**
 * The deployment editor panel.
 *
 * Presentation only: it renders the draft it is handed and reports intent through callbacks.
 * It owns no draft state, because the draft is what the preview is rebuilt from and two
 * copies of it would eventually disagree about where a unit is.
 *
 * The panel is not where placement happens — that is the battlefield itself. This is the
 * palette, the inspector for whatever is selected, and the list of reasons the current
 * layout cannot be fought yet.
 */

export interface DeploymentEditorProps {
  readonly draft: DeploymentDraft;
  readonly bounds: DraftBounds;
  readonly issues: readonly DraftIssue[];
  readonly selectedKey: string | null;
  readonly ready: { readonly ready: boolean; readonly reason: string };
  /**
   * True while a battle is running, paused or decided.
   *
   * Editing is refused rather than queued: the running world was built from the draft at the
   * moment 开战 was pressed, so an edit now would change the panel while the arena kept
   * fighting the old layout. 重置 is what returns to laying out.
   */
  readonly locked: boolean;
  readonly onAddUnit: (characterId: string, faction: Faction) => void;
  readonly onAddProp: (propId: string) => void;
  readonly onRemove: (key: string) => void;
  readonly onRotate: (key: string, delta: number) => void;
  readonly onClear: () => void;
  readonly onRestore: () => void;
}

const TURN = Math.PI / 12;

export function DeploymentEditor(props: DeploymentEditorProps): ReactElement {
  const { draft, bounds, issues, selectedKey, ready, locked } = props;

  const selected = describeSelection(draft, selectedKey);
  const errors = issues.filter((issue) => issue.level === "error");
  const red = CONTENT_LIBRARY.characters.filter((c) => c.id.startsWith("red."));
  const blue = CONTENT_LIBRARY.characters.filter((c) => c.id.startsWith("blue."));

  return (
    <section className="panel__block">
      <h2>布阵编辑器</h2>
      <p className="editor__summary">
        {summariseDraft(draft)} · 场地 {bounds.width}×{bounds.height}
      </p>

      {locked ? (
        <p className="editor__hint">交战中不可编辑。按「重置」回到待命，即可继续布置。</p>
      ) : null}

      <p className="editor__group">红方兵装</p>
      <div className="editor__chips">
        {red.map((character) => (
          <button
            key={character.id}
            type="button"
            className="editor__chip editor__chip--red"
            data-chip-id={character.id}
            disabled={locked}
            onClick={() => props.onAddUnit(character.id, "red")}
          >
            ＋ {character.name}
          </button>
        ))}
      </div>

      <p className="editor__group">蓝方兵装</p>
      <div className="editor__chips">
        {blue.map((character) => (
          <button
            key={character.id}
            type="button"
            className="editor__chip editor__chip--blue"
            data-chip-id={character.id}
            disabled={locked}
            onClick={() => props.onAddUnit(character.id, "blue")}
          >
            ＋ {character.name}
          </button>
        ))}
      </div>

      <p className="editor__group">机关</p>
      <div className="editor__chips">
        {CONTENT_LIBRARY.props.map((prop) => (
          <button
            key={prop.id}
            type="button"
            className="editor__chip"
            data-chip-id={prop.id}
            disabled={locked}
            onClick={() => props.onAddProp(prop.id)}
          >
            ＋ {prop.name}
          </button>
        ))}
      </div>

      {selected ? (
        <div className="editor__inspector">
          <p className="editor__selected">
            <span className={`roster__dot roster__dot--${selected.faction ?? "neutral"}`} />
            已选中 · {selected.label}
          </p>
          <dl className="panel__readout">
            <dt>坐标</dt>
            <dd>
              {Math.round(selected.x)}, {Math.round(selected.y)}
            </dd>
            <dt>朝向</dt>
            <dd>{Math.round((selected.facing * 180) / Math.PI)}°</dd>
            <dt>尺寸</dt>
            <dd>{selected.detail}</dd>
          </dl>
          {selected.tags.length > 0 ? (
            <p className="editor__tags">
              {/* Spawn-level tags, which the editor does not author. Shown so they are not
                  invisible: a unit that fights differently from its name and cannot be
                  explained by anything on screen is worse than one that says why. */}
              固有特性：{selected.tags.map((tag) => TAG_LABELS[tag] ?? tag).join("、")}
            </p>
          ) : null}
          <div className="panel__buttons">
            <button
              type="button"
              disabled={locked}
              onClick={() => props.onRotate(selected.key, -TURN)}
            >
              ↺ 15°
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => props.onRotate(selected.key, TURN)}
            >
              ↻ 15°
            </button>
            <button type="button" disabled={locked} onClick={() => props.onRemove(selected.key)}>
              删除
            </button>
          </div>
        </div>
      ) : (
        <p className="editor__hint">
          点击战场上的单位或机关即可选中；按住拖动移动位置，选中后用 ↺ ↻ 或 Q／E 调整朝向，方向键微调，Delete
          删除。点空白处取消选中。
        </p>
      )}

      {errors.length > 0 ? (
        <>
          <p className="panel__alert editor__verdict">
            <span className="panel__dot panel__dot--warn" />
            {errors.length} 项布阵问题，修好之后才能开战
          </p>
          <ul className="panel__issues">
            {errors.map((issue, index) => (
              <li key={index}>
                <code>{whereOf(draft, issue.key)}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="panel__ok editor__verdict">
          <span className={`panel__dot ${ready.ready ? "panel__dot--ok" : "panel__dot--warn"}`} />
          {ready.ready ? "布阵合法，可以开战" : ready.reason}
        </p>
      )}

      <div className="panel__buttons editor__actions">
        <button type="button" disabled={locked} onClick={props.onRestore}>
          恢复场景布阵
        </button>
        <button type="button" disabled={locked} onClick={props.onClear}>
          清空
        </button>
      </div>
    </section>
  );
}

interface SelectionInfo {
  readonly key: string;
  readonly label: string;
  readonly faction?: Faction;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly detail: string;
  readonly tags: readonly string[];
}

/**
 * Resolves the selected key into something printable.
 *
 * The editor's own keys (`u3`, `p1`) are identity, not language — showing them to a player
 * would be showing them a variable name. Everything user-facing is looked up from the
 * content library instead.
 */
function describeSelection(
  draft: DeploymentDraft,
  key: string | null
): SelectionInfo | undefined {
  if (!key) {
    return undefined;
  }

  const unit = draft.units.find((u) => u.key === key);
  if (unit) {
    const character = CONTENT_LIBRARY.characters.find((c) => c.id === unit.characterId);
    const radius = DRAFT_CATALOG.unitRadius(unit.characterId);
    return {
      key,
      label: character?.name ?? unit.characterId,
      faction: unit.faction,
      x: unit.x,
      y: unit.y,
      facing: unit.facing,
      detail: radius === undefined ? "—" : `半径 ${radius}`,
      tags: unit.tags ?? []
    };
  }

  const prop = draft.props.find((p) => p.key === key);
  if (prop) {
    const definition = CONTENT_LIBRARY.props.find((p) => p.id === prop.propId);
    const body = DRAFT_CATALOG.propBodyRadius(prop.propId);
    const effect = behaviorOf(prop.propId)?.radius;
    return {
      key,
      label: definition?.name ?? prop.propId,
      x: prop.x,
      y: prop.y,
      facing: prop.facing,
      // Both numbers, because they are different numbers and the difference is the whole
      // reason a unit can stand inside a lava pool without being ejected from it.
      detail:
        effect === undefined || body === undefined
          ? "—"
          : `效果 ${effect} · 实体 ${body}`,
      tags: []
    };
  }

  return undefined;
}

/** Names the placement an issue is about, falling back to a generic noun. */
function whereOf(draft: DeploymentDraft, key: string | undefined): string {
  if (!key) {
    return "布阵";
  }
  const unit = draft.units.find((u) => u.key === key);
  if (unit) {
    return CONTENT_LIBRARY.characters.find((c) => c.id === unit.characterId)?.name ?? "单位";
  }
  const prop = draft.props.find((p) => p.key === key);
  if (prop) {
    return CONTENT_LIBRARY.props.find((p) => p.id === prop.propId)?.name ?? "机关";
  }
  return "布阵";
}
