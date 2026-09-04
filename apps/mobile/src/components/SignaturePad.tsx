import { useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import type { Point, Stroke } from '../signature/raster';
import { hasInk } from '../signature/raster';

/**
 * The driver's signature pad — a whiteboard drawn on directly with a finger.
 *
 * ## Why this replaced the previous pad
 *
 * The old one was `react-native-signature-canvas`, which draws into an HTML canvas
 * inside a `react-native-webview`. That has two problems. On the web build there is
 * no WebView, so the pad the app is actually TESTED on was a different thing from the
 * pad that ships — the exact drift docs/WEB_PARITY.md exists to prevent. And on both
 * targets the drawing surface lived behind an iframe/WebView boundary, which is what
 * made finger input feel unreliable.
 *
 * This one has no such boundary: touches land on a plain `View`, the strokes are
 * ordinary state, and `signature/raster.ts` turns them into the PNG. One
 * implementation, both targets, and the bytes the server stores are produced by the
 * same code either way.
 *
 * ## Gesture ownership
 *
 * The pad sits inside a `ScrollView`, which also wants vertical drags. Three things
 * settle that in the pad's favour: it claims the responder on touch-down AND on move,
 * and it refuses to hand it back mid-stroke (`onPanResponderTerminationRequest`).
 * Without the last one a downward stroke — the ordinary shape of a signature — gets
 * stolen by the scroll view halfway through the letter.
 */
export function SignaturePad({
  onChange,
  height = 220,
}: {
  /** Fires on every change. The box is what `renderSignature` needs to fit the
   *  drawing onto the fixed-size output raster without distorting it. */
  onChange: (strokes: Stroke[], padBox: { width: number; height: number }) => void;
  height?: number;
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [width, setWidth] = useState(0);
  // Read inside the PanResponder's callbacks, which are created once and would
  // otherwise close over the first render's values forever.
  const size = useRef({ width: 0, height });
  const latest = useRef<Stroke[]>([]);

  const publish = useCallback(
    (next: Stroke[]) => {
      latest.current = next;
      setStrokes(next);
      onChange(next, size.current);
    },
    [onChange],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    size.current = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
    setWidth(e.nativeEvent.layout.width);
  }, []);

  /**
   * A point in the pad's own coordinate space.
   *
   * `locationX`/`locationY` rather than `pageX`/`pageY` minus a measured offset. Both
   * platforms compute these against the view holding the responder — which is this
   * pad, because the SVG and the placeholder over it are `pointerEvents="none"` — and
   * they are recomputed per event. A cached offset is not good enough: the pad lives
   * inside a `ScrollView`, and one measured before the screen scrolled puts every
   * stroke hundreds of pixels above the canvas, where it rasterises to a blank PNG.
   */
  const pointFrom = (e: GestureResponderEvent): Point => ({
    x: e.nativeEvent.locationX,
    y: e.nativeEvent.locationY,
  });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        // The scroll view asks for the gesture back the moment the finger moves
        // vertically. Refusing is what lets someone draw a descender.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,

        onPanResponderGrant: (e) => {
          latest.current = [...latest.current, [pointFrom(e)]];
          setStrokes(latest.current);
        },
        onPanResponderMove: (e) => {
          const strokesNow = latest.current;
          const current = strokesNow[strokesNow.length - 1];
          if (!current) return;
          const point = pointFrom(e);
          const previous = current[current.length - 1];
          // Drop points the pen has barely moved to. A finger emits events far faster
          // than it travels, and every one of them is a segment the rasteriser has to
          // walk — this keeps a signature at a few hundred points rather than a few
          // thousand, with no visible difference.
          if (previous && Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) < 1.2) {
            return;
          }
          latest.current = [...strokesNow.slice(0, -1), [...current, point]];
          setStrokes(latest.current);
        },
        onPanResponderRelease: () => publish(latest.current),
        onPanResponderTerminate: () => publish(latest.current),
      }),
    [publish],
  );

  const clear = () => publish([]);
  const inked = hasInk(strokes);

  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={onLayout}
        style={[styles.pad, { height }, DRAW_SURFACE]}
        {...responder.panHandlers}
      >
        {width > 0 ? (
          <Svg width={width} height={height} pointerEvents="none">
            {/* The rule the signature sits on, drawn under the ink so the pad reads
                as somewhere to sign rather than as an empty grey box. */}
            <Line
              x1={16}
              y1={height - 44}
              x2={width - 16}
              y2={height - 44}
              stroke="rgba(127,127,127,0.45)"
              strokeWidth={1}
              strokeDasharray="5 5"
            />
            {strokes.map((stroke, i) => (
              <Path
                key={i}
                d={toPath(stroke)}
                stroke="#111"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
          </Svg>
        ) : null}

        {!inked ? (
          <View style={styles.placeholder} pointerEvents="none">
            <Text style={styles.placeholderText}>Sign here with your finger</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <Text style={styles.hint}>
          {inked ? 'Drawn on this device.' : 'Draw anywhere in the box above.'}
        </Text>
        <Pressable onPress={clear} hitSlop={10} disabled={strokes.length === 0}>
          <Text style={[styles.clear, strokes.length === 0 && { opacity: 0.4 }]}>Clear</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** An SVG path for one stroke. A single point becomes a zero-length line, which with
 *  a round cap is the dot the person actually drew. */
function toPath(stroke: Stroke): string {
  if (stroke.length === 0) return '';
  const [first, ...rest] = stroke;
  const head = `M ${first!.x.toFixed(2)} ${first!.y.toFixed(2)}`;
  if (rest.length === 0) return `${head} L ${first!.x.toFixed(2)} ${first!.y.toFixed(2)}`;
  return head + rest.map((p) => ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('');
}

/**
 * `touchAction: 'none'` tells a mobile browser that this element handles its own
 * touch gestures, so a downward stroke draws instead of scrolling the page.
 *
 * It is a react-native-web style property with no React Native counterpart, hence the
 * cast — the native side simply ignores a style key its view config does not know.
 * It is not optional on web: react-native-web registers its touch listeners as
 * passive, so it CANNOT call `preventDefault()` to stop the scroll itself.
 */
const DRAW_SURFACE = { touchAction: 'none' } as unknown as ViewStyle;

const styles = StyleSheet.create({
  pad: {
    borderWidth: 1,
    borderColor: 'rgba(127,127,127,0.4)',
    borderRadius: 10,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: { color: '#9aa0a6', fontSize: 15 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hint: { fontSize: 12, opacity: 0.6 },
  clear: { color: '#c0392b', fontWeight: '700', fontSize: 14 },
});
