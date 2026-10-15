import { ASSET_CREDITS, findIncompleteCredits } from "../content/credits.ts";
import { CONTENT_LIBRARY } from "../content/library.ts";

/**
 * Asset attribution.
 *
 * The architecture baseline requires every public asset to be individually licence-checked
 * before it ships. That is easy to promise and easy to forget, so the mechanism goes in
 * before the first asset does.
 *
 * This build ships four external files across two kinds: the floor texture, the battle loop,
 * and the two character sheets the unit library resolves to. Three are CC0 and one is CC BY,
 * and the panel says so either way, because "no credits listed" and "nothing to credit" look
 * identical on screen and mean very different things.
 *
 * The appearance keys are listed too — now as the keys that actually resolve to files rather
 * than as a to-do list of ones that might. Seeing `toon-robot` next to the four characters
 * that share it is the honest picture: the art phase has started, and it started with two
 * silhouettes rather than eight.
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
  const problems = findIncompleteCredits(ASSET_CREDITS);

  return (
    <section className="panel__block">
      <h2>素材署名</h2>

      {problems.length > 0 ? (
        <ul className="panel__issues">
          {problems.map((problem, index) => (
            <li key={index}>
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {ASSET_CREDITS.length === 0 ? (
        <p className="panel__ok">
          <span className="panel__dot panel__dot--ok" />
          本构建包含 0 个外部素材文件
        </p>
      ) : (
        <>
          <p className="panel__ok">
            <span className="panel__dot panel__dot--ok" />
            已核验 {ASSET_CREDITS.length} 份外部素材
          </p>
          <ul className="panel__appearances">
            {ASSET_CREDITS.map((credit) => (
              <li key={`${credit.kind}:${credit.slot}`} className="panel__appearance-row">
                <code>{credit.slot}</code>
                <span className="appearance__state appearance__state--ready">{credit.kind}</span>
                <span className="appearance__reason">
                  {credit.title} · {credit.author} · {credit.licence} · 获取 {credit.obtained} ·{" "}
                  <a href={credit.source} target="_blank" rel="noreferrer noopener">
                    来源
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="panel__note">
        机关图形仍由 PixiJS 程序绘制，音效仍由 WebAudio 振荡器合成，这两部分没有第三方内容。
        外部文件是角色立绘、地面材质与循环 BGM。八个角色共用两个外观键：
        <code>toon-zombie</code> 给红方，<code>toon-robot</code> 给蓝方。
      </p>

      {/*
        The licence split is spelled out because the two rows carry different obligations and
        the row itself does not say which is which. CC0 asks for nothing; CC BY asks to be
        named, and a build that quietly stopped rendering the attribution would still look
        completely correct from the inside.
      */}
      <p className="panel__note">
        <strong>地面</strong>为 CC0，可商用、可打包、无需署名。 <strong>BGM</strong> 为 CC BY 4.0，
        免费可商用、可修改，但<strong>必须署名</strong>——所以页面上常驻一行「音乐：魔王魂」，
        与这里的记录同源。魔王魂的条款页另注明：不可冒充原创、不可单独再配布原曲、不可登记到著作权管理团体、
        不可用于生成式 AI 训练。本曲以「作品内使用」形式打包，属于 CC BY 4.0 允许的范围。
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
        外部素材分两类登记在 <code>src/content/credits.ts</code>：<code>appearance</code> 是角色／机关贴图，
        键必须与外观注册表一致；<code>material</code> 是渲染器直接加载的贴图与音轨，没有外观键可对照，
        所以登记本身就是唯一的核验记录。两类都要求来源链接、作者、授权协议、获取日期，缺任何一项都不算核验完成。
        CC0 素材本来不需要署名，仍然登记——「查过授权、结果是 CC0」这件事本身值得留档，
        只登记法律上必须署名的素材，就无法区分「查过」和「没查」。
      </p>

      {/* Both appearance rows are CC0, which is the one case where the licence question has
          an answer that looks like no answer. Saying so out loud is what stops the next
          reader from assuming the rows were never checked at all. */}
      <p className="panel__note">
        角色立绘来自 <strong>Kenney「Toon Characters」</strong>，为 <strong>CC0</strong>：
        可商用、可修改、可再配布，<strong>不强制署名</strong>。仍然登记，因为「查过授权、结果是 CC0」本身值得留档。
        该素材包里每个角色只有一张正面姿态，所以八个角色共用两个外观键——这是素材的限制，不是角色的设计。
      </p>
    </section>
  );
}
