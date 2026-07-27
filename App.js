import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Rect, Stop, Text as SvgText } from "react-native-svg";
import { Worklets } from "react-native-worklets-core";
import { Camera, useCameraDevices, useCameraPermission, useFrameProcessor } from "react-native-vision-camera";
import { runAtTargetFps } from "react-native-vision-camera";

const C = {
  arena: "#0A121C",
  slate: "#121F2C",
  slate2: "#182838",
  ice: "#E9F2F6",
  steel: "#7E93A6",
  line: "#223243",
  amber: "#E2A63B",
  cyan: "#4FB6C7",
  green: "#4CAE7C",
  crimson: "#D1495B",
};

const K_TOTALS = "netsniper:totals";
const K_LATEST = "netsniper:latest";
const K_SESSIONS = "netsniper:sessions";
const REF_WIDTH = 380;
// Detection tuning: grid density scales with the net box's actual pixel size,
// so a small or distant puck still gets sampled finely instead of falling
// between coarse cells.
const SAMPLE_SPACING_PX = 5; // aim for one sample roughly every 5px of net box
const MIN_GRID = 14;
const MAX_GRID_COLS = 64;
const MAX_GRID_ROWS = 48;
// Motion threshold is adaptive (based on this frame's measured sensor noise)
// instead of a fixed brightness delta, so it stays sensitive in varied lighting
// without tripping on tiny sensor jitter.
const MOTION_DIFF_MIN = 22;
const MOTION_DIFF_NOISE_MULT = 3.2;
// Absolute minimum changed cells (not a % of the whole box) so a puck that's
// only a handful of pixels wide (i.e. far away) can still register, while a
// single stray cell (jitter) does not.
const MIN_CHANGED_SAMPLES = 3;
// Guards against false positives: ignore changes that cover most of the box
// (lighting flicker, camera shake, a hand entering frame) or that are spread
// out rather than compact like a real puck.
const MAX_CHANGED_RATIO = 0.55;
const CLUSTER_MAX_SPAN_RATIO = 0.65;
// Shot lifecycle: a "shot" is a whole motion event, not a single frame. We
// require a couple consecutive motion frames to confirm it's really starting
// (filters single-frame jitter), track it continuously while motion
// continues (a bounce/wobble after impact still belongs to the SAME shot),
// and only finalize + count it once motion has been quiet for a few frames.
// A cooldown after finalizing then blocks the net's own post-impact ripple
// from being read as a brand new shot.
const MOTION_ONSET_FRAMES = 2;
const MOTION_END_QUIET_FRAMES = 4;
const SHOT_COOLDOWN_MS = 900;

function pct(on, total) {
  return total ? Math.round((on / total) * 100) : 0;
}

