import React from "react";
import {
  AbsoluteFill,
  Img,
  staticFile,
  interpolate,
  Easing,
  useCurrentFrame,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/DMSans";
import { TopVolumeProps } from "./schema";

const { fontFamily } = loadFont("normal", {
  weights: ["500", "700"],
  subsets: ["latin"],
});

// ---- Layout measured from the source video (1122 x 1122) ----
const COLS = [330, 562, 795]; // card centre X per column
const ROWS = [301, 558, 815]; // card centre Y per row
const CARD = 191; // card side length
const RADIUS = 16;

// Official Stargaze lockup (public/logo.svg, native 501x73). Sized to sit in the
// same spot/footprint as the source video and centred horizontally.
const LOGO_AR = 501 / 73;
const LOGO_W = 560;
const LOGO_H = Math.round(LOGO_W / LOGO_AR); // ~82
const LOGO = { width: LOGO_W, height: LOGO_H, left: Math.round(561 - LOGO_W / 2), top: Math.round(101 - LOGO_H / 2) };
const PINK = "#f50079";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// Per-card entrance, indexed by grid position (reading order 0..8):
// [dx, dy, rotationDeg] — the offset/angle the card starts at before flying to
// its slot. Deliberately mixed directions AND angles (edges + corners), never
// all from the top.
const ENTRY: [number, number, number][] = [
  [-340, -60, -20], // 0 TL  <- from left, tilted
  [80, -360, 14], //   1 TM  <- from top
  [360, -50, 22], //   2 TR  <- from right
  [-300, 240, -24], // 3 ML  <- from bottom-left corner
  [20, 380, 12], //    4 MM  <- from below
  [330, -260, -18], // 5 MR  <- from top-right corner
  [-360, 90, 26], //   6 BL  <- from left
  [-60, 360, -14], //  7 BM  <- from below
  [330, 280, 20], //   8 BR  <- from bottom-right corner
];

// Fast-in, decelerate-to-a-dead-stop. Monotonic ease-out = NO bounce / overshoot.
// SMOOTH version (cubic) — used by the logo and the title/date.
const arrive = (local: number, dur: number) =>
  interpolate(local, [0, dur], [0, 1], { easing: Easing.out(Easing.cubic), ...clamp });

// HARD version (circle) — snappier in, more abrupt stop. Used by the cards for a
// punchier stomp.
const stomp = (local: number, dur: number) =>
  interpolate(local, [0, dur], [0, 1], { easing: Easing.out(Easing.circle), ...clamp });

// Twitter/X uses the FIRST frame as the social-card preview, so the video opens
// on POSTER frames of the fully-built final state, THEN plays the animation.
// During the poster every element is forced to its settled state by returning a
// frame far past the end (FINAL); after it, the animation runs from 0.
const POSTER = 6; // ~0.2s at 30fps
const FINAL = 100000;
const useAnimFrame = () => {
  const f = useCurrentFrame();
  return f < POSTER ? FINAL : f - POSTER;
};

// Stop-motion cadence applies to the CARDS ONLY: they update every CARD_STEP
// frames and hold, giving the choppy stomp. Bigger = choppier/stompier.
// The logo and title/date are intentionally left SMOOTH (real 30fps frame).
const CARD_STEP = 4;
const useSteppedAnimFrame = (step: number) => {
  const f = useAnimFrame();
  return Math.floor(f / step) * step;
};

// ------------------------------------------------------------------
// Logo: glitchy horizontal blur reveal — SMOOTH (not stepped)
// ------------------------------------------------------------------
const Logo: React.FC = () => {
  const frame = useAnimFrame();

  const a = arrive(frame, 9); // smooth no-bounce settle
  const tx = interpolate(a, [0, 1], [-46, 0]);
  const blur = interpolate(frame, [0, 9], [22, 0], clamp);
  const opacity = frame >= 0 ? 1 : 0; // snap on (no soft fade — stop-motion)
  // brief horizontal stretch that resolves — reads as a motion-blur "snap" into place
  const sx = interpolate(frame, [0, 3, 9], [1.1, 1.03, 1], clamp);

  return (
    <div
      style={{
        position: "absolute",
        left: LOGO.left,
        top: LOGO.top,
        width: LOGO.width,
        height: LOGO.height,
        opacity,
        transform: `translateX(${tx}px) scaleX(${sx})`,
        filter: `blur(${blur}px)`,
      }}
    >
      <Img src={staticFile("logo.svg")} style={{ width: LOGO.width, height: LOGO.height }} />
    </div>
  );
};

// ------------------------------------------------------------------
// A single ranked card: flies in from its side, scales + settles,
// then its label fades in just after it lands.
// ------------------------------------------------------------------
const Card: React.FC<{ name: string; image: string; index: number }> = ({ name, image, index }) => {
  const frame = useSteppedAnimFrame(CARD_STEP); // choppy stop-motion — cards only

  const col = index % 3;
  const row = Math.floor(index / 3);
  const cx = COLS[col];
  const cy = ROWS[row];

  const start = 6 + index * 4; // staggered cascade in reading order
  const local = frame - start;

  // Fly in from this card's own direction + angle and slam to a dead stop.
  // Short, hard ease + the choppy step = a punchy stomp (no bounce).
  const [dx, dy, rot] = ENTRY[index];
  const a = stomp(local, 12);
  const tx = interpolate(a, [0, 1], [dx, 0]);
  const ty = interpolate(a, [0, 1], [dy, 0]);
  // entrance tilt resolves to exactly 0° — once landed the card holds dead-static
  const rotation = interpolate(a, [0, 1], [rot, 0]);
  const scale = interpolate(a, [0, 1], [0.9, 1]); // subtle, monotonic — not a bounce
  const opacity = local >= 0 ? 1 : 0; // snap visible (stop-motion, no fade)
  const labelOpacity = local >= 12 ? 1 : 0; // label stamps in once the card lands

  return (
    <div
      style={{
        position: "absolute",
        left: cx - CARD / 2,
        top: cy - CARD / 2,
        width: CARD,
        opacity,
        transform: `translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${scale})`,
      }}
    >
      <div
        style={{
          width: CARD,
          height: CARD,
          borderRadius: RADIUS,
          overflow: "hidden",
          background: "#1a0a14",
          boxShadow: "0 8px 22px rgba(0,0,0,0.38)",
        }}
      >
        <Img src={staticFile(image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div
        style={{
          opacity: labelOpacity,
          marginTop: 9,
          width: CARD,
          textAlign: "center",
          color: "#ffffff",
          fontFamily,
          fontWeight: 500,
          fontSize: 19,
          letterSpacing: 0.2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {name}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------
// Bottom-right title + date, revealed last with a slide-up.
// ------------------------------------------------------------------
const TitleBlock: React.FC<{ title: string; date: TopVolumeProps["date"] }> = ({ title, date }) => {
  const frame = useAnimFrame(); // SMOOTH (not stepped)

  const titleStart = 51; // after the stompy cards have settled
  const dateStart = 58;

  // smooth slide-up + soft fade, no bounce
  const titleY = interpolate(arrive(frame - titleStart, 14), [0, 1], [22, 0]);
  const titleOp = interpolate(frame, [titleStart, titleStart + 10], [0, 1], clamp);

  const dateY = interpolate(arrive(frame - dateStart, 14), [0, 1], [18, 0]);
  const dateOp = interpolate(frame, [dateStart, dateStart + 10], [0, 1], clamp);

  return (
    <div style={{ position: "absolute", right: 231, bottom: 44, textAlign: "right" }}>
      <div
        style={{
          opacity: titleOp,
          transform: `translateY(${titleY}px)`,
          color: PINK,
          fontFamily,
          fontWeight: 700,
          fontSize: 34,
          letterSpacing: 1.5,
          lineHeight: 1,
        }}
      >
        {title}
      </div>
      <div
        style={{
          opacity: dateOp,
          transform: `translateY(${dateY}px)`,
          marginTop: 9,
          color: "#f3eef0",
          fontFamily,
          fontWeight: 500,
          fontSize: 22,
          lineHeight: 1,
        }}
      >
        {date.month} {date.day}
        <sup style={{ fontSize: 13, verticalAlign: "super" }}>{date.ordinal}</sup>, {date.year}
      </div>
    </div>
  );
};

export const TopVolume: React.FC<TopVolumeProps> = ({ title, date, cards }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0d0309" }}>
      <Img src={staticFile("bg.png")} style={{ width: "100%", height: "100%" }} />
      <Logo />
      {cards.map((c, i) => (
        <Card key={i} name={c.name} image={c.image} index={i} />
      ))}
      <TitleBlock title={title} date={date} />
    </AbsoluteFill>
  );
};
