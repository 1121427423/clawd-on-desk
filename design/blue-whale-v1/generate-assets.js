"use strict";

// Reproducible, self-contained SVG art for the Blue Whale v1 review prototype.
// This folder is intentionally outside /themes so the draft is not registered
// as a built-in theme before it has been reviewed.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const ASSETS = path.join(ROOT, "assets");
fs.mkdirSync(ASSETS, { recursive: true });

const palette = {
  skin: "#3486A6",
  skinLight: "#56A9C2",
  skinDark: "#246C89",
  fin: "#286F8D",
  belly: "#DDF2F0",
  bellyShade: "#BBDDDC",
  ink: "#173B52",
  bubble: "#9AE5EA",
  bubbleLight: "#D7FAF8",
  gold: "#F4C66A",
  coral: "#F28F83",
  mint: "#90D8BE",
};

const bubble = (x, y, r, klass = "bubble bubble-a", fill = palette.bubbleLight) =>
  `<circle class="${klass}" cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;

const spark = (x, y, klass = "spark spark-a", fill = palette.gold) =>
  `<path class="${klass}" d="M${x} ${y - 1.1}L${x + 0.35} ${y - 0.35}L${x + 1.1} ${y}L${x + 0.35} ${y + 0.35}L${x} ${y + 1.1}L${x - 0.35} ${y + 0.35}L${x - 1.1} ${y}L${x - 0.35} ${y - 0.35}Z" fill="${fill}"/>`;

const bubbles = (positions) => positions.map(([x, y, r, klass, fill]) => bubble(x, y, r, klass, fill)).join("\n");
const sparkles = (positions) => positions.map(([x, y, klass, fill]) => spark(x, y, klass, fill)).join("\n");

const commonCss = `
      .shadow-shape { transform-box: fill-box; transform-origin: center; animation: shadow-breathe 4.2s ease-in-out infinite; }
      .body-motion { transform-origin: 7.5px 10px; animation: body-float 4.2s ease-in-out infinite; }
      .tail-motion { transform-origin: 1px 9.8px; animation: tail-sway 1.8s ease-in-out infinite; }
      .pectoral-fin { transform-box: fill-box; transform-origin: 15% 15%; }
      .eyes-blink { transform-box: fill-box; transform-origin: center; animation: blink 5.2s ease-in-out infinite; }
      .eye-closed { display: none; }
      .bubble { opacity: 0; transform-box: fill-box; transform-origin: center; }
      .bubble-a { animation: bubble-rise 2.8s ease-out infinite; }
      .bubble-b { animation: bubble-rise 2.8s -0.9s ease-out infinite; }
      .bubble-c { animation: bubble-rise 2.8s -1.8s ease-out infinite; }
      .spark { opacity: 0; transform-box: fill-box; transform-origin: center; }
      .spark-a { animation: twinkle 1.25s 0s ease-in-out infinite; }
      .spark-b { animation: twinkle 1.25s -0.42s ease-in-out infinite; }
      .spark-c { animation: twinkle 1.25s -0.84s ease-in-out infinite; }
      .whale-skin { fill: ${palette.skin}; }
      .whale-highlight { fill: ${palette.skinLight}; }
      .whale-fin { fill: ${palette.fin}; }
      .whale-belly { fill: ${palette.belly}; }
      .whale-belly-shade { fill: ${palette.bellyShade}; }
      .whale-ink { fill: ${palette.ink}; }
      .mouth-open { opacity: 0; transform-box: fill-box; transform-origin: center; }
      .brow { opacity: 0; }
      @keyframes body-float { 0%,100% { transform: translateY(0) scale(1,1); } 50% { transform: translateY(-0.45px) scale(1.012,0.99); } }
      @keyframes tail-sway { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-10deg); } 75% { transform: rotate(9deg); } }
      @keyframes blink { 0%,88%,100% { transform: scaleY(1); } 91% { transform: scaleY(0.12); } 94% { transform: scaleY(1); } }
      @keyframes shadow-breathe { 0%,100% { transform: scaleX(1); opacity: 0.34; } 50% { transform: scaleX(0.9); opacity: 0.23; } }
      @keyframes bubble-rise { 0%,15% { opacity: 0; transform: translateY(0) scale(0.45); } 28% { opacity: 0.9; } 78% { opacity: 0.8; transform: translateY(-3px) scale(1); } 100% { opacity: 0; transform: translateY(-4px) scale(0.8); } }
      @keyframes twinkle { 0%,100% { opacity: 0; transform: scale(0.35); } 45%,65% { opacity: 1; transform: scale(1); } }
      @keyframes fin-wave { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-18deg); } }
      @keyframes body-shake { 0%,100% { transform: translateX(0); } 20% { transform: translateX(-0.8px) rotate(-2deg); } 40% { transform: translateX(0.8px) rotate(2deg); } 60% { transform: translateX(-0.6px) rotate(-1deg); } 80% { transform: translateX(0.4px) rotate(1deg); } }
      @keyframes body-bounce { 0%,100% { transform: translateY(0) scale(1,1); } 18% { transform: translateY(0.4px) scale(1.04,0.92); } 48% { transform: translateY(-3px) scale(0.98,1.04); } 72% { transform: translateY(-1px) scale(1,1); } }
      @keyframes bubble-pop { 0%,100% { opacity: 0; transform: scale(0.35); } 40%,70% { opacity: 1; transform: scale(1); } }
      @keyframes blink-once { 0%,38%,100% { transform: scaleY(1); } 45%,51% { transform: scaleY(0.1); } }
      @keyframes spin-wobble { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(-7deg); } 50% { transform: rotate(5deg); } 75% { transform: rotate(-4deg); } }
      @keyframes pulse { 0%,100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }
      @keyframes sweep-fin { 0%,100% { transform: rotate(0deg); } 25% { transform: rotate(20deg); } 55% { transform: rotate(-24deg); } 80% { transform: rotate(8deg); } }
      @keyframes tap-fin { 0%,100% { transform: rotate(0deg) translateY(0); } 25% { transform: rotate(-10deg) translateY(0.5px); } 50% { transform: rotate(3deg) translateY(0); } 75% { transform: rotate(-8deg) translateY(0.4px); } }
      @keyframes bell-ring { 0%,100% { transform: rotate(0deg); } 20% { transform: rotate(-12deg); } 40% { transform: rotate(10deg); } 60% { transform: rotate(-8deg); } 80% { transform: rotate(5deg); } }
      @keyframes orbit { 0% { transform: rotate(0deg) translateX(0); } 50% { transform: rotate(180deg) translateX(0.7px); } 100% { transform: rotate(360deg) translateX(0); } }
      @keyframes yawn-body { 0%,14%,100% { transform: translateY(0) scale(1,1); } 36% { transform: translateY(-0.6px) scale(0.97,1.08); } 58% { transform: translateY(-0.4px) scale(0.94,1.12); } 78% { transform: translateY(0.5px) scale(1.04,0.94); } }
      @keyframes yawn-mouth { 0%,20%,100% { opacity: 0; transform: scale(0.2); } 38%,70% { opacity: 1; transform: scale(1); } 84% { opacity: 0; transform: scale(0.4); } }
      @keyframes doze-body { 0%,100% { transform: translateY(0.35px) scale(1.02,0.96); } 50% { transform: translateY(0.75px) scale(1.04,0.94); } }
      @keyframes collapse { 0% { transform: rotate(0deg) translateY(0); } 35% { transform: rotate(-10deg) translateY(0.5px); } 72% { transform: rotate(78deg) translateY(1px); } 100% { transform: rotate(83deg) translateY(1.2px); } }
      @keyframes wake-up { 0% { transform: translateY(2px) rotate(9deg) scale(0.9,0.9); } 34% { transform: translateY(-2.5px) rotate(-5deg) scale(1.04,0.96); } 62% { transform: translateY(0.8px) rotate(3deg) scale(0.98,1.04); } 100% { transform: translateY(0) rotate(0) scale(1,1); } }
      @keyframes think-tilt { 0%,100% { transform: rotate(0deg) translateY(0); } 35%,68% { transform: rotate(-3deg) translateY(-0.2px); } }
      @keyframes swim-bob { 0%,100% { transform: translateX(-0.6px) translateY(0); } 50% { transform: translateX(0.8px) translateY(-0.35px); } }
      @keyframes look-eyes { 0%,24%,100% { transform: translateX(0); } 38%,56% { transform: translateX(0.6px); } 70%,86% { transform: translateX(-0.5px); } }
      @keyframes alert-pop { 0%,100% { transform: translateY(0) scale(1); } 35% { transform: translateY(-1.6px) scale(1.06); } 62% { transform: translateY(0.3px) scale(0.98); } }
      @keyframes roam { 0%,100% { transform: translateX(-1.1px) translateY(0); } 50% { transform: translateX(1.1px) translateY(-0.3px); } }
      @keyframes mini-enter { 0% { transform: translateY(4px) scale(0.45); opacity: 0; } 70% { transform: translateY(-1px) scale(1.08); opacity: 1; } 100% { transform: translateY(0) scale(1); opacity: 1; } }
      @keyframes mini-peek { 0%,100% { transform: translateX(-2.4px); } 50% { transform: translateX(0); } }
      @keyframes drag-stretch { 0%,100% { transform: scaleX(1); } 35% { transform: scaleX(1.18) translateX(-0.5px); } 70% { transform: scaleX(0.92) translateX(0.5px); } }
      @keyframes double-hop { 0%,100% { transform: translateY(0); } 20% { transform: translateY(0.2px) scale(1.04,0.94); } 42% { transform: translateY(-3.8px) scale(0.98,1.04); } 62% { transform: translateY(0.2px) scale(1.04,0.94); } 82% { transform: translateY(-2.4px); } }
      @keyframes fin-tap { 0%,100% { transform: rotate(0deg); } 35%,65% { transform: rotate(-22deg); } }
      @keyframes package-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-0.7px); } }
      @keyframes coral-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
      @keyframes wave-sweep { 0%,100% { transform: translateX(0); opacity: 0.2; } 40% { transform: translateX(2px); opacity: 1; } 75% { transform: translateX(4px); opacity: 0; } }