function fmtMMSS(sec) {
  const safe = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function targetSizeLabel(v) {
  if (v <= 13) return "Tiny";
  if (v <= 24) return "Small";
  if (v <= 42) return "Medium";
  return "Large";
}

export default function App() {
  const [screen, setScreen] = useState("menu");
  const [totals, setTotals] = useState({ totalShots: 0, onTarget: 0, missed: 0 });
  const [latest, setLatest] = useState(null);
  const [sessionsLog, setSessionsLog] = useState([]);

  const [facing, setFacing] = useState("back");
  const [netBox, setNetBox] = useState(null);
  const [setupStage, setSetupStage] = useState("netcorner1");
  const [targets, setTargets] = useState([]);
  const [targetRadius, setTargetRadius] = useState(34);
  const [layout, setLayout] = useState({ w: 1, h: 1 });

  const [current, setCurrent] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [autoDetectOn, setAutoDetectOn] = useState(false);
  const [summaryRec, setSummaryRec] = useState(null);
  const [flash, setFlash] = useState(null);
  const [autoStatusText, setAutoStatusText] = useState("Manual Mode");
  const [freshDevices, setFreshDevices] = useState([]);

  const timerRef = useRef(null);
  const pauseStartRef = useRef(0);

  const { hasPermission, requestPermission } = useCameraPermission();
  const hookDevices = useCameraDevices();
  const devices = freshDevices.length ? freshDevices : hookDevices;
  const device = useMemo(() => {
    const preferred = devices.find((d) => d.position === facing);
    return preferred || devices.find((d) => d.position === "back") || devices.find((d) => d.position === "front") || devices[0];
  }, [devices, facing]);
  const format = useMemo(() => {
    if (!device?.formats?.length) return undefined;
    const smallFormats = device.formats.filter((f) => f.videoWidth <= 1280 && f.videoHeight <= 720);
    const pool = smallFormats.length ? smallFormats : device.formats;
    return pool.reduce((best, f) => {
      if (!best) return f;
      const fMax = f.maxFps ?? 0;
      const bestMax = best.maxFps ?? 0;
      if (fMax > bestMax) return f;
      if (fMax === bestMax && f.videoWidth * f.videoHeight < best.videoWidth * best.videoHeight) return f;
      return best;
    }, undefined);
  }, [device]);
  const maxFps = format?.maxFps ? Math.round(format.maxFps) : null;

  const onFrameShot = useMemo(() => Worklets.createRunOnJS((hit) => {
    setCurrent((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        totalShots: cur.totalShots + 1,
        onTarget: cur.onTarget + (hit ? 1 : 0),
        missed: cur.missed + (hit ? 0 : 1),
      };
    });
    setFlash({ hit, at: Date.now() });
    setTimeout(() => setFlash(null), 350);
    setAutoStatusText(hit ? "Target hit" : "Shot missed");
    setTimeout(() => {
      setAutoStatusText(autoDetectOn ? "Watching" : "Manual Mode");
    }, 650);
  }), [autoDetectOn]);

  const frameProcessor = useFrameProcessor((frame) => {
    "worklet";
    // Process at the highest fps this device/format can actually deliver,
    // instead of an artificial fixed cap - this is the main lever for catching
    // small, fast-moving pucks: more samples per second means the puck can't
    // "skip over" the net box between processed frames.
    const targetFps = maxFps || 30;
    runAtTargetFps(targetFps, () => {
      "worklet";
      if (!autoDetectOn || isPaused || !netBox || netBox.x2 === undefined || targets.length === 0) {
        global.__netSniperPrevSamples = undefined;
        global.__netSniperPrevCols = undefined;
        global.__netSniperPrevRows = undefined;
        global.__netSniperPrevCentroid = undefined;
        global.__netSniperState = "idle";
        global.__netSniperOnsetCount = 0;
        global.__netSniperQuietCount = 0;
        global.__netSniperActiveHit = false;
        global.__netSniperCooldownUntil = 0;
        return;
      }
      if (frame.pixelFormat !== "yuv") return;

      const now = Date.now();
      const state = global.__netSniperState || "idle";
      // Cooldown only blocks starting a brand NEW shot after one just
      // finalized (so net ripple / bounce right after impact isn't read as a
      // separate shot). It never blocks an already-active shot from being
      // tracked to completion.
      if (state === "idle" && global.__netSniperCooldownUntil && now < global.__netSniperCooldownUntil) return;

      const buffer = frame.toArrayBuffer();
      const data = new Uint8Array(buffer);
      const fw = frame.width;
      const fh = frame.height;
      const bpr = frame.bytesPerRow;

      const x1 = Math.max(0, Math.min(1, netBox.x1));
      const y1 = Math.max(0, Math.min(1, netBox.y1));
      const x2 = Math.max(0, Math.min(1, netBox.x2));
      const y2 = Math.max(0, Math.min(1, netBox.y2));
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);

      // Scale grid density to the net box's actual pixel footprint, so a small
      // or far-away puck (which only disturbs a few pixels) still lands on
      // enough sample cells to be seen, instead of a fixed coarse 20x14 grid.
      const boxWidthPx = Math.max(1, (right - left) * fw);
      const boxHeightPx = Math.max(1, (bottom - top) * fh);
      let cols = Math.round(boxWidthPx / SAMPLE_SPACING_PX);
      let rows = Math.round(boxHeightPx / SAMPLE_SPACING_PX);
      cols = Math.max(MIN_GRID, Math.min(MAX_GRID_COLS, cols));
      rows = Math.max(MIN_GRID, Math.min(MAX_GRID_ROWS, rows));
      const totalSamples = cols * rows;

      const samples = new Uint8Array(totalSamples);
      const prev = global.__netSniperPrevSamples;
      const gridMatches = prev && global.__netSniperPrevCols === cols && global.__netSniperPrevRows === rows;
      const diffs = gridMatches ? new Float32Array(totalSamples) : null;

      let sumDiff = 0;
      let diffCount = 0;

      for (let row = 0; row < rows; row += 1) {
        const yn = top + ((row + 0.5) / rows) * (bottom - top);
        const py = Math.max(0, Math.min(fh - 1, Math.floor(yn * fh)));
        for (let col = 0; col < cols; col += 1) {
          const xn = left + ((col + 0.5) / cols) * (right - left);
          const px = Math.max(0, Math.min(fw - 1, Math.floor(xn * fw)));
          const idx = py * bpr + px;
          const gray = data[idx] || 0;
          const sampleIndex = row * cols + col;
          samples[sampleIndex] = gray;
          if (gridMatches) {
            const diff = Math.abs(gray - prev[sampleIndex]);
            diffs[sampleIndex] = diff;
            sumDiff += diff;
            diffCount += 1;
          }
        }
      }

      global.__netSniperPrevSamples = samples;
      global.__netSniperPrevCols = cols;
      global.__netSniperPrevRows = rows;

      if (!gridMatches || diffCount === 0) {
        global.__netSniperPrevCentroid = undefined;
        return;
      }

      // Adaptive threshold: measure this frame's actual noise level instead of
      // assuming a fixed brightness delta, so sensitivity holds up across
      // different lighting and camera sensors.
      const avgDiff = sumDiff / diffCount;
      const threshold = Math.max(MOTION_DIFF_MIN, avgDiff * MOTION_DIFF_NOISE_MULT);

      let changed = 0;
      let sumX = 0;
      let sumY = 0;
      let minCol = cols;
      let maxCol = -1;
      let minRow = rows;
      let maxRow = -1;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const sampleIndex = row * cols + col;
          if (diffs[sampleIndex] > threshold) {
            changed += 1;
            const xn = left + ((col + 0.5) / cols) * (right - left);
            const yn = top + ((row + 0.5) / rows) * (bottom - top);
            sumX += xn;
            sumY += yn;
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
          }
        }
      }

      const changedRatio = changed / totalSamples;
      const spanCols = (maxCol - minCol + 1) / cols;
      const spanRows = (maxRow - minRow + 1) / rows;

      // "isMotion" folds in all the false-positive guards: needs an absolute
      // minimum of changed cells (so a distant/small puck still counts, unlike
      // the old 18%-of-box rule), but rejects whole-box changes (lighting,
      // camera shake, a hand entering frame) and changes spread too thin to be
      // a compact object.
      const isMotion =
        changed >= MIN_CHANGED_SAMPLES &&
        changedRatio <= MAX_CHANGED_RATIO &&
        !(spanCols > CLUSTER_MAX_SPAN_RATIO && spanRows > CLUSTER_MAX_SPAN_RATIO);

      const cx = sumX / changed;
      const cy = sumY / changed;
      const radiusNorm = (targetRadius / REF_WIDTH) * 1.35;

      const checkHit = (fromCentroid, toX, toY) => {
        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i];
          const dx = toX - t.x;
          const dy = toY - t.y;
          if (Math.sqrt(dx * dx + dy * dy) <= radiusNorm) return true;
          if (fromCentroid) {
            const segSteps = 4;
            for (let step = 1; step <= segSteps; step += 1) {
              const fx = fromCentroid.x + ((toX - fromCentroid.x) * step) / segSteps;
              const fy = fromCentroid.y + ((toY - fromCentroid.y) * step) / segSteps;
              const ddx = fx - t.x;
              const ddy = fy - t.y;
              if (Math.sqrt(ddx * ddx + ddy * ddy) <= radiusNorm) return true;
            }
          }
        }
        return false;
      };

      if (!isMotion) {
        global.__netSniperPrevCentroid = undefined;
        if (state === "active") {
          const quiet = (global.__netSniperQuietCount || 0) + 1;
          global.__netSniperQuietCount = quiet;
          if (quiet >= MOTION_END_QUIET_FRAMES) {
            // Motion has fully stopped - the shot is over. Finalize it exactly
            // once, whether or not it ever registered as a hit.
            const finalHit = !!global.__netSniperActiveHit;
            global.__netSniperState = "idle";
            global.__netSniperActiveHit = false;
            global.__netSniperQuietCount = 0;
            global.__netSniperOnsetCount = 0;
            global.__netSniperCooldownUntil = now + SHOT_COOLDOWN_MS;
            onFrameShot(finalHit);
          }
        } else {
          global.__netSniperOnsetCount = 0;
        }
        return;
      }

      // isMotion is true from here down.
      if (state === "idle") {
        const onset = (global.__netSniperOnsetCount || 0) + 1;
        global.__netSniperOnsetCount = onset;
        global.__netSniperPrevCentroid = { x: cx, y: cy };
        if (onset >= MOTION_ONSET_FRAMES) {
          // Confirmed as a real shot starting, not a single-frame flicker.
          global.__netSniperState = "active";
          global.__netSniperQuietCount = 0;
          global.__netSniperActiveHit = checkHit(undefined, cx, cy);
        }
        return;
      }

      // state === "active": keep tracking the same shot for as long as motion
      // continues (covers puck bounce/net wobble after impact) rather than
      // treating each frame as its own shot.
      const prevCentroid = global.__netSniperPrevCentroid;
      global.__netSniperQuietCount = 0;
      if (!global.__netSniperActiveHit && checkHit(prevCentroid, cx, cy)) {
        global.__netSniperActiveHit = true;
      }
      global.__netSniperPrevCentroid = { x: cx, y: cy };
    });
  }, [autoDetectOn, isPaused, netBox, targets, targetRadius, maxFps, onFrameShot]);

  useEffect(() => {
    if (!hasPermission) {
      setFreshDevices([]);
      return undefined;
    }

    let ticks = 0;
    const refreshDevices = () => {
      const available = Camera.getAvailableCameraDevices();
      setFreshDevices(available);
      ticks += 1;
      return available.length > 0 || ticks > 20;
    };

    if (refreshDevices()) return undefined;
    const id = setInterval(() => {
      if (refreshDevices()) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [hasPermission]);

  useEffect(() => {
    (async () => {
      try {
        const [t, l, s] = await Promise.all([
          AsyncStorage.getItem(K_TOTALS),
          AsyncStorage.getItem(K_LATEST),
          AsyncStorage.getItem(K_SESSIONS),
        ]);
        if (t) setTotals(JSON.parse(t));
        if (l) setLatest(JSON.parse(l));
        if (s) setSessionsLog(JSON.parse(s));
      } catch {
        // Bad saved data should not block opening the app.
      }
    })();
  }, []);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const radiusPx = useCallback((width) => (targetRadius / REF_WIDTH) * width, [targetRadius]);

  function resetSetup() {
    setNetBox(null);
    setTargets([]);
    setSetupStage("netcorner1");
    setTargetRadius(34);
  }

  function enterSetup() {
    resetSetup();
    setScreen("setup");
  }

  const onSetupTap = useCallback((evt) => {
    const { locationX, locationY } = evt.nativeEvent;
    const x = Math.max(0, Math.min(1, locationX / layout.w));
    const y = Math.max(0, Math.min(1, locationY / layout.h));

    if (setupStage === "netcorner1") {
      setNetBox({ x1: x, y1: y });
      setSetupStage("netcorner2");
    } else if (setupStage === "netcorner2") {
      setNetBox((nb) => ({ ...nb, x2: x, y2: y }));
      setSetupStage("targets");
    } else {
      setTargets((ts) => [...ts, { x, y }]);
    }
  }, [layout.h, layout.w, setupStage]);

  function undoSetup() {
    if (setupStage === "targets" && targets.length > 0) {
      setTargets((ts) => ts.slice(0, -1));
      return;
    }
    if (setupStage === "targets") {
      setNetBox((nb) => (nb ? { x1: nb.x1, y1: nb.y1 } : null));
      setSetupStage("netcorner2");
      return;
    }
    if (setupStage === "netcorner2") {
      setNetBox(null);
      setSetupStage("netcorner1");
    }
  }

  function beginSession() {
    const next = { totalShots: 0, onTarget: 0, missed: 0, startTime: Date.now(), pausedAccum: 0 };
    setCurrent(next);
    setElapsed(0);
    setIsPaused(false);
    setAutoDetectOn(false);
    setAutoStatusText("Manual Mode");
    setScreen("session");
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCurrent((cur) => {
        if (!cur) return cur;
        setElapsed((Date.now() - cur.startTime - cur.pausedAccum) / 1000);
        return cur;
      });
    }, 500);
  }

  function registerShot(hit) {
    if (isPaused || !current) return;
    setCurrent((cur) => ({
      ...cur,
      totalShots: cur.totalShots + 1,
      onTarget: cur.onTarget + (hit ? 1 : 0),
      missed: cur.missed + (hit ? 0 : 1),
    }));
    setFlash({ hit, at: Date.now() });
    setTimeout(() => setFlash(null), 350);
  }

  function pauseSession() {
    setIsPaused(true);
    setAutoStatusText("Paused");
    pauseStartRef.current = Date.now();
  }

  function resumeSession() {
    setCurrent((cur) => (cur ? { ...cur, pausedAccum: cur.pausedAccum + Date.now() - pauseStartRef.current } : cur));
    setIsPaused(false);
    setAutoStatusText(autoDetectOn ? "Watching" : "Manual Mode");
  }

  async function finishSession() {
    if (!current) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const duration = (Date.now() - current.startTime - current.pausedAccum) / 1000;
    const rec = {
      totalShots: current.totalShots,
      onTarget: current.onTarget,
      missed: current.missed,
      duration,
      targetsUsed: targets.length,
      date: Date.now(),
    };
    const newTotals = {
      totalShots: totals.totalShots + rec.totalShots,
      onTarget: totals.onTarget + rec.onTarget,
      missed: totals.missed + rec.missed,
    };
    const newLog = [...sessionsLog, rec].slice(-100);

    setTotals(newTotals);
    setLatest(rec);
    setSessionsLog(newLog);
    setCurrent(null);
    setSummaryRec(rec);
    await Promise.all([
      AsyncStorage.setItem(K_TOTALS, JSON.stringify(newTotals)),
      AsyncStorage.setItem(K_LATEST, JSON.stringify(rec)),
      AsyncStorage.setItem(K_SESSIONS, JSON.stringify(newLog)),
    ]);
    setScreen("summary");
  }

  function resetAllStats() {
    Alert.alert("Reset all stats?", "This clears all-time stats and session history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: async () => {
          setTotals({ totalShots: 0, onTarget: 0, missed: 0 });
          setLatest(null);
          setSessionsLog([]);
          await AsyncStorage.multiRemove([K_TOTALS, K_LATEST, K_SESSIONS]);
        },
      },
    ]);
  }

  if (screen === "menu") {
    return (
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Brand title="Net Sniper" />
          <Text style={s.subtitle}>Track your shooting accuracy, one puck at a time.</Text>

          <Card title="Latest Session">
            {!latest ? (
              <Text style={s.empty}>No sessions yet - take your first shot!</Text>
            ) : (
              <>
                <View style={s.statRow}>
                  <Stat n={latest.totalShots} l="Total Shots" c={C.amber} />
                  <Stat n={latest.onTarget} l="On Target" c={C.green} />
                  <Stat n={latest.missed} l="Missed" c={C.crimson} />
                </View>
                <Text style={s.metaLine}>Accuracy: {pct(latest.onTarget, latest.totalShots)}% / {fmtMMSS(latest.duration)}</Text>
              </>
            )}
          </Card>

          <Card title="All-Time Stats">
            <View style={s.statRow}>
              <Stat n={totals.totalShots} l="Total Shots" c={C.amber} />
              <Stat n={totals.onTarget} l="On Target" c={C.green} />
              <Stat n={totals.missed} l="Missed" c={C.crimson} />
            </View>
            <Text style={s.careerAccuracy}>{pct(totals.onTarget, totals.totalShots)}%</Text>
            <Text style={s.centerMeta}>Career Accuracy</Text>
          </Card>

          <Pressable style={s.btnPrimary} onPress={enterSetup}>
            <Text style={s.btnPrimaryText}>Start Shooting Session</Text>
          </Pressable>
          <Pressable style={s.btnSecondary} onPress={resetAllStats}>
            <Text style={s.btnSecondaryText}>Reset All Stats</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={[s.root, s.center]}>
        <ExpoStatusBar style="light" />
        <Text style={s.cameraIcon}>CAM</Text>
        <Text style={s.errorText}>Camera access is needed for setup and shooting sessions.</Text>
        <Pressable style={s.btnSecondary} onPress={requestPermission}>
          <Text style={s.btnSecondaryText}>Retry Camera</Text>
        </Pressable>
        <Pressable style={s.btnSecondary} onPress={() => setScreen("menu")}>
          <Text style={s.btnSecondaryText}>Back to Menu</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <SafeAreaView style={[s.root, s.center]}>
        <ExpoStatusBar style="light" />
        <Text style={s.cameraIcon}>CAM</Text>
        <Text style={s.errorText}>Camera access is granted. Looking for this phone's camera...</Text>
        <Pressable style={s.btnSecondary} onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))}>
          <Text style={s.btnSecondaryText}>Try Other Camera</Text>
        </Pressable>
        <Pressable style={s.btnSecondary} onPress={() => setScreen("menu")}>
          <Text style={s.btnSecondaryText}>Back to Menu</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (screen === "setup") {
    const hint =
      setupStage === "netcorner1"
        ? "Step 1: Tap the top-left corner of your net opening."
        : setupStage === "netcorner2"
          ? "Step 2: Tap the bottom-right corner of your net opening."
          : targets.length
            ? `${targets.length} target(s) placed. Tap to add more, or begin session.`
            : "Net area set. Tap inside it to place target zones.";
    const canBegin = setupStage === "targets" && targets.length > 0;

    return (
      <View style={s.cameraRoot}>
        <ExpoStatusBar style="light" />
        <Pressable
          style={s.cameraFill}
          onLayout={(e) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          onPress={onSetupTap}
        >
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            fps={maxFps || undefined}
            isActive={screen === "setup"}
          />
          <Svg style={StyleSheet.absoluteFill}>
            <NetAndTargets netBox={netBox} targets={targets} w={layout.w} h={layout.h} radius={radiusPx(layout.w)} showLabels />
          </Svg>

          <View style={s.topbar}>
            <IconBtn label="<" onPress={() => setScreen("menu")} />
            <Text style={s.topbarTitle}>Set Up Net & Targets</Text>
            <IconBtn label="Flip" onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} />
            <IconBtn label="X" onPress={resetSetup} />
          </View>

          <View style={s.angleReadout}>
            <Text style={s.anglePill}>Angle calibration: native setup ready</Text>
            <Text style={s.fpsPill}>{maxFps ? `Set ${maxFps} fps` : "FPS auto"}</Text>
          </View>

          <View style={s.bottomPanel} pointerEvents="box-none">
            <Text style={s.hint}>{hint}</Text>
            {setupStage === "targets" ? (
              <View style={s.sliderBox}>
                <View style={s.sliderHeader}>
                  <Text style={s.sliderLabel}>Target Size</Text>
                  <Text style={s.sliderValue}>{targetSizeLabel(targetRadius)}</Text>
                </View>
                <Slider
                  minimumValue={7}
                  maximumValue={60}
                  step={1}
                  value={targetRadius}
                  minimumTrackTintColor={C.amber}
                  maximumTrackTintColor={C.line}
                  thumbTintColor={C.amber}
                  onValueChange={setTargetRadius}
                />
              </View>
            ) : null}
            <View style={s.rowBtns}>
              <Pressable style={[s.btnSecondary, s.flexOne]} onPress={undoSetup}>
                <Text style={s.btnSecondaryText}>Undo</Text>
              </Pressable>
              <Pressable
                style={[s.btnPrimary, s.flexOne, !canBegin && s.disabled]}
                disabled={!canBegin}
                onPress={beginSession}
              >
                <Text style={s.btnPrimaryText}>Begin Session</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </View>
    );
  }

  if (screen === "session") {
    return (
      <View style={s.cameraRoot}>
        <ExpoStatusBar style="light" />
        <View
          style={s.cameraFill}
          onLayout={(e) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            fps={maxFps || undefined}
            isActive={screen === "session" && !isPaused}
            pixelFormat="yuv"
            frameProcessor={autoDetectOn ? frameProcessor : undefined}
          />
          <Svg style={StyleSheet.absoluteFill}>
            <NetAndTargets
              netBox={netBox}
              targets={targets}
              w={layout.w}
              h={layout.h}
              radius={radiusPx(layout.w)}
              flash={flash}
            />
          </Svg>

          <View style={s.hudTop}>
            <Text style={s.timerText}>{fmtMMSS(elapsed)}</Text>
            <Text style={[s.autoStatus, autoDetectOn ? s.autoOn : s.autoOff]}>
              {autoStatusText}
            </Text>
          </View>
          <View style={s.hudStats}>
            <Pill n={current?.totalShots ?? 0} l="Shots" c={C.ice} />
            <Pill n={current?.onTarget ?? 0} l="On Target" c={C.green} />
            <Pill n={current?.missed ?? 0} l="Missed" c={C.crimson} />
          </View>

          <View style={s.hudBottom}>
            <View style={s.toggleRow}>
              <Pressable
                style={s.toggleBtn}
                onPress={() => {
                  setAutoDetectOn((v) => {
                    const next = !v;
                    setAutoStatusText(next ? "Watching" : "Manual Mode");
                    return next;
                  });
                }}
              >
                <Text style={s.toggleText}>Auto-Detect: {autoDetectOn ? "ON" : "OFF"}</Text>
              </Pressable>
              <Pressable style={s.toggleBtn} onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))}>
                <Text style={s.toggleText}>Flip Camera</Text>
              </Pressable>
            </View>
            <View style={s.shotBtns}>
              <Pressable style={s.shotBtnOn} onPress={() => registerShot(true)}>
                <Text style={s.shotBtnText}>Manual: On Target</Text>
              </Pressable>
              <Pressable style={s.shotBtnMiss} onPress={() => registerShot(false)}>
                <Text style={s.shotBtnText}>Manual: Missed</Text>
              </Pressable>
            </View>
            <View style={s.rowBtns}>
              <Pressable style={s.pauseBtn} onPress={isPaused ? resumeSession : pauseSession}>
                <Text style={s.btnSecondaryText}>{isPaused ? "Resume" : "Pause"}</Text>
              </Pressable>
              <Pressable style={[s.btnSecondary, s.flexOne]} onPress={finishSession}>
                <Text style={s.btnSecondaryText}>Finish</Text>
              </Pressable>
            </View>
          </View>

          {isPaused ? (
            <View style={s.pausedBanner}>
              <Text style={s.pausedTitle}>Paused</Text>
              <Text style={s.pausedCopy}>Timer and camera view are stopped.</Text>
              <Pressable style={s.btnPrimaryWide} onPress={resumeSession}>
                <Text style={s.btnPrimaryText}>Resume Session</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  if (screen === "summary" && summaryRec) {
    return (
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Brand title="Session Complete" />
          <Card>
            <View style={s.summaryHero}>
              <Text style={s.summaryAccuracy}>{pct(summaryRec.onTarget, summaryRec.totalShots)}%</Text>
              <Text style={s.centerMeta}>Accuracy</Text>
            </View>
          </Card>
          <Card>
            <View style={s.statRow}>
              <Stat n={summaryRec.totalShots} l="Total Shots" c={C.amber} />
              <Stat n={summaryRec.onTarget} l="On Target" c={C.green} />
              <Stat n={summaryRec.missed} l="Missed" c={C.crimson} />
            </View>
          </Card>
          <Card>
            <View style={s.statRow}>
              <Stat n={fmtMMSS(summaryRec.duration)} l="Session Time" c={C.cyan} />
              <Stat n={summaryRec.targetsUsed} l="Targets Used" c={C.ice} />
            </View>
          </Card>
          <Pressable style={s.btnPrimary} onPress={() => setScreen("menu")}>
            <Text style={s.btnPrimaryText}>Back to Main Menu</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return null;
}

function Brand({ title }) {
  return (
    <View style={s.brand}>
      <Svg width={38} height={38} viewBox="0 0 44 44">
        <Defs>
          <LinearGradient id="puckGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor="#2a2d31" />
            <Stop offset="100%" stopColor="#0c0d0f" />
          </LinearGradient>
        </Defs>
        <Circle cx={22} cy={22} r={18.5} fill="none" stroke={C.amber} strokeWidth={1.4} opacity={0.4} />
        <Ellipse cx={22} cy={25} rx={14.5} ry={8} fill="#0a0a0b" stroke="#2b2f33" strokeWidth={1.3} />
        <Ellipse cx={22} cy={21.5} rx={14.5} ry={8} fill="url(#puckGrad)" stroke="#3a3f45" strokeWidth={1.3} />
      </Svg>
      <Text style={s.brandTitle}>{title}</Text>
    </View>
  );
}

function Card({ title, children }) {
  return (
    <View style={s.card}>
      <View style={s.cardAccent} />
      {title ? <Text style={s.cardHeader}>- {title}</Text> : null}
      {children}
    </View>
  );
}

function Stat({ n, l, c }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statNum, { color: c }]}>{n}</Text>
      <Text style={s.statLbl}>{l}</Text>
    </View>
  );
}

