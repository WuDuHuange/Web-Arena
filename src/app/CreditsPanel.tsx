import { CONTENT_LIBRARY } from "../content/library.ts";

/**
 * Asset attribution.
 *
 * The architecture baseline requires every public asset to be individually licence-checked
 * before it ships. That is easy to promise and easy to forget, so the mechanism goes in
 * before the first asset does.
 *
 * This build currently contains zero external files: every shape is drawn with PixiJS
 * primitives and every sound is synthesised from oscillators. The panel says that
 * explicitly rather than rendering nothing, because "no credits listed" and "nothing to
 * credit" look identical on screen and mean very different things.
 *
 * The appearance keys are listed too. They are the exact strings a future asset pipeline
 * will resolve, so seeing them here is the reminder that every one of them needs a source,
 * an author and a licence before it resolves to a real file.
 */

interface AppearanceRef {
  readonly key: string;
  readonly usedBy: readonly string[];
}

function collectAppearances(): readonly AppearanceRef[] {
  const byKey = new Map<string, string[]>();

  const add = (key: string, label: string): void => {
    const list = byKey.get(key) ?? [];
    list.push(label);
    byKey.set(key, list);
  };

  for (const character of CONTENT_LIBRARY.characters) {
    add(character.appearance, character.name);
  }
  for (const prop of CONTENT_LIBRARY.props) {
    add(prop.appearance, prop.name);
  }

  return [...byKey.entries()]
    .map(([key, usedBy]) => ({ key, usedBy }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function CreditsPanel() {
  const appearances = collectAppearances();

  return (
    <section className="panel__block">
      <h2>素材署名</h2>
      <p className="panel__ok">
        <span className="panel__dot panel__dot--ok" />
        本构建包含 0 个外部素材文件
      </p>
      <p className="panel__note">
        全部图形由 PixiJS 程序绘制，全部音效由 WebAudio 振荡器合成。没有下载、没有外链、
        没有需要署名的第三方内容。
      </p>

      <details className="panel__details">
        <summary>外观键（{appearances.length}）</summary>
        <ul className="panel__appearances">
          {appearances.map((entry) => (
            <li key={entry.key}>
              <code>{entry.key}</code>
              <span>{entry.usedBy.join("、")}</span>
            </li>
          ))}
        </ul>
      </details>

      <p className="panel__note panel__note--future">
        引入外部素材时，每个外观键都必须在 <code>src/content/credits.ts</code> 登记：
        来源链接、作者、授权协议、获取日期。缺任何一项都不算核验完成。
      </p>

      {/* Without this line the list above reads as a to-do, and the one key on it that is
          already settled looks like the most urgent item. A `builtin:` source is drawn into
          an offscreen canvas at startup: it ships no bytes and has no author to credit. */}
      <p className="panel__note">
        <code>builtin:</code> 开头的来源是运行时用画布合成的临时占位，不落盘、不含第三方内容，因此不需要署名；
        它存在的唯一目的是让外观适配的成功路径被真正跑过一次。换成真素材时连同注册表条目一起删。
      </p>
    </section>
  );
}
