import { useState } from "react";
import type { ValidationResult } from "../content/validate.ts";

/**
 * Content validation report.
 *
 * The validator has always been able to detect a character that would never attack. Until
 * now the only place that knowledge surfaced was the console, which is the one place a
 * player never looks. A content mistake that reaches the arena produces a unit that stands
 * still and swings at nothing — indistinguishable from a physics bug.
 *
 * Validation failure does not block the battle. The library is authoring data, and a
 * mistyped cost should not make the whole sandbox unopenable. It is reported loudly and
 * the arena still runs.
 */

/** How many issues to show before collapsing the rest behind a button. */
const PREVIEW_COUNT = 4;

interface ContentIssuesProps {
  readonly result: ValidationResult;
  readonly characters: number;
  readonly abilities: number;
  readonly props: number;
}

export function ContentIssues({ result, characters, abilities, props }: ContentIssuesProps) {
  const [expanded, setExpanded] = useState(false);

  if (result.ok) {
    return (
      <section className="panel__block">
        <h2>内容校验</h2>
        <p className="panel__ok">
          <span className="panel__dot panel__dot--ok" />
          通过 · {characters} 角色 / {abilities} 技能 / {props} 机关
        </p>
      </section>
    );
  }

  const shown = expanded ? result.issues : result.issues.slice(0, PREVIEW_COUNT);
  const hidden = result.issues.length - shown.length;

  return (
    <section className="panel__block panel__block--alert">
      <h2>内容校验失败</h2>
      <p className="panel__alert">
        <span className="panel__dot panel__dot--warn" />
        发现 {result.issues.length} 项问题。战斗仍可运行，但结果可能不符合预期。
      </p>
      <ul className="panel__issues">
        {shown.map((issue, index) => (
          <li key={`${issue.path}:${index}`}>
            <code>{issue.path}</code>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" onClick={() => setExpanded(true)}>
          展开其余 {hidden} 项
        </button>
      ) : null}
    </section>
  );
}
