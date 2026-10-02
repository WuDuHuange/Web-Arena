import {
  ABILITY_LIBRARY,
  BUFF_LIBRARY,
  CHARACTER_LIBRARY,
  PROP_LIBRARY,
  TAG_LABELS
} from "../content/library.ts";
import { PROP_PALETTE } from "../render/props.ts";
import { TAG_RULES } from "../simulation/effects.ts";
import type { TagRule } from "../simulation/effects.ts";
import type { BuffSpec, PropBehavior } from "../simulation/types.ts";

/**
 * First-run help.
 *
 * Written from the content library rather than by hand, for one reason: a hand-written
 * legend is a legend that eventually lies. Every trap description below is generated from
 * the same `behavior` numbers the simulation runs on, so "每 0.5 秒受到 6 点伤害" cannot
 * drift away from what the lava actually does.
 *
 * Shown once, then remembered. It is always reachable again from the panel.
 */

interface HelpOverlayProps {
  /** Authoritative step length, used to turn tick counts into seconds for a human. */
  readonly fixedStepMs: number;
  readonly onClose: () => void;
  /** Close and stop showing automatically on future visits. */
  readonly onDismissForever: () => void;
}

/** PixiJS colours are numbers; CSS wants strings. */
function toCss(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function describeBehavior(behavior: PropBehavior, ticksPerSecond: number): string {
  const span = (ticks: number): string => {
    if (ticks <= 0) {
      return "";
    }
    const seconds = ticks / ticksPerSecond;
    return seconds >= 1 ? `${Number(seconds.toFixed(1))} 秒` : `${Math.round(seconds * 1000)} 毫秒`;
  };

  switch (behavior.kind) {
    case "aura":
      return `范围内每 ${span(behavior.intervalTicks)}受到 ${behavior.damage} 点伤害`;
    case "conveyor":
      return "把范围内的单位朝箭头方向持续推动";
    case "spring":
      return `踩到会被弹开，冷却 ${span(behavior.cooldownTicks)}`;
    case "explosive":
      return `被触碰后爆炸：${behavior.damage} 点伤害，击退半径 ${behavior.reach}`;
    case "spike":
      return `踩到受到 ${behavior.damage} 点伤害，冷却 ${span(behavior.cooldownTicks)}`;
    case "turret":
      return `射击最近的敌人：${behavior.damage} 点伤害，射程 ${behavior.reach}`;
    case "shrine":
      return `周期性攻击敌人：${behavior.damage} 点伤害，射程 ${behavior.reach}`;
  }
}

/** The modifier fields a tag rule and a buff spec have in common. */
interface ModifierFields {
  readonly moveSpeed?: number;
  readonly damageOut?: number;
  readonly damageIn?: number;
  readonly attackRate?: number;
}

/** `0.6` reads as `−40%`, which is what the number actually means to a player. */
function asPercent(value: number): string {
  const delta = Math.round((value - 1) * 100);
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)}%`;
}

/**
 * Turns a multiplier set into a sentence.
 *
 * Generated from the same numbers `modifiersOf` runs on, so the legend cannot drift away
 * from what a tag or a buff actually does — which is the failure this whole file exists to
 * avoid. A hand-written "装甲：更耐打" would still be true after someone retuned the values
 * to mean the opposite.
 */
function describeModifiers(source: ModifierFields): string {
  const parts: string[] = [];
  if (source.moveSpeed !== undefined) {
    parts.push(`移速 ${asPercent(source.moveSpeed)}`);
  }
  if (source.damageOut !== undefined) {
    parts.push(`造成伤害 ${asPercent(source.damageOut)}`);
  }
  if (source.damageIn !== undefined) {
    parts.push(`受到伤害 ${asPercent(source.damageIn)}`);
  }
  if (source.attackRate !== undefined) {
    parts.push(`攻速 ${asPercent(source.attackRate)}`);
  }
  return parts.join("，");
}

function describeTag(rule: TagRule): string {
  const parts: string[] = [];
  const modifiers = describeModifiers(rule);
  if (modifiers.length > 0) {
    parts.push(modifiers);
  }
  if (rule.ignoresGroundHazards === true) {
    parts.push("无视地面机关（熔岩／传送带／地刺／弹簧），但照常撞墙、被爆炸波及、被射击");
  }
  return parts.join("；");
}

/** Which shipped characters carry a tag, so the legend names a unit rather than a rule. */
function tagCarriers(tag: string): string {
  return CHARACTER_LIBRARY.filter((c) => (c.tags ?? []).includes(tag))
    .map((c) => c.name)
    .join("、");
}

/** Which shipped abilities apply a buff, and whose they are. */
function buffSources(buffId: string): string {
  const sources: string[] = [];
  for (const character of CHARACTER_LIBRARY) {
    for (const abilityId of character.abilityIds) {
      const ability = ABILITY_LIBRARY.find((a) => a.id === abilityId);
      if (ability?.spec.appliesBuff?.buffId === buffId) {
        sources.push(`${character.name}的${ability.name}`);
      }
    }
  }
  return sources.join("、");
}

function describeBuff(spec: BuffSpec, ticksPerSecond: number): string {
  const seconds = spec.durationTicks / ticksPerSecond;
  const stacks = spec.maxStacks > 1 ? `，最多叠 ${spec.maxStacks} 层` : "";
  const source = buffSources(spec.id);
  const prefix = source.length > 0 ? `${source}命中后：` : "";
  return `${prefix}${describeModifiers(spec)}，持续 ${Number(seconds.toFixed(1))} 秒${stacks}`;
}

export function HelpOverlay({ fixedStepMs, onClose, onDismissForever }: HelpOverlayProps) {
  const ticksPerSecond = 1000 / fixedStepMs;
  const tags = Object.entries(TAG_RULES);
  // Only the tags somebody actually carries are worth a row. A rule with no unit behind it
  // is a rule a player will never meet.
  const shippedTags = tags.filter(([tag]) => tagCarriers(tag).length > 0);

  return (
    <div className="help" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div className="help__card">
        <header className="help__header">
          <h2 id="help-title">Project Arena</h2>
          <p className="help__subtitle">2D 顶视角自动战斗沙盒</p>
        </header>

        <section className="help__section">
          <h3>这是什么</h3>
          <p>
            两支队伍在场上自动交战。你不控制任何单位——你的工作是布置双方、开战，然后观察结果。
            战斗完全由固定步长的仿真决定，画面刷新率不影响任何伤害或计时。
          </p>
        </section>

        <section className="help__section">
          <h3>怎么开始</h3>
          <p>
            点右侧的<strong>开战</strong>。想换个场景，用地址栏的 <code>?scene=</code>：
            <code>battle</code> 是纯对战，<code>mechanism</code> 是布满机关的场地，
            <code>squad</code> 是每边三倍兵力的拥挤场景。
          </p>
        </section>

        <section className="help__section">
          <h3>自己布置战场</h3>
          <p>
            待命时战场就是编辑器：点<strong>＋</strong>把单位或机关放到场上，按住拖动位置，
            选中后用 <strong>↺ / ↻</strong> 或 <strong>Q / E</strong> 调整朝向，方向键微调，
            <strong>Delete</strong> 删除。按<strong>清空</strong>可以从空场开始，只放一个红方和一个蓝方就能打一局。
          </p>
          <p>
            预览和实战是同一份数据——你在待命时看到的画面，就是开战后真正会跑的那一场。
            选中会画一圈亮色环，画红虚线的位置表示它会被拒绝，比如压到别的单位身上或越出边界；
            有红环时<strong>开战</strong>会被拦住，右侧会列出原因。
          </p>
        </section>

        <section className="help__section">
          <h3>战场上你会看到</h3>
          <ul className="help__units">
            <li>
              <span className="help__swatch" style={{ background: "#e0554b", borderColor: "#ffb3ac" }} />
              <span className="help__name">红方单位</span>
              <span className="help__desc">圆形本体 + 朝向短线 + 血条</span>
            </li>
            <li>
              <span className="help__swatch" style={{ background: "#4b8fe0", borderColor: "#a9cdf7" }} />
              <span className="help__name">蓝方单位</span>
              <span className="help__desc">同上；朝向短线变亮表示正在起手</span>
            </li>
            <li>
              <span className="help__swatch help__swatch--shot" />
              <span className="help__name">投射物</span>
              <span className="help__desc">炮台与神龛发射的暖色光点</span>
            </li>
          </ul>

          <h3 className="help__gap">单位特性</h3>
          <p className="help__hint">
            特性写在角色定义里，由能力表解释含义——特性本身不是效果，它只是一个声明。
            每一条下面的数字就是仿真真正使用的倍率，不是描述。
          </p>
          <ul className="help__units">
            {shippedTags.map(([tag, rule]) => (
              <li key={tag}>
                <span className="help__swatch help__swatch--none" />
                <span className="help__name">{TAG_LABELS[tag] ?? tag}</span>
                <span className="help__desc">
                  {tagCarriers(tag)} · {describeTag(rule)}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="help__gap">负面效果</h3>
          <p className="help__hint">
            技能命中时施加，各自独立计时。重复命中只刷新时长、不延长；能叠层的按「相加」算，
            所以第二层和第一层一样强，不会越叠越夸张。
          </p>
          <ul className="help__units">
            {BUFF_LIBRARY.map((buff) => (
              <li key={buff.id}>
                <span className="help__swatch help__swatch--none" />
                <span className="help__name">{buff.name}</span>
                <span className="help__desc">{describeBuff(buff, ticksPerSecond)}</span>
              </li>
            ))}
          </ul>

          <h3 className="help__gap">场地机关</h3>
          <p className="help__hint">
            机关不属于任何一方，双方都会受影响。半透明外圈是<strong>效果范围</strong>，
            中心的小实体才是碰撞体——两者大小不同。
          </p>
          <ul className="help__props">
            {PROP_LIBRARY.map((prop) => {
              const palette = PROP_PALETTE[prop.behavior.kind];
              return (
                <li key={prop.id}>
                  <span
                    className="help__swatch"
                    style={{ background: toCss(palette.base), borderColor: toCss(palette.glow) }}
                  />
                  <span className="help__name">{prop.name}</span>
                  <span className="help__desc">{describeBehavior(prop.behavior, ticksPerSecond)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="help__section">
          <h3>面板上的按钮</h3>
          <ul className="help__units">
            <li>
              {/* Rows are a three-column grid; a row without a colour chip still needs the
                  first cell, or its label lands in the 14px swatch column and wraps to one
                  character per line. */}
              <span className="help__swatch help__swatch--none" />
              <span className="help__name">开战 / 暂停</span>
              <span className="help__desc">推进或冻结仿真；暂停不会改变任何计时</span>
            </li>
            <li>
              <span className="help__swatch help__swatch--none" />
              <span className="help__name">重置</span>
              <span className="help__desc">把战场恢复到初始状态，逐实体精确还原</span>
            </li>
            <li>
              <span className="help__swatch help__swatch--none" />
              <span className="help__name">音效</span>
              <span className="help__desc">开关合成音效；浏览器需要一次点击才会解锁声音</span>
            </li>
            <li>
              <span className="help__swatch help__swatch--none" />
              <span className="help__name">导出 / 导入布阵</span>
              <span className="help__desc">
                把当前布阵存成 JSON，或从文件读回一套布阵；读回的布阵同样可以继续编辑
              </span>
            </li>
          </ul>
        </section>

        <footer className="help__footer">
          <button type="button" onClick={onClose}>
            知道了
          </button>
          <button type="button" onClick={onDismissForever}>
            不再自动显示
          </button>
        </footer>
      </div>
    </div>
  );
}
