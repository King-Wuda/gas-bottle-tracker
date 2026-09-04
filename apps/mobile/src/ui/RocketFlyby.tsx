import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GeaLogo } from './GeaLogo';
import { colors } from './theme';

/**
 * The celebration that plays when a scan session is finished: a squadron of GEA
 * rockets crossing the screen.
 *
 * ## Why it is a component and not an effect somewhere
 *
 * It owns its own timing. The caller says "go" and gets one callback when the last
 * rocket has left the screen, which is what lets `ScanStep` treat it as a step in the
 * flow — the navigation happens on `onDone`, so the animation is never cut in half by
 * the next screen mounting over it.
 *
 * ## Why it never blocks anything
 *
 * `pointerEvents="none"` on the overlay: the rockets are decoration over a live
 * screen, and a stores manager who wants to get on with the job must be able to tap
 * straight through them. If the animation is interrupted — the screen unmounts, the
 * app backgrounds — the cleanup below still fires `onDone` exactly once, so a flow
 * can never be stranded waiting for a rocket.
 */
const ROCKETS = 5;
const FLIGHT_MS = 1150;
/** Each rocket leaves a little after the one before, so it reads as a squadron
 *  rather than as one object that got wider. */
const STAGGER_MS = 105;
const TOTAL_MS = FLIGHT_MS + STAGGER_MS * (ROCKETS - 1);

export function RocketFlyby({ playing, onDone }: { playing: boolean; onDone?: () => void }) {
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  // Held in a ref so the animation's completion callback always sees the current
  // handler without the effect having to restart (and so replay the flyby) whenever
  // the caller passes a new closure.
  const done = useRef(onDone);
  done.current = onDone;

  // The lanes the rockets fly down, and how each one is dressed. Recomputed only when
  // the viewport changes, so a re-render mid-flight does not reshuffle them.
  const lanes = useMemo(
    () =>
      Array.from({ length: ROCKETS }, (_, i) => ({
        // Spread across the middle 70% of the screen, avoiding the header and the
        // primary button at the foot.
        top: height * (0.18 + (0.62 * i) / (ROCKETS - 1)),
        // Alternating tilt, so they do not look like one sprite copied five times.
        tilt: i % 2 === 0 ? '-8deg' : '6deg',
        scale: 0.8 + ((i * 37) % 5) / 10,
        delay: i * STAGGER_MS,
      })),
    [height],
  );

  useEffect(() => {
    if (!playing) return;
    progress.setValue(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done.current?.();
    };
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: TOTAL_MS,
      easing: Easing.linear,
      // Transform and opacity only, so this is a pure GPU animation on the device.
      // react-native-web has no native driver and quietly runs it on the JS thread —
      // identical output, and five views for a second is nothing in a browser.
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) finish();
    });
    return () => {
      animation.stop();
      // Leaving early still completes the caller's flow: an unmount must not be able
      // to strand a submission behind an animation that will never end.
      finish();
    };
  }, [playing, progress]);

  if (!playing) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {lanes.map((lane, i) => {
        // Each rocket occupies its own slice of the shared 0..1 clock. Interpolating
        // one driver rather than running five keeps them exactly in step.
        const start = lane.delay / TOTAL_MS;
        const end = (lane.delay + FLIGHT_MS) / TOTAL_MS;
        const translateX = progress.interpolate({
          inputRange: [0, start, end, 1],
          outputRange: [-260, -260, width + 260, width + 260],
        });
        const opacity = progress.interpolate({
          inputRange: [0, start, Math.min(start + 0.04, end), end, 1],
          outputRange: [0, 0, 1, 1, 1],
        });
        return (
          <Animated.View
            key={i}
            style={[
              styles.rocket,
              { top: lane.top, opacity, transform: [{ translateX }, { scale: lane.scale }] },
            ]}
          >
            <View style={[styles.craft, { transform: [{ rotate: lane.tilt }] }]}>
              <View style={styles.trail} />
              <View style={styles.flame} />
              <View style={styles.finTop} />
              <View style={styles.finBottom} />
              <View style={styles.body}>
                <GeaLogo width={54} />
              </View>
              <View style={styles.nose} />
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
}

const BODY_H = 46;
const NOSE_W = 30;
const TRAIL_W = 150;
const FLAME_W = 26;
/** Where the body starts inside the craft row — the fins are absolutely positioned,
 *  so they have to be told where the thing they belong to actually is. */
const BODY_X = TRAIL_W + FLAME_W;
const GEA_BLUE = colors.brand;

const styles = StyleSheet.create({
  rocket: { position: 'absolute', left: 0 },
  craft: { flexDirection: 'row', alignItems: 'center', height: BODY_H },
  body: {
    height: BODY_H,
    width: 92,
    backgroundColor: '#fff',
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
    borderWidth: 2,
    borderColor: GEA_BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A right-pointing triangle, built from borders — react-native has no polygon and
  // this is the one construction that renders identically on both targets.
  nose: {
    width: 0,
    height: 0,
    borderTopWidth: BODY_H / 2,
    borderBottomWidth: BODY_H / 2,
    borderLeftWidth: NOSE_W,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: GEA_BLUE,
  },
  finTop: {
    position: 'absolute',
    left: BODY_X + 2,
    top: -9,
    width: 0,
    height: 0,
    borderLeftWidth: 22,
    borderBottomWidth: 14,
    borderLeftColor: 'transparent',
    borderBottomColor: GEA_BLUE,
  },
  finBottom: {
    position: 'absolute',
    left: BODY_X + 2,
    bottom: -9,
    width: 0,
    height: 0,
    borderLeftWidth: 22,
    borderTopWidth: 14,
    borderLeftColor: 'transparent',
    borderTopColor: GEA_BLUE,
  },
  flame: {
    width: FLAME_W,
    height: 18,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
    backgroundColor: colors.flame,
  },
  trail: {
    width: TRAIL_W,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,143,31,0.35)',
  },
});
