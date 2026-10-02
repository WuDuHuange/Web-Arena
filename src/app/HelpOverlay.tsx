import { PROP_LIBRARY } from "../content/library.ts";
import { PROP_PALETTE } from "../render/props.ts";
import type { PropBehavior } from "../simulation/types.ts";

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

export function HelpOverlay({ fixedStepMs, onClose, onDismissForever }: HelpOverlayProps) {
  const ticksPerSecond = 1000 / fixedStepMs;

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
              <span className="help__desc">把当前布阵存成 JSON，或从文件读回一套布阵</span>
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