function Pill({ n, l, c }) {
  return (
    <View style={s.pill}>
      <Text style={[s.pillN, { color: c }]}>{n}</Text>
      <Text style={s.pillL}>{l}</Text>
    </View>
  );
}

function IconBtn({ label, onPress }) {
  return (
    <Pressable style={s.iconBtn} onPress={onPress}>
      <Text style={s.iconText}>{label}</Text>
    </Pressable>
  );
}

function NetAndTargets({ netBox, targets, w, h, radius, showLabels, flash }) {
  return (
    <>
      {netBox && netBox.x2 !== undefined ? (
        <Rect
          x={Math.min(netBox.x1, netBox.x2) * w}
          y={Math.min(netBox.y1, netBox.y2) * h}
          width={Math.abs(netBox.x2 - netBox.x1) * w}
          height={Math.abs(netBox.y2 - netBox.y1) * h}
          fill="rgba(79,182,199,0.08)"
          stroke={C.cyan}
          strokeWidth={2}
          strokeDasharray="6 5"
        />
      ) : netBox ? (
        <Circle cx={netBox.x1 * w} cy={netBox.y1 * h} r={8} fill={C.cyan} />
      ) : null}
      {targets.map((t, i) => {
        const cx = t.x * w;
        const cy = t.y * h;
        return (
          <React.Fragment key={`${t.x}-${t.y}-${i}`}>
            <Circle cx={cx} cy={cy} r={radius} fill="none" stroke={C.amber} strokeWidth={3} opacity={0.9} />
            <Circle cx={cx} cy={cy} r={Math.max(2, Math.min(6, radius * 0.35))} fill="none" stroke={C.ice} strokeWidth={1.5} opacity={0.7} />
            {showLabels ? (
              <SvgText x={cx} y={cy - radius - 8} fill={C.ice} fontSize={13} fontWeight="700" textAnchor="middle">
                Target {i + 1}
              </SvgText>
            ) : null}
          </React.Fragment>
        );
      })}
      {flash ? (
        <Circle
          cx={w / 2}
          cy={h / 2}
          r={Math.max(w, h)}
          fill={flash.hit ? "rgba(76,174,124,0.22)" : "rgba(209,73,91,0.22)"}
        />
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.arena },
  cameraRoot: { flex: 1, backgroundColor: "#000" },
  cameraFill: { flex: 1 },
  center: { justifyContent: "center", alignItems: "center", gap: 14, padding: 30 },
  menuPad: { paddingHorizontal: 20, paddingTop: 26, paddingBottom: 40, gap: 16 },
  brand: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: -4 },
  brandTitle: { color: C.ice, fontSize: 34, fontWeight: "700", textTransform: "uppercase" },
  subtitle: { color: C.steel, fontSize: 13, marginTop: -6, marginBottom: 6 },
  card: {
    position: "relative",
    backgroundColor: C.slate2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    padding: 18,
    overflow: "hidden",
  },
  cardAccent: { position: "absolute", top: 0, left: 18, right: 70, height: 3, backgroundColor: C.amber, borderBottomRightRadius: 2 },
  cardHeader: { color: C.steel, fontSize: 11, letterSpacing: 1.2, fontWeight: "700", textTransform: "uppercase", marginBottom: 14 },
  statRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  stat: { flex: 1, alignItems: "center" },
  statNum: { fontSize: 24, fontWeight: "700" },
  statLbl: { color: C.steel, fontSize: 10.5, marginTop: 4, textTransform: "uppercase", textAlign: "center" },
  empty: { color: C.steel, fontSize: 14, textAlign: "center", paddingVertical: 10 },
  metaLine: { color: C.steel, fontSize: 12, marginTop: 12, textAlign: "center" },
  centerMeta: { color: C.steel, fontSize: 11, textAlign: "center", textTransform: "uppercase", letterSpacing: 1.2 },
  careerAccuracy: { color: C.cyan, fontSize: 28, fontWeight: "700", textAlign: "center", marginTop: 14 },
  cameraIcon: { color: C.amber, fontSize: 28, fontWeight: "700" },
  errorText: { color: C.steel, textAlign: "center", fontSize: 15, lineHeight: 22 },
  btnPrimary: { backgroundColor: C.amber, borderRadius: 12, padding: 18, alignItems: "center" },
  btnPrimaryWide: { backgroundColor: C.amber, borderRadius: 12, padding: 18, alignItems: "center", minWidth: 220 },
  btnPrimaryText: { color: "#1a1204", fontWeight: "700", fontSize: 16 },
  btnSecondary: { backgroundColor: C.slate2, borderColor: C.line, borderWidth: 1, borderRadius: 12, padding: 16, alignItems: "center" },
  btnSecondaryText: { color: C.ice, fontWeight: "700", fontSize: 14 },
  disabled: { opacity: 0.4 },
  flexOne: { flex: 1 },
  topbar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderBottomWidth: 2,
    borderBottomColor: "rgba(226,166,59,0.28)",
  },
  topbarTitle: { color: C.ice, fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center", textTransform: "uppercase" },
  iconBtn: { minWidth: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  iconText: { color: C.ice, fontSize: 13, fontWeight: "700" },
  angleReadout: { position: "absolute", top: 114, left: 0, right: 0, alignItems: "center", gap: 6 },
  anglePill: { color: C.steel, backgroundColor: "rgba(15,22,30,0.85)", borderColor: C.line, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6, overflow: "hidden", fontSize: 11.5, fontWeight: "700" },
  fpsPill: { color: C.green, backgroundColor: "rgba(15,22,30,0.85)", borderColor: "rgba(76,174,124,0.4)", borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6, overflow: "hidden", fontSize: 11.5, fontWeight: "700" },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 40, paddingBottom: 28, gap: 10, backgroundColor: "rgba(0,0,0,0.64)", borderTopWidth: 2, borderTopColor: "rgba(226,166,59,0.25)" },
  hint: { color: C.ice, fontSize: 13, textAlign: "center", backgroundColor: "rgba(0,0,0,0.45)", padding: 10, borderRadius: 10, overflow: "hidden" },
  sliderBox: { backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 12, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  sliderHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  sliderLabel: { color: C.ice, fontSize: 12, fontWeight: "700" },
  sliderValue: { color: C.steel, fontSize: 12, fontWeight: "700" },
  rowBtns: { flexDirection: "row", gap: 10 },
  hudTop: { position: "absolute", top: 48, left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  timerText: { color: C.ice, fontWeight: "700", fontSize: 16.5, backgroundColor: "rgba(255,255,255,0.1)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, overflow: "hidden" },
  autoStatus: { fontSize: 11, fontWeight: "700", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, overflow: "hidden", borderWidth: 1 },
  autoOn: { color: C.green, backgroundColor: "rgba(76,174,124,0.18)", borderColor: "rgba(76,174,124,0.4)" },
  autoOff: { color: C.steel, backgroundColor: "rgba(126,147,166,0.15)", borderColor: "rgba(126,147,166,0.3)" },
  hudStats: { position: "absolute", top: 96, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 8, paddingHorizontal: 14 },
  pill: { backgroundColor: "rgba(13,20,28,0.8)", borderColor: C.line, borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10, alignItems: "center", flex: 1, maxWidth: 110 },
  pillN: { fontSize: 18, fontWeight: "700" },
  pillL: { color: C.steel, fontSize: 9, textTransform: "uppercase", textAlign: "center" },
  hudBottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 40, paddingBottom: 28, gap: 10, backgroundColor: "rgba(0,0,0,0.64)", borderTopWidth: 2, borderTopColor: "rgba(226,166,59,0.25)" },
  toggleRow: { flexDirection: "row", justifyContent: "center", gap: 8 },
  toggleBtn: { backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: C.line, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18 },
  toggleText: { color: C.ice, fontSize: 11, fontWeight: "700" },
  shotBtns: { flexDirection: "row", gap: 10 },
  shotBtnOn: { flex: 1, backgroundColor: C.green, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 8, alignItems: "center" },
  shotBtnMiss: { flex: 1, backgroundColor: C.crimson, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 8, alignItems: "center" },
  shotBtnText: { color: C.ice, fontWeight: "700", fontSize: 13, textAlign: "center" },
  pauseBtn: { flex: 1, backgroundColor: "#243342", borderRadius: 12, padding: 16, alignItems: "center" },
  pausedBanner: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,10,15,0.85)", alignItems: "center", justifyContent: "center", gap: 16, padding: 30 },
  pausedTitle: { color: C.ice, fontSize: 32, fontWeight: "700", textTransform: "uppercase" },
  pausedCopy: { color: C.steel, fontSize: 14, textAlign: "center" },
  summaryHero: { alignItems: "center", paddingVertical: 4 },
  summaryAccuracy: { color: C.amber, fontSize: 50, fontWeight: "700" },
});
