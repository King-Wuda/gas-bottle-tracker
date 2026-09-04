import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { colors } from './theme';

/**
 * The app's icons, drawn as paths.
 *
 * No icon font and no icon package. `react-native-svg` is already here for the
 * signature pad, so these cost nothing to add and render identically in the browser
 * and on the device — where an icon font would be one more asset to load and one more
 * thing to be missing on the surface this app is tested on. Emoji were the other
 * option and were rejected: they are somebody else's artwork, they change shape per
 * platform, and a yard app should not look like a chat.
 *
 * Every icon is drawn on a 24x24 grid with a 1.8 stroke, so they sit together at any
 * size without one looking heavier than its neighbours.
 */
export interface IconProps {
  size?: number;
  color?: string;
}

const S = 24;
const STROKE = 1.8;

/** A gas cylinder: the object this whole system is about. */
export function CylinderIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M10 2.75h4M12 2.75v2.5M8.5 8.2A3.5 3.5 0 0 1 12 5.25a3.5 3.5 0 0 1 3.5 2.95v11.3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V8.2Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M8.5 10.5h7" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** New batch: a cylinder with a plus. */
export function NewBatchIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M9.5 3.25h3M11 3.25v2M8 7.9A3 3 0 0 1 11 5.25a3 3 0 0 1 3 2.65v10.6a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V7.9Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M18 13.5v5M15.5 16h5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Transfer: something moving from here to there. */
export function TransferIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M3.5 8.5h13m-3.5-3.5 3.5 3.5-3.5 3.5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20.5 15.5h-13m3.5-3.5-3.5 3.5 3.5 3.5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Returns: coming back in, to a depot. */
export function ReturnIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M20.25 6.5H10a4.75 4.75 0 0 0 0 9.5h4"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="m13.5 3.25-3.25 3.25 3.25 3.25"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Rect x="14.75" y="13.25" width="6" height="6" rx="1.4" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** History: a clock with a hand, plus the arc of going back. */
export function HistoryIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M3.6 9.4A8.75 8.75 0 1 1 3.25 12"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M3.25 4.5v4.9h4.9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M12 7.75V12l2.75 1.75" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Admin: sliders, not a gear — this console is about setting things, not repairing. */
export function AdminIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Circle cx="15" cy="7.5" r="2.4" stroke={color} strokeWidth={STROKE} />
      <Circle cx="9" cy="16.5" r="2.4" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** The scan target: a QR reticle. */
export function ScanIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M3.5 8.5v-3a2 2 0 0 1 2-2h3M15.5 3.5h3a2 2 0 0 1 2 2v3M20.5 15.5v3a2 2 0 0 1-2 2h-3M8.5 20.5h-3a2 2 0 0 1-2-2v-3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M3.5 12h17" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Queued work waiting for signal. */
export function SyncIcon({ size = 24, color = colors.ink }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path
        d="M17.7 3.2v3.2h-3.2M6.3 20.8v-3.2h3.2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A tick, for the states where something is genuinely finished. */
export function CheckIcon({ size = 24, color = colors.success }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="m4.5 12.5 5 5 10-11"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The chevron used on anything that opens. */
export function ChevronIcon({ size = 24, color = colors.inkFaint }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${S} ${S}`} fill="none">
      <Path
        d="m9.5 5.5 7 6.5-7 6.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