`;

const tailArt = `
      <g class="tail-motion">
        <path d="M2 9.1L-2 6L-1 9.25L-3 12L2 10.6Z" class="whale-fin"/>
        <path d="M1.7 9.65L-0.9 8.4L-0.35 9.8L-0.95 11.05L1.9 10.3Z" class="whale-skin"/>
      </g>`;

const bodyArt = `
      <g class="whale-core">
        <path class="whale-skin" d="M1 9L3 7L6 6L12 6L15 7L17 9L18 10L16 12L13 13L6 13L3 12L1 10Z"/>
        <path class="whale-belly" d="M2 10L16.8 10L16 11.8L13 12.8L6.2 12.8L3.2 11.8Z"/>
        <path class="whale-belly-shade" d="M4.2 11.7L6.3 12.35L12.6 12.35L14.1 11.8L13 12.8L6.2 12.8Z"/>
        <path class="whale-highlight" d="M4 7.25L6.2 6.55L10.8 6.55L8.6 7.05L5.2 7.65Z"/>
        <path class="whale-fin" d="M7 6L8.6 4L10.2 6Z"/>
        <path class="whale-fin pectoral-fin" d="M8.9 11.2L12 11.1L13.4 12.9L11.2 15L9.2 13.5Z"/>
        <path class="whale-highlight" d="M9.6 11.75L11.5 11.65L12.4 12.8L11.1 13.65Z"/>
        <rect x="8.1" y="5.7" width="0.9" height="0.35" rx="0.15" class="whale-ink"/>
        <g id="eyes-js">
          <g class="eyes-blink">
            <circle class="eye-open whale-ink" cx="13.2" cy="8.65" r="0.68" fill="${palette.ink}"/>
            <circle class="eye-shine" cx="13.38" cy="8.43" r="0.17" fill="${palette.bubbleLight}"/>
            <path class="eye-closed" d="M12.45 8.75Q13.15 9.15 13.9 8.72" fill="none" stroke="${palette.ink}" stroke-width="0.42" stroke-linecap="round"/>
          </g>
        </g>
        <path class="mouth-smile" d="M16.2 10.15Q16.8 10.55 17.35 10.28" fill="none" stroke="${palette.ink}" stroke-width="0.38" stroke-linecap="round"/>
        <ellipse class="mouth-open" cx="16.45" cy="10.55" rx="0.65" ry="0.55" fill="${palette.ink}"/>
        <path class="mouth-tongue" d="M16.05 10.72Q16.45 10.45 16.83 10.72" fill="none" stroke="${palette.coral}" stroke-width="0.22" stroke-linecap="round" opacity="0"/>
      </g>`;

const stateAssets = [
  {
    file: "whale-idle.svg", title: "待机 · 浮游", state: "idle", tracked: true,
    front: bubbles([[8.6, 3.4, 0.35, "bubble bubble-a"], [9.6, 2.6, 0.25, "bubble bubble-b"], [7.6, 3.1, 0.22, "bubble bubble-c"]]),
    css: `.state-idle { animation: body-float 4.2s ease-in-out infinite; }\n      .state-idle .tail-motion { animation-duration: 2.1s; }`,
  },
  {
    file: "whale-roam.svg", title: "游动 · 巡游", state: "roam",
    front: `${bubble(-1.4, 8, 0.28, "bubble bubble-a")}${bubble(-2.5, 10, 0.2, "bubble bubble-b")}`,
    css: `.state-roam { animation: roam 1.45s ease-in-out infinite; }\n      .state-roam .tail-motion { animation-duration: 0.7s; }\n      .state-roam .pectoral-fin { animation: fin-wave 0.7s ease-in-out infinite; }`,
  },
  {
    file: "whale-yawning.svg", title: "打哈欠 · 入睡前", state: "yawning", eyeMode: "closed",
    front: `<ellipse class="yawn-mouth" cx="16.45" cy="10.55" rx="0.9" ry="1.05" fill="${palette.ink}"/><path class="yawn-tongue" d="M15.9 11.1Q16.45 10.8 17 11.1" fill="none" stroke="${palette.coral}" stroke-width="0.28"/>${bubble(8.7, 3.1, 0.24, "bubble bubble-a")}`,
    css: `.state-yawning { animation: yawn-body 2.8s ease-in-out 1 both; }\n      .state-yawning .tail-motion { animation: tail-sway 2.8s ease-in-out 1 both; }\n      .state-yawning .eyes-blink { animation: blink-once 2.8s ease-in-out 1 both; }\n      .state-yawning .mouth-open,.state-yawning .mouth-tongue { opacity: 0; }\n      .yawn-mouth { opacity: 0; transform-box: fill-box; transform-origin: center; animation: yawn-mouth 2.8s ease-in-out 1 both; }\n      .yawn-tongue { opacity: 0; animation: yawn-mouth 2.8s ease-in-out 1 both; }`,
  },
  {
    file: "whale-dozing.svg", title: "打盹 · 轻呼吸", state: "dozing", eyeMode: "closed",
    front: `<path class="sleep-z z-one" d="M16 4H18.2L16.55 5.7H18.2V6.15H15.9L17.55 4.45H16Z" fill="${palette.bubble}"/><path class="sleep-z z-two" d="M18.2 2.7H19.5L18.55 3.7H19.5V4H18.1L19.05 3H18.2Z" fill="${palette.bubble}"/>`,
    css: `.state-dozing { animation: doze-body 4.6s ease-in-out infinite; }\n      .state-dozing .tail-motion { animation-duration: 3.8s; }\n      .state-dozing .eyes-blink { animation: none; }\n      .state-dozing .sleep-z { animation: pulse 2.8s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }\n      .state-dozing .z-two { animation-delay: -1.3s; }`,
  },
  {
    file: "whale-collapsing.svg", title: "倒下 · 睡眠过渡", state: "collapsing", eyeMode: "closed",
    front: `${bubble(18, 5, 0.32, "bubble bubble-a")}${bubble(19, 4, 0.2, "bubble bubble-b")}`,
    css: `.state-collapsing { animation: collapse 1.25s cubic-bezier(.2,.8,.3,1) 1 forwards; }\n      .state-collapsing .tail-motion { animation-duration: 0.45s; }\n      .state-collapsing .eyes-blink { animation: blink-once 1.25s ease-in-out 1 both; }`,
  },
  {
    file: "whale-thinking.svg", title: "思考 · 气泡灵感", state: "thinking",
    front: `${bubble(16.4, 4.3, 0.45, "bubble thought thought-a", palette.bubbleLight)}${bubble(18, 2.9, 0.62, "bubble thought thought-b", palette.bubbleLight)}${bubble(19.2, 1.2, 0.88, "bubble thought thought-c", palette.bubbleLight)}<circle cx="19.2" cy="1.2" r="0.2" fill="${palette.skinDark}"/><circle cx="18.55" cy="1.2" r="0.2" fill="${palette.skinDark}"/><circle cx="19.85" cy="1.2" r="0.2" fill="${palette.skinDark}"/>`,
    css: `.state-thinking { animation: think-tilt 3.2s ease-in-out infinite; }\n      .state-thinking .tail-motion { animation-duration: 2.8s; }\n      .thought { animation: pulse 2.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }\n      .thought-b { animation-delay: -0.5s; }\n      .thought-c { animation-delay: -1s; }`,
  },
  {
    file: "whale-typing.svg", title: "工作 · 鳍尖敲键", state: "working",
    front: `<g class="work-pad"><rect x="11.6" y="12.3" width="5.8" height="2.55" rx="0.35" fill="${palette.ink}"/><rect x="12.05" y="12.65" width="4.9" height="0.9" rx="0.18" fill="${palette.bubble}"/><path d="M12.2 14H12.8M13.2 14H13.8M14.2 14H14.8M15.2 14H15.8" stroke="${palette.belly}" stroke-width="0.24" stroke-linecap="round"/></g>`,
    css: `.state-working { animation: body-float 2.6s ease-in-out infinite; }\n      .state-working .tail-motion { animation-duration: 1s; }\n      .state-working .pectoral-fin { animation: tap-fin 0.52s ease-in-out infinite; }\n      .work-pad { transform-box: fill-box; transform-origin: center; animation: pulse 1.2s ease-in-out infinite; }`,
  },
  {
    file: "whale-juggling.svg", title: "多任务 · 泡泡杂耍", state: "juggling",
    front: bubbles([[4, 3.1, 0.62, "bubble bubble-a", palette.bubbleLight], [10, 1.3, 0.75, "bubble bubble-b", palette.bubble], [16.2, 3, 0.58, "bubble bubble-c", palette.mint]]),
    css: `.state-juggling { animation: body-bounce 1.45s ease-in-out infinite; }\n      .state-juggling .tail-motion { animation-duration: 0.7s; }\n      .state-juggling .bubble { animation-name: bubble-pop; animation-duration: 1.35s; }\n      .state-juggling .bubble-b { animation-delay: -0.45s; }\n      .state-juggling .bubble-c { animation-delay: -0.9s; }`,
  },
  {
    file: "whale-building.svg", title: "并行任务 · 堆珊瑚", state: "building",
    back: `<g class="coral-stack"><rect x="16.6" y="8.6" width="2.2" height="2" rx="0.2" fill="${palette.coral}"/><rect x="18.8" y="7.2" width="2.2" height="2" rx="0.2" fill="${palette.gold}"/><rect x="18.8" y="9.5" width="2.2" height="2" rx="0.2" fill="${palette.mint}"/><path d="M17.2 8.6V8M19.4 7.2V6.6" stroke="${palette.belly}" stroke-width="0.25"/></g>`,
    front: `${spark(19.7, 5.7, "spark spark-a", palette.gold)}${bubble(16.2, 6.2, 0.27, "bubble bubble-b")}`,
    css: `.state-building { animation: body-float 2.2s ease-in-out infinite; }\n      .state-building .tail-motion { animation-duration: 1.1s; }\n      .coral-stack { transform-box: fill-box; transform-origin: bottom left; animation: coral-pulse 1.6s ease-in-out infinite; }`,
  },
  {
    file: "whale-sweeping.svg", title: "清理 · 扫走碎泡", state: "sweeping",
    front: `<g class="broom"><path d="M11.3 11.6L15.8 7.4" stroke="${palette.ink}" stroke-width="0.45" stroke-linecap="round"/><path d="M14.9 7.2L16.5 8.2L15.8 9L14.3 8Z" fill="${palette.gold}"/></g><g class="sweep-wave"><path d="M15 13.4H20" stroke="${palette.bubble}" stroke-width="0.3" stroke-dasharray="0.6 0.5"/></g>${bubble(19, 12.8, 0.25, "bubble bubble-a", palette.coral)}${bubble(20.5, 12, 0.19, "bubble bubble-b", palette.gold)}`,
    css: `.state-sweeping { animation: body-float 2.8s ease-in-out infinite; }\n      .state-sweeping .pectoral-fin { animation: sweep-fin 1.1s ease-in-out infinite; }\n      .broom { transform-box: fill-box; transform-origin: 11px 12px; animation: sweep-fin 1.1s ease-in-out infinite; }\n      .sweep-wave { animation: wave-sweep 1.4s ease-out infinite; }`,
  },
  {
    file: "whale-error.svg", title: "错误 · 慌张冒泡", state: "error", eyeMode: "angry",
    front: `${bubble(17.8, 4.6, 0.42, "bubble bubble-a", palette.coral)}${bubble(19.1, 3.5, 0.26, "bubble bubble-b", palette.coral)}<path d="M11.9 7.4L13.5 7.85" stroke="${palette.ink}" stroke-width="0.38" stroke-linecap="round" class="error-brow"/>`,
    css: `.state-error { animation: body-shake 0.43s ease-in-out infinite; }\n      .state-error .tail-motion { animation-duration: 0.43s; }\n      .state-error .eyes-blink { animation: blink-once 1.3s linear infinite; }\n      .error-brow { opacity: 1; }`,
  },
  {
    file: "whale-attention.svg", title: "注意 · 水花提示", state: "attention",
    front: `<g class="attention-mark"><path d="M18 2.5L19 4.2L18.35 4.2L18.35 5.2L17.65 5.2L17.65 4.2L17 4.2Z" fill="${palette.gold}"/><rect x="17.7" y="5.6" width="0.6" height="0.55" rx="0.2" fill="${palette.gold}"/>${spark(15.7, 3.6, "spark spark-a", palette.bubble)}</g>`,
    css: `.state-attention { animation: alert-pop 1.2s ease-in-out infinite; }\n      .state-attention .tail-motion { animation-duration: 0.9s; }\n      .attention-mark { transform-box: fill-box; transform-origin: center bottom; animation: bubble-pop 1.2s ease-in-out infinite; }`,
  },
  {
    file: "whale-notification.svg", title: "通知 · 小铃声", state: "notification",
    front: `<g class="notification-bell"><path d="M17.4 4.6C17.4 3.8 18 3.3 18.7 3.3C19.4 3.3 20 3.8 20 4.6V5.1L20.6 6.2H16.8L17.4 5.1Z" fill="${palette.gold}"/><rect x="18.2" y="6.35" width="1" height="0.45" rx="0.18" fill="${palette.gold}"/><path d="M16.3 4.3Q15.7 4.9 16.2 5.4M20.5 4.3Q21.1 4.9 20.6 5.4" fill="none" stroke="${palette.bubble}" stroke-width="0.35"/></g>`,
    css: `.state-notification { animation: body-bounce 1.7s ease-in-out infinite; }\n      .notification-bell { transform-box: fill-box; transform-origin: center bottom; animation: bell-ring 0.72s ease-in-out infinite; }\n      .state-notification .tail-motion { animation-duration: 0.9s; }`,
  },
  {
    file: "whale-carrying.svg", title: "搬运 · 抱着小包裹", state: "carrying",
    front: `<g class="parcel"><rect x="15.5" y="8.8" width="3.5" height="3.3" rx="0.28" fill="${palette.gold}"/><path d="M15.5 9.7H19M17.2 8.8V12.1" stroke="${palette.coral}" stroke-width="0.42"/><path d="M16.4 8.8Q17.2 7.8 18 8.8" fill="none" stroke="${palette.coral}" stroke-width="0.38"/></g>`,
    css: `.state-carrying { animation: body-float 1.8s ease-in-out infinite; }\n      .state-carrying .tail-motion { animation-duration: 1s; }\n      .state-carrying .pectoral-fin { animation: fin-wave 0.8s ease-in-out infinite; }\n      .parcel { transform-box: fill-box; transform-origin: center; animation: package-bob 0.8s ease-in-out infinite; }`,
  },
  {
    file: "whale-sleeping.svg", title: "深睡 · 安心呼吸", state: "sleeping", eyeMode: "closed",
    front: `<path class="sleep-z z-one" d="M16 4H18.2L16.55 5.7H18.2V6.15H15.9L17.55 4.45H16Z" fill="${palette.bubble}"/><path class="sleep-z z-two" d="M18.2 2.7H19.5L18.55 3.7H19.5V4H18.1L19.05 3H18.2Z" fill="${palette.bubble}"/>`,
    css: `.state-sleeping { animation: doze-body 5.4s ease-in-out infinite; }\n      .state-sleeping .tail-motion { animation-duration: 4.5s; }\n      .state-sleeping .eyes-blink { animation: none; }\n      .state-sleeping .sleep-z { animation: pulse 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }\n      .state-sleeping .z-two { animation-delay: -1.55s; }`,
  },
  {
    file: "whale-waking.svg", title: "醒来 · 弹起", state: "waking", eyeMode: "open",
    front: `${bubble(17.5, 4, 0.32, "bubble bubble-a")}${spark(18.7, 2.6, "spark spark-b", palette.gold)}`,
    css: `.state-waking { animation: wake-up 1.65s cubic-bezier(.2,.8,.25,1) 1 both; }\n      .state-waking .tail-motion { animation-duration: 0.5s; }\n      .state-waking .eyes-blink { animation: blink-once 1.65s ease-out 1 both; }`,
  },
  {
    file: "whale-dizzy.svg", title: "眩晕 · 星星打转", state: "dizzy",
    front: `${spark(6, 3, "spark spark-a", palette.gold)}${spark(16, 4, "spark spark-b", palette.coral)}${spark(12, 1.5, "spark spark-c", palette.mint)}`,
    css: `.state-dizzy { animation: spin-wobble 1.05s ease-in-out infinite; }\n      .state-dizzy .tail-motion { animation-duration: 0.5s; }\n      .state-dizzy .spark { animation: orbit 1.7s linear infinite; transform-origin: 10px 8px; }`,
  },
  {
    file: "whale-idle-bubbles.svg", title: "闲置动作 · 吹泡泡", state: "idle-bubbles",
    front: bubbles([[8.4, 3.7, 0.3, "bubble bubble-a"], [9.4, 2.2, 0.45, "bubble bubble-b"], [7.6, 1.3, 0.58, "bubble bubble-c"]]),
    css: `.state-idle-bubbles { animation: body-float 4.5s ease-in-out infinite; }\n      .state-idle-bubbles .tail-motion { animation-duration: 2.2s; }`,
  },
  {
    file: "whale-idle-look.svg", title: "闲置动作 · 四处张望", state: "idle-look",
    css: `.state-idle-look { animation: think-tilt 4s ease-in-out infinite; }\n      .state-idle-look .tail-motion { animation-duration: 2.2s; }\n      .state-idle-look #eyes-js { animation: look-eyes 4.8s ease-in-out infinite; }`,
  },
  {
    file: "whale-mini-idle.svg", title: "迷你 · 待机", state: "mini-idle",
    front: bubble(8.7, 3.3, 0.28, "bubble bubble-a"),
    css: `.state-mini-idle { animation: body-float 3.8s ease-in-out infinite; }\n      .state-mini-idle .tail-motion { animation-duration: 1.7s; }`,
  },
  {
    file: "whale-mini-enter.svg", title: "迷你 · 入场", state: "mini-enter",
    front: `${bubble(8, 4, 0.28, "bubble bubble-a")}${spark(16, 4, "spark spark-b", palette.gold)}`,
    css: `.state-mini-enter { animation: mini-enter 0.9s cubic-bezier(.2,.85,.25,1) 1 both; }\n      .state-mini-enter .tail-motion { animation: tail-sway 0.9s ease-out 1 both; }`,
  },
  {
    file: "whale-mini-enter-sleep.svg", title: "迷你 · 入睡", state: "mini-enter-sleep", eyeMode: "closed",
    css: `.state-mini-enter-sleep { animation: collapse 1.1s ease-in-out 1 both; }\n      .state-mini-enter-sleep .eyes-blink { animation: blink-once 1.1s ease-in-out 1 both; }`,
  },
  {
    file: "whale-mini-crabwalk.svg", title: "迷你 · 巡游", state: "mini-crabwalk",
    front: bubbles([[-1, 8, 0.24, "bubble bubble-a"], [-2, 10, 0.18, "bubble bubble-b"]]),
    css: `.state-mini-crabwalk { animation: roam 1.1s ease-in-out infinite; }\n      .state-mini-crabwalk .tail-motion { animation-duration: 0.56s; }`,
  },
  {
    file: "whale-mini-peek.svg", title: "迷你 · 探头", state: "mini-peek",
    css: `.state-mini-peek { animation: mini-peek 1.2s cubic-bezier(.3,.8,.2,1) infinite; }\n      .state-mini-peek .tail-motion { animation-duration: 1.6s; }`,
  },
  {
    file: "whale-mini-alert.svg", title: "迷你 · 提醒", state: "mini-alert",
    front: `<g class="attention-mark"><path d="M18 2.5L19 4.2L18.35 4.2L18.35 5.2L17.65 5.2L17.65 4.2L17 4.2Z" fill="${palette.gold}"/><rect x="17.7" y="5.6" width="0.6" height="0.55" rx="0.2" fill="${palette.gold}"/>${spark(15.7, 3.6, "spark spark-a", palette.bubble)}</g>`,
    css: `.state-mini-alert { animation: alert-pop 0.95s ease-in-out infinite; }\n      .attention-mark { animation: bubble-pop 0.95s ease-in-out infinite; transform-box: fill-box; transform-origin: center bottom; }`,
  },
  {
    file: "whale-mini-happy.svg", title: "迷你 · 开心", state: "mini-happy",
    front: `${spark(4, 3.5, "spark spark-a", palette.gold)}${spark(17, 4, "spark spark-b", palette.mint)}${bubble(9, 2, 0.33, "bubble bubble-c")}`,
    css: `.state-mini-happy { animation: body-bounce 0.95s ease-in-out infinite; }\n      .state-mini-happy .tail-motion { animation-duration: 0.55s; }`,
  },
  {
    file: "whale-mini-sleep.svg", title: "迷你 · 睡觉", state: "mini-sleep", eyeMode: "closed",
    front: `<path class="sleep-z z-one" d="M16 4H18.2L16.55 5.7H18.2V6.15H15.9L17.55 4.45H16Z" fill="${palette.bubble}"/>`,
    css: `.state-mini-sleep { animation: doze-body 4s ease-in-out infinite; }\n      .state-mini-sleep .eyes-blink { animation: none; }\n      .state-mini-sleep .sleep-z { animation: pulse 2.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }`,
  },
  {
    file: "whale-mini-working.svg", title: "迷你 · 工作", state: "mini-working",
    front: `<g class="work-pad"><rect x="11.6" y="12.3" width="5.8" height="2.55" rx="0.35" fill="${palette.ink}"/><rect x="12.05" y="12.65" width="4.9" height="0.9" rx="0.18" fill="${palette.bubble}"/><path d="M12.2 14H12.8M13.2 14H13.8M14.2 14H14.8M15.2 14H15.8" stroke="${palette.belly}" stroke-width="0.24" stroke-linecap="round"/></g>`,
    css: `.state-mini-working { animation: body-float 2.4s ease-in-out infinite; }\n      .state-mini-working .pectoral-fin { animation: tap-fin 0.52s ease-in-out infinite; }\n      .work-pad { animation: pulse 1.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }`,
  },
  {
    file: "whale-react-drag.svg", title: "交互 · 拖拽", state: "react-drag",
    back: `${bubble(-1.6, 6.6, 0.35, "bubble bubble-a")}${bubble(-2.7, 8.5, 0.22, "bubble bubble-b")}`,
    css: `.state-react-drag { animation: drag-stretch 0.8s ease-in-out infinite; }\n      .state-react-drag .tail-motion { animation-duration: 0.42s; }`,
  },
  {
    file: "whale-react-left.svg", title: "交互 · 左侧轻点", state: "react-left",
    css: `.state-react-left { animation: spin-wobble 0.72s ease-in-out 1 both; }\n      .state-react-left .pectoral-fin { animation: fin-wave 0.36s ease-in-out 3; }`,
  },
  {
    file: "whale-react-right.svg", title: "交互 · 右侧轻点", state: "react-right",
    css: `.state-react-right { animation: spin-wobble 0.72s ease-in-out 1 reverse both; }\n      .state-react-right .pectoral-fin { animation: fin-wave 0.36s ease-in-out 3 reverse; }`,
  },
  {
    file: "whale-react-double.svg", title: "交互 · 双击", state: "react-double",
    front: `${spark(4, 3, "spark spark-a", palette.gold)}${spark(18, 3, "spark spark-b", palette.coral)}${bubble(10, 1.8, 0.44, "bubble bubble-c")}`,
    css: `.state-react-double { animation: double-hop 1.1s ease-in-out 2 both; }\n      .state-react-double .tail-motion { animation-duration: 0.45s; }`,
  },
  {
    file: "whale-react-annoyed.svg", title: "交互 · 有点不耐烦", state: "react-annoyed", eyeMode: "angry",
    front: `<path d="M12 7.45L13.45 7.9M14.25 7.9L15.6 7.45" stroke="${palette.ink}" stroke-width="0.42" stroke-linecap="round" class="annoyed-brow"/>${bubble(18.2, 4.4, 0.3, "bubble bubble-a", palette.coral)}`,
    css: `.state-react-annoyed { animation: spin-wobble 0.7s ease-in-out 2 both; }\n      .state-react-annoyed .tail-motion { animation-duration: 0.5s; }\n      .annoyed-brow { opacity: 1; }`,
  },
];

function renderSvg(asset) {
  const shadowId = asset.tracked ? ' id="shadow-js"' : "";
  const bodyId = asset.tracked ? ' id="body-js"' : "";
  const front = asset.front || "";
  const back = asset.back || "";
  let eyes = "";
  if (asset.eyeMode === "closed") {
    eyes = `.state-${asset.state} .eye-open,.state-${asset.state} .eye-shine { display: none; }\n      .state-${asset.state} .eye-closed { display: block; }\n      .state-${asset.state} .eyes-blink { animation: none; }`;
  } else if (asset.eyeMode === "angry") {
    eyes = `.state-${asset.state} .eye-shine { display: none; }`;
  }
  const css = [
    commonCss,
    asset.tracked ? "#body-js,#eyes-js,#shadow-js { transition: transform 0.2s ease-out; } #shadow-js { transform-origin: 7.5px 15px; }" : "",
    eyes,
    asset.css || "",
  ].filter(Boolean).join("\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
  const shadow = `<g${shadowId}><rect class="shadow-shape" x="-0.2" y="15.15" width="15.6" height="0.85" fill="${palette.ink}" opacity="0.34"/></g>`;
  const body = `<g${bodyId}><g class="body-motion state-${asset.state}">${back}${tailArt}${bodyArt}${front}</g></g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-15 -25 45 45" width="500" height="500" role="img" aria-label="${asset.title}">
  <title>${asset.title}</title>
  <defs><style>
${css}
  </style></defs>
  ${shadow}
  ${body}
</svg>
`;
}

for (const asset of stateAssets) {
  fs.writeFileSync(path.join(ASSETS, asset.file), renderSvg(asset), "utf8");
}

const theme = {
  schemaVersion: 1,
  name: "Blue Whale",
  author: "Clawd design prototype",
  version: "0.1.0",
  description: "Original pixel-art blue whale with CSS-animated SVGs for every desktop-pet state.",
  customization: { petTint: false },
  viewBox: { x: -15, y: -25, width: 45, height: 45 },
  layout: {
    contentBox: { x: -4, y: 4, width: 23, height: 13 },
    centerX: 7.5,
    baselineY: 17,
    visibleHeightRatio: 0.58,
    baselineBottomRatio: 0.05,
  },
  eyeTracking: {
    enabled: true,
    states: ["idle"],
    eyeRatioX: 0.65,
    eyeRatioY: 0.46,
    maxOffset: 1.2,
    bodyScale: 0.24,
    shadowStretch: 0.12,
    shadowShift: 0.2,
    ids: { eyes: "eyes-js", body: "body-js", shadow: "shadow-js" },
    shadowOrigin: "7.5px 15px",
  },
  states: {
    idle: ["whale-idle.svg"],
    roam: ["whale-roam.svg"],
    yawning: ["whale-yawning.svg"],
    dozing: ["whale-dozing.svg"],
    collapsing: ["whale-collapsing.svg"],
    thinking: ["whale-thinking.svg"],
    working: ["whale-typing.svg"],
    juggling: ["whale-juggling.svg"],
    sweeping: ["whale-sweeping.svg"],
    error: ["whale-error.svg"],
    attention: ["whale-attention.svg"],
    notification: ["whale-notification.svg"],
    carrying: ["whale-carrying.svg"],
    sleeping: ["whale-sleeping.svg"],
    waking: ["whale-waking.svg"],
    dizzy: ["whale-dizzy.svg"],
  },
  sleepSequence: { mode: "full" },
  workingTiers: [
    { minSessions: 3, file: "whale-building.svg" },
    { minSessions: 2, file: "whale-juggling.svg" },
    { minSessions: 1, file: "whale-typing.svg" },
  ],
  idleAnimations: [
    { file: "whale-idle-look.svg", duration: 6500 },
    { file: "whale-idle-bubbles.svg", duration: 9000 },
  ],
  timings: {
    minDisplay: { attention: 1800, error: 3000, notification: 1800, carrying: 1800, working: 900, thinking: 900 },
    autoReturn: { attention: 1800, error: 3600, notification: 1800, carrying: 2400, dizzy: 6000 },
    yawnDuration: 2800,
    collapseDuration: 1250,
    wakeDuration: 1650,
    deepSleepTimeout: 600000,
    mouseIdleTimeout: 20000,
    mouseSleepTimeout: 60000,
  },
  hitBoxes: {
    default: { x: -4, y: 4, w: 24, h: 13 },
    sleeping: { x: -4, y: 8, w: 26, h: 9 },
    wide: { x: -5, y: 2, w: 29, h: 15 },
  },
  wideHitboxFiles: ["whale-attention.svg", "whale-notification.svg", "whale-error.svg", "whale-carrying.svg", "whale-building.svg"],
  sleepingHitboxFiles: ["whale-yawning.svg", "whale-dozing.svg", "whale-collapsing.svg", "whale-sleeping.svg", "whale-waking.svg"],
  reactions: {
    drag: { file: "whale-react-drag.svg", duration: 900 },
    clickLeft: { file: "whale-react-left.svg", duration: 900 },
    clickRight: { file: "whale-react-right.svg", duration: 900 },
    double: { files: ["whale-react-double.svg"], duration: 2200 },
    annoyed: { file: "whale-react-annoyed.svg", duration: 1400 },
  },
  miniMode: {
    supported: true,
    offsetRatio: 0.486,
    states: {
      "mini-idle": ["whale-mini-idle.svg"],
      "mini-enter": ["whale-mini-enter.svg"],
      "mini-enter-sleep": ["whale-mini-enter-sleep.svg"],
      "mini-crabwalk": ["whale-mini-crabwalk.svg"],
      "mini-peek": ["whale-mini-peek.svg"],
      "mini-alert": ["whale-mini-alert.svg"],
      "mini-happy": ["whale-mini-happy.svg"],
      "mini-sleep": ["whale-mini-sleep.svg"],
      "mini-working": ["whale-mini-working.svg"],
    },
    timings: {
      minDisplay: { "mini-alert": 1800, "mini-happy": 2200 },
      autoReturn: { "mini-alert": 1800, "mini-happy": 2200 },
    },
  },
};

fs.writeFileSync(path.join(ROOT, "theme.json"), `${JSON.stringify(theme, null, 2)}\n`, "utf8");
console.log(`Generated ${stateAssets.length} SVG states in ${ASSETS}`);
