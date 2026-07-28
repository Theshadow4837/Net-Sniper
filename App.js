import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
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
import * as Speech from "expo-speech";
// Voice command support ("start" / "pause" / "resume"). This is a native
// module - after pulling this change, run `npx expo install
// @react-native-voice/voice` and rebuild your dev client (expo run:android /
// expo run:ios / eas build) or voice commands will silently no-op.
let Voice = null;
try {
  // eslint-disable-next-line global-require
  Voice = require("@react-native-voice/voice").default;
} catch {
  Voice = null;
}

const C = {
  arena: "#0A121C",
  slate: "#121F2C",
  slate2: "#182838",
  slate3: "#1F3140",
  ice: "#E9F2F6",
  steel: "#7E93A6",
  line: "#223243",
  amber: "#E2A63B",
  amberDeep: "#B9822A",
  cyan: "#4FB6C7",
  green: "#4CAE7C",
  crimson: "#D1495B",
  violet: "#8C7CF0",
};

const K_TOTALS = "netsniper:totals";
const K_LATEST = "netsniper:latest";
const K_SESSIONS = "netsniper:sessions";
const K_SETTINGS = "netsniper:settings";
const K_STREAK = "netsniper:streak";
const K_TUTORIAL_SEEN = "netsniper:tutorialSeen";
const K_BEST_PERFECT10 = "netsniper:bestPerfect10";
const REF_WIDTH = 380;
// Detection tuning defaults. These are now user-adjustable in the Settings
// screen; these values are exactly what the app previously hardcoded, so
// behavior is unchanged until someone edits a setting.
const DEFAULT_SETTINGS = {
  sampleSpacingPx: 5,
  motionDiffMin: 22,
  motionDiffNoiseMult: 3.2,
  minChangedSamples: 3,
  maxChangedRatio: 0.55,
  clusterMaxSpanRatio: 0.65,
  motionOnsetFrames: 2,
  motionEndQuietFrames: 4,
  shotCooldownMs: 900,
  hitRadiusMult: 1.35,
};
const MIN_GRID = 14;
const MAX_GRID_COLS = 64;
const MAX_GRID_ROWS = 48;
const DEFAULT_TARGET_RADIUS = 34;
const TIME_ATTACK_DURATIONS = [15, 30, 60, 90];
// Called Shot: a LOT of time on the very first calls, ramping down steadily
// as rounds are completed, down to a tight minimum.
const CALLED_SHOT_START_MS = 20000;
const CALLED_SHOT_MIN_MS = 1000;
const CALLED_SHOT_STEP_MS = 650;
const GAME_INFO = {
  timeAttack: { title: "Time Attack", blurb: "Pick a clock and rack up as many On Target hits as you can before it runs out." },
  suddenDeath: { title: "Sudden Death", blurb: "Your streak climbs with every hit. One missed shot ends the run." },
  perfect10: { title: "Perfect 10", blurb: "10 shots, one accuracy %. Try to beat your personal best." },
  calledShot: { title: "Called Shot", blurb: "A number is called out - hit that exact target before time runs out. Starts slow, gets much faster." },
};
const SCREENS_WITH_NAV = ["menu", "games", "sessions", "settings", "highscores"];

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

function dateKeyFor(d) {
  // Local calendar day (respects the device's timezone), not UTC.
  return d.toDateString();
}

function isConsecutiveDay(prevKey, todayDate) {
  if (!prevKey) return false;
  const y = new Date(todayDate);
  y.setDate(todayDate.getDate() - 1);
  return prevKey === dateKeyFor(y);
}

function computeDisplayStreak(streak, now) {
  if (!streak || !streak.lastDate || !streak.count) return 0;
  const today = dateKeyFor(now);
  if (streak.lastDate === today) return streak.count;
  if (isConsecutiveDay(streak.lastDate, now)) return streak.count;
  // A day was missed without a qualifying session - streak is gone.
  return 0;
}

export default function App() {
  const [screen, setScreen] = useState("menu");
  const [totals, setTotals] = useState({ totalShots: 0, onTarget: 0, missed: 0 });
  const [latest, setLatest] = useState(null);
  const [sessionsLog, setSessionsLog] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [streak, setStreak] = useState({ count: 0, lastDate: null });
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);

  const [facing, setFacing] = useState("back");
  const [netBox, setNetBox] = useState(null);
  const [setupStage, setSetupStage] = useState("netcorner1");
  const [targets, setTargets] = useState([]);
  const [targetRadius, setTargetRadius] = useState(DEFAULT_TARGET_RADIUS);
  const [selectedTargetIndex, setSelectedTargetIndex] = useState(null);
  const [layout, setLayout] = useState({ w: 1, h: 1 });

  const [current, setCurrent] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [autoDetectOn, setAutoDetectOn] = useState(false);
  const [summaryRec, setSummaryRec] = useState(null);
  const [flash, setFlash] = useState(null);
  const [autoStatusText, setAutoStatusText] = useState("Manual Mode");
  const [freshDevices, setFreshDevices] = useState([]);

  const [gameMode, setGameMode] = useState(null);
  const [pendingGameMode, setPendingGameMode] = useState(null);
  const [timeAttackDuration, setTimeAttackDuration] = useState(30);
  const [gameLive, setGameLive] = useState(null);
  const [pendingGameEnd, setPendingGameEnd] = useState(null);
  const [gameSummaryRec, setGameSummaryRec] = useState(null);
  const [bestPerfect10, setBestPerfect10] = useState(0);

  const timerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const countdownRef = useRef(null);
  const pauseStartRef = useRef(0);
  const gameModeRef = useRef(null);
  const timeAttackDurationRef = useRef(timeAttackDuration);
  timeAttackDurationRef.current = timeAttackDuration;

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

  // True once a game is actually live (post-countdown) - or always true for
  // a plain shooting session. Used to keep auto-detect from scoring shots
  // while a game is still "armed" and waiting for the start command.
  const gameIsScoring = !gameMode || (gameLive && gameLive.phase === "live");

  function startCalledShotRound(limitMs, roundsCompleted, announce = true) {
    setGameLive((g) => {
      if (!g || targets.length === 0) return g;
      const idx = announce || g.calledIndex == null ? Math.floor(Math.random() * targets.length) : g.calledIndex;
      if (announce) {
        try {
          Speech.speak(String(idx + 1), { rate: 1.0 });
        } catch {
          // Speech is best-effort - the huge on-screen number is the fallback.
        }
      }
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      const endAt = Date.now() + limitMs;
      gameTimerRef.current = setInterval(() => {
        setGameLive((cur) => {
          if (!cur || cur.awaitingNext || cur.ended) return cur;
          const remain = endAt - Date.now();
          if (remain <= 0) {
            clearInterval(gameTimerRef.current);
            setPendingGameEnd({ reason: "timeout" });
            return { ...cur, roundRemainingMs: 0, ended: true };
          }
          return { ...cur, roundRemainingMs: remain };
        });
      }, 100);
      return { ...g, calledIndex: idx, roundLimitMs: limitMs, roundRemainingMs: limitMs, roundsCompleted, awaitingNext: false, phase: "live" };
    });
  }

  const handleShotResult = useCallback((hitIndex) => {
    if (isPaused) return;
    // Ignore shots while a game is armed/counting down - it hasn't started yet.
    if (gameMode && !(gameLive && gameLive.phase === "live")) return;
    // In Called Shot, only hitting the exact called-out target counts as a
    // hit - hitting a different target, or missing outright, both count as
    // a miss for stats purposes (they just don't end the round).
    const hit = gameMode === "calledShot"
      ? (gameLive != null && hitIndex === gameLive.calledIndex)
      : hitIndex >= 0;
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

    if (!gameMode) {
      setAutoStatusText(hit ? "Target hit" : "Shot missed");
      setTimeout(() => {
        setAutoStatusText(autoDetectOn ? "Watching" : "Manual Mode");
      }, 650);
      return;
    }

    if (gameMode === "suddenDeath") {
      if (hit) {
        setGameLive((g) => (g ? { ...g, streak: g.streak + 1 } : g));
      } else {
        setPendingGameEnd({ reason: "missed" });
      }
      return;
    }

    if (gameMode === "perfect10") {
      setGameLive((g) => {
        if (!g) return g;
        const shots = g.shots + 1;
        if (shots >= 10) setTimeout(() => setPendingGameEnd({ reason: "complete" }), 0);
        return { ...g, shots };
      });
      return;
    }

    if (gameMode === "calledShot") {
      setGameLive((g) => {
        if (!g || g.ended) return g;
        if (hit) {
          const nextLimit = Math.max(CALLED_SHOT_MIN_MS, g.roundLimitMs - CALLED_SHOT_STEP_MS);
          const roundsCompleted = g.roundsCompleted + 1;
          if (gameTimerRef.current) clearInterval(gameTimerRef.current);
          try {
            Speech.speak("Good", { rate: 1.15 });
          } catch {
            // Speech is best-effort.
          }
          setTimeout(() => startCalledShotRound(nextLimit, roundsCompleted), 900);
          return { ...g, roundsCompleted, roundLimitMs: nextLimit, awaitingNext: true };
        }
        // Wrong target (or a miss) doesn't end the round - only the round
        // timer running out does. This keeps the game readable: you always
        // know exactly why a round ended. It still counted as a miss above.
        return g;
      });
      return;
    }
    // Time Attack needs no extra branching - the countdown timer ends it.
  }, [isPaused, gameMode, gameLive, autoDetectOn, targets.length]);

  const onFrameShot = useMemo(() => Worklets.createRunOnJS((hitIndex) => {
    handleShotResult(hitIndex);
  }), [handleShotResult]);

  const frameProcessor = useFrameProcessor((frame) => {
    "worklet";
    // Process at the highest fps this device/format can actually deliver,
    // instead of an artificial fixed cap - this is the main lever for catching
    // small, fast-moving pucks: more samples per second means the puck can't
    // "skip over" the net box between processed frames.
    const targetFps = maxFps || 30;
    const cfg = settings;
    runAtTargetFps(targetFps, () => {
      "worklet";
      if (!autoDetectOn || isPaused || !gameIsScoring || !netBox || netBox.x2 === undefined || targets.length === 0) {
        global.__netSniperPrevSamples = undefined;
        global.__netSniperPrevCols = undefined;
        global.__netSniperPrevRows = undefined;
        global.__netSniperPrevCentroid = undefined;
        global.__netSniperState = "idle";
        global.__netSniperOnsetCount = 0;
        global.__netSniperQuietCount = 0;
        global.__netSniperActiveHitIndex = -1;
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
      let cols = Math.round(boxWidthPx / cfg.sampleSpacingPx);
      let rows = Math.round(boxHeightPx / cfg.sampleSpacingPx);
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
      const threshold = Math.max(cfg.motionDiffMin, avgDiff * cfg.motionDiffNoiseMult);

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
        changed >= cfg.minChangedSamples &&
        changedRatio <= cfg.maxChangedRatio &&
        !(spanCols > cfg.clusterMaxSpanRatio && spanRows > cfg.clusterMaxSpanRatio);

      const cx = sumX / changed;
      const cy = sumY / changed;

      const checkHit = (fromCentroid, toX, toY) => {
        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i];
          const rNorm = ((t.radius || 34) / REF_WIDTH) * cfg.hitRadiusMult;
          const dx = toX - t.x;
          const dy = toY - t.y;
          if (Math.sqrt(dx * dx + dy * dy) <= rNorm) return i;
          if (fromCentroid) {
            const segSteps = 4;
            for (let step = 1; step <= segSteps; step += 1) {
              const fx = fromCentroid.x + ((toX - fromCentroid.x) * step) / segSteps;
              const fy = fromCentroid.y + ((toY - fromCentroid.y) * step) / segSteps;
              const ddx = fx - t.x;
              const ddy = fy - t.y;
              if (Math.sqrt(ddx * ddx + ddy * ddy) <= rNorm) return i;
            }
          }
        }
        return -1;
      };

      if (!isMotion) {
        global.__netSniperPrevCentroid = undefined;
        if (state === "active") {
          const quiet = (global.__netSniperQuietCount || 0) + 1;
          global.__netSniperQuietCount = quiet;
          if (quiet >= cfg.motionEndQuietFrames) {
            // Motion has fully stopped - the shot is over. Finalize it exactly
            // once, whether or not it ever registered as a hit.
            const finalHitIndex = global.__netSniperActiveHitIndex === undefined ? -1 : global.__netSniperActiveHitIndex;
            global.__netSniperState = "idle";
            global.__netSniperActiveHitIndex = -1;
            global.__netSniperQuietCount = 0;
            global.__netSniperOnsetCount = 0;
            global.__netSniperCooldownUntil = now + cfg.shotCooldownMs;
            onFrameShot(finalHitIndex);
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
        if (onset >= cfg.motionOnsetFrames) {
          // Confirmed as a real shot starting, not a single-frame flicker.
          global.__netSniperState = "active";
          global.__netSniperQuietCount = 0;
          global.__netSniperActiveHitIndex = checkHit(undefined, cx, cy);
        }
        return;
      }

      // state === "active": keep tracking the same shot for as long as motion
      // continues (covers puck bounce/net wobble after impact) rather than
      // treating each frame as its own shot.
      const prevCentroid = global.__netSniperPrevCentroid;
      global.__netSniperQuietCount = 0;
      if ((global.__netSniperActiveHitIndex === undefined || global.__netSniperActiveHitIndex < 0)) {
        const idx = checkHit(prevCentroid, cx, cy);
        if (idx >= 0) global.__netSniperActiveHitIndex = idx;
      }
      global.__netSniperPrevCentroid = { x: cx, y: cy };
    });
  }, [autoDetectOn, isPaused, gameIsScoring, netBox, targets, settings, maxFps, onFrameShot]);

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
        const [t, l, sess, set, str, tut, best] = await Promise.all([
          AsyncStorage.getItem(K_TOTALS),
          AsyncStorage.getItem(K_LATEST),
          AsyncStorage.getItem(K_SESSIONS),
          AsyncStorage.getItem(K_SETTINGS),
          AsyncStorage.getItem(K_STREAK),
          AsyncStorage.getItem(K_TUTORIAL_SEEN),
          AsyncStorage.getItem(K_BEST_PERFECT10),
        ]);
        if (t) setTotals(JSON.parse(t));
        if (l) setLatest(JSON.parse(l));
        if (sess) setSessionsLog(JSON.parse(sess));
        if (set) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(set) });
        if (str) setStreak(JSON.parse(str));
        if (!tut) setShowTutorial(true);
        if (best) setBestPerfect10(JSON.parse(best));
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
    if (gameTimerRef.current) clearInterval(gameTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  // ---- Voice commands ("start" while a game is armed, "pause"/"resume" any
  // time a session or game is running). Best-effort: if the native module
  // isn't installed/built, this whole block just never fires.
  const voiceListeningRef = useRef(false);
  const handleVoiceCommandRef = useRef(() => {});

  useEffect(() => {
    handleVoiceCommandRef.current = (rawText) => {
      const t = (rawText || "").toLowerCase();
      if (screen === "game" && gameLive?.phase === "armed" && /\bstart\b/.test(t)) {
        startCountdown();
        return;
      }
      if ((screen === "game" || screen === "session") && /\bpause\b/.test(t) && !isPaused) {
        if (screen === "session") pauseSession();
        else pauseGame();
        return;
      }
      if ((screen === "game" || screen === "session") && /\b(resume|unpause|continue)\b/.test(t) && isPaused) {
        if (screen === "session") resumeSession();
        else resumeGame();
      }
    };
  });

  useEffect(() => {
    if (!Voice) return undefined;
    const shouldListen = screen === "game" || screen === "session";
    if (!shouldListen) {
      if (voiceListeningRef.current) {
        voiceListeningRef.current = false;
        Voice.stop().catch(() => {});
      }
      return undefined;
    }

    const restart = () => {
      if (!voiceListeningRef.current) return;
      Voice.start("en-US").catch(() => {});
    };
    Voice.onSpeechResults = (e) => {
      const text = (e && e.value && e.value.join(" ")) || "";
      handleVoiceCommandRef.current(text);
    };
    Voice.onSpeechPartialResults = (e) => {
      const text = (e && e.value && e.value.join(" ")) || "";
      handleVoiceCommandRef.current(text);
    };
    Voice.onSpeechEnd = () => setTimeout(restart, 150);
    Voice.onSpeechError = () => setTimeout(restart, 400);

    voiceListeningRef.current = true;
    Voice.start("en-US").catch(() => {});

    return () => {
      voiceListeningRef.current = false;
      Voice.stop().catch(() => {});
      Voice.destroy().then(() => Voice.removeAllListeners()).catch(() => {});
    };
  }, [screen]);

  const radiusPx = useCallback((r, width) => (r / REF_WIDTH) * width, []);

  function resetSetup() {
    setNetBox(null);
    setTargets([]);
    setSetupStage("netcorner1");
    setTargetRadius(DEFAULT_TARGET_RADIUS);
    setSelectedTargetIndex(null);
  }

  function enterSetup() {
    resetSetup();
    setScreen("setup");
  }

  function persistSettings(next) {
    setSettings(next);
    AsyncStorage.setItem(K_SETTINGS, JSON.stringify(next)).catch(() => {});
  }

  function updateSetting(key, value) {
    persistSettings({ ...settings, [key]: value });
  }

  function resetSettingsToDefault() {
    Alert.alert("Reset calibration?", "This restores all detection settings to their defaults.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: () => persistSettings(DEFAULT_SETTINGS) },
    ]);
  }

  function dismissTutorial() {
    setShowTutorial(false);
    setTutorialStep(0);
    AsyncStorage.setItem(K_TUTORIAL_SEEN, "1").catch(() => {});
  }

  async function shareStats(rec) {
    const isSession = !!rec;
    const src = isSession ? rec : totals;
    const title = isSession ? "My Net Sniper session" : "My Net Sniper career stats";
    const message =
      `${title}\n` +
      `Shots: ${src.totalShots}\n` +
      `On Target: ${src.onTarget}\n` +
      `Missed: ${src.missed}\n` +
      `Accuracy: ${pct(src.onTarget, src.totalShots)}%` +
      (isSession ? `\nTime: ${fmtMMSS(src.duration)}` : "");
    try {
      await Share.share({ message });
    } catch {
      // Sharing can be cancelled by the user - nothing to do.
    }
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
      setTargets((ts) => [...ts, { x, y, radius: targetRadius }]);
      setSelectedTargetIndex(null);
    }
  }, [layout.h, layout.w, setupStage, targetRadius]);

  const onDragTarget = useCallback((index, nx, ny) => {
    setTargets((ts) => ts.map((t, i) => (i === index ? { ...t, x: nx, y: ny } : t)));
  }, []);

  const onSelectTarget = useCallback((index) => {
    setSelectedTargetIndex(index);
  }, []);

  function undoSetup() {
    if (setupStage === "targets" && targets.length > 0) {
      setTargets((ts) => ts.slice(0, -1));
      setSelectedTargetIndex(null);
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
    if (pendingGameMode) {
      const mode = pendingGameMode;
      setPendingGameMode(null);
      armGame(mode);
      return;
    }
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
    handleShotResult(hit ? 0 : -1);
  }

  function registerCalledShotTarget(index) {
    if (isPaused || !current) return;
    handleShotResult(index);
  }

  function registerCalledShotMiss() {
    if (isPaused || !current) return;
    handleShotResult(-1);
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

  // Games have their own pause/resume because the underlying countdown
  // timers (Time Attack clock, Called Shot round clock) need to be stopped
  // and restarted around the pause instead of just freezing the UI.
  function pauseGame() {
    if (isPaused || !current) return;
    setIsPaused(true);
    setAutoStatusText("Paused");
    pauseStartRef.current = Date.now();
    if (gameTimerRef.current) clearInterval(gameTimerRef.current);
  }

  function resumeGame() {
    if (!isPaused || !current) return;
    setIsPaused(false);
    setAutoStatusText(autoDetectOn ? "Watching" : "Manual Mode");
    setCurrent((cur) => (cur ? { ...cur, pausedAccum: cur.pausedAccum + Date.now() - pauseStartRef.current } : cur));

    if (gameMode === "timeAttack") {
      setGameLive((g) => {
        if (!g) return g;
        const endAt = Date.now() + g.remainingMs;
        gameTimerRef.current = setInterval(() => {
          const remain = endAt - Date.now();
          if (remain <= 0) {
            clearInterval(gameTimerRef.current);
            setGameLive((gg) => (gg ? { ...gg, remainingMs: 0 } : gg));
            setPendingGameEnd({ reason: "time" });
          } else {
            setGameLive((gg) => (gg ? { ...gg, remainingMs: remain } : gg));
          }
        }, 100);
        return g;
      });
    } else if (gameMode === "calledShot") {
      setGameLive((g) => {
        if (!g) return g;
        startCalledShotRound(g.roundRemainingMs, g.roundsCompleted, false);
        return g;
      });
    }
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

    // Streak: a day only counts if this session (or another one that day) had
    // at least 5 shots before local midnight. Missing a day resets it to 0.
    let newStreak = streak;
    if (rec.totalShots >= 5) {
      const now = new Date();
      const today = dateKeyFor(now);
      if (streak.lastDate === today) {
        newStreak = streak;
      } else if (isConsecutiveDay(streak.lastDate, now)) {
        newStreak = { count: (streak.count || 0) + 1, lastDate: today };
      } else {
        newStreak = { count: 1, lastDate: today };
      }
      setStreak(newStreak);
    }

    setTotals(newTotals);
    setLatest(rec);
    setSessionsLog(newLog);
    setCurrent(null);
    setSummaryRec(rec);
    await Promise.all([
      AsyncStorage.setItem(K_TOTALS, JSON.stringify(newTotals)),
      AsyncStorage.setItem(K_LATEST, JSON.stringify(rec)),
      AsyncStorage.setItem(K_SESSIONS, JSON.stringify(newLog)),
      AsyncStorage.setItem(K_STREAK, JSON.stringify(newStreak)),
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
          setStreak({ count: 0, lastDate: null });
          setBestPerfect10(0);
          await AsyncStorage.multiRemove([K_TOTALS, K_LATEST, K_SESSIONS, K_STREAK, K_BEST_PERFECT10]);
        },
      },
    ]);
  }

  // Every game (and every session) requires a fresh net/target setup - we
  // never silently reuse whatever was placed for a previous round.
  function startGameFlow(mode) {
    setPendingGameMode(mode);
    resetSetup();
    setScreen("setup");
  }

  // "Arm" a game: net/targets are already placed, auto-detect defaults ON,
  // but nothing is scored and no clock runs until the player says or taps
  // "Start", at which point a 3-2-1 countdown runs and the real game begins.
  function armGame(mode) {
    gameModeRef.current = mode;
    setGameMode(mode);
    setCurrent(null);
    setIsPaused(false);
    setAutoDetectOn(true);
    setAutoStatusText("Watching");
    setGameLive({ phase: "armed" });
    setScreen("game");
  }

  function startCountdown() {
    setGameLive((g) => (g && g.phase === "armed" ? { ...g, phase: "countdown", count: 3 } : g));
    let n = 3;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(countdownRef.current);
        activateGameMode();
      } else {
        setGameLive((g) => (g ? { ...g, count: n } : g));
      }
    }, 800);
  }

  function activateGameMode() {
    const mode = gameModeRef.current;
    if (mode === "timeAttack") startTimeAttack(timeAttackDurationRef.current);
    else if (mode === "suddenDeath") startSuddenDeath();
    else if (mode === "perfect10") startPerfect10();
    else if (mode === "calledShot") startCalledShot();
  }

  function beginGameCommon(mode, live) {
    const next = { totalShots: 0, onTarget: 0, missed: 0, startTime: Date.now(), pausedAccum: 0 };
    setCurrent(next);
    setIsPaused(false);
    setGameLive({ ...live, phase: "live" });
  }

  function startTimeAttack(durationSec) {
    beginGameCommon("timeAttack", { remainingMs: durationSec * 1000, durationMs: durationSec * 1000 });
    if (gameTimerRef.current) clearInterval(gameTimerRef.current);
    const endAt = Date.now() + durationSec * 1000;
    gameTimerRef.current = setInterval(() => {
      const remain = endAt - Date.now();
      if (remain <= 0) {
        clearInterval(gameTimerRef.current);
        setGameLive((g) => (g ? { ...g, remainingMs: 0 } : g));
        setPendingGameEnd({ reason: "time" });
      } else {
        setGameLive((g) => (g ? { ...g, remainingMs: remain } : g));
      }
    }, 100);
  }

  function startSuddenDeath() {
    beginGameCommon("suddenDeath", { streak: 0 });
  }

  function startPerfect10() {
    beginGameCommon("perfect10", { shots: 0 });
  }

  function startCalledShot() {
    beginGameCommon("calledShot", {
      calledIndex: null,
      roundLimitMs: CALLED_SHOT_START_MS,
      roundRemainingMs: CALLED_SHOT_START_MS,
      roundsCompleted: 0,
      ended: false,
      awaitingNext: false,
    });
    setTimeout(() => startCalledShotRound(CALLED_SHOT_START_MS, 0), 600);
  }

  useEffect(() => {
    if (!pendingGameEnd || !current) return;
    finalizeGame(pendingGameEnd.reason);
    setPendingGameEnd(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGameEnd]);

  async function finalizeGame(reason) {
    if (!current) return;
    if (timerRef.current) clearInterval(timerRef.current);
    if (gameTimerRef.current) clearInterval(gameTimerRef.current);
    const duration = (Date.now() - current.startTime - current.pausedAccum) / 1000;
    const rec = {
      totalShots: current.totalShots,
      onTarget: current.onTarget,
      missed: current.missed,
      duration,
      targetsUsed: targets.length,
      date: Date.now(),
      gameMode,
      endReason: reason,
    };
    let newBestPerfect10 = bestPerfect10;
    if (gameMode === "timeAttack") {
      rec.gameScore = current.onTarget;
    } else if (gameMode === "suddenDeath") {
      rec.gameScore = gameLive ? gameLive.streak : 0;
    } else if (gameMode === "perfect10") {
      rec.gameScore = pct(current.onTarget, current.totalShots);
      if (rec.gameScore > bestPerfect10) {
        newBestPerfect10 = rec.gameScore;
        setBestPerfect10(newBestPerfect10);
        AsyncStorage.setItem(K_BEST_PERFECT10, JSON.stringify(newBestPerfect10)).catch(() => {});
      }
    } else if (gameMode === "calledShot") {
      rec.gameScore = gameLive ? gameLive.roundsCompleted : 0;
    }

    const newTotals = {
      totalShots: totals.totalShots + rec.totalShots,
      onTarget: totals.onTarget + rec.onTarget,
      missed: totals.missed + rec.missed,
    };
    const newLog = [...sessionsLog, rec].slice(-100);

    let newStreak = streak;
    if (rec.totalShots >= 5) {
      const now = new Date();
      const today = dateKeyFor(now);
      if (streak.lastDate === today) {
        newStreak = streak;
      } else if (isConsecutiveDay(streak.lastDate, now)) {
        newStreak = { count: (streak.count || 0) + 1, lastDate: today };
      } else {
        newStreak = { count: 1, lastDate: today };
      }
      setStreak(newStreak);
    }

    setTotals(newTotals);
    setLatest(rec);
    setSessionsLog(newLog);
    setCurrent(null);
    setGameSummaryRec(rec);
    setGameMode(null);
    setGameLive(null);
    await Promise.all([
      AsyncStorage.setItem(K_TOTALS, JSON.stringify(newTotals)),
      AsyncStorage.setItem(K_LATEST, JSON.stringify(rec)),
      AsyncStorage.setItem(K_SESSIONS, JSON.stringify(newLog)),
      AsyncStorage.setItem(K_STREAK, JSON.stringify(newStreak)),
    ]);
    setScreen("gameSummary");
  }

  const highScores = useMemo(() => {
    const best = { timeAttack: 0, suddenDeath: 0, perfect10: bestPerfect10, calledShot: 0 };
    for (const rec of sessionsLog) {
      if (!rec.gameMode) continue;
      const score = rec.gameScore ?? 0;
      if (score > (best[rec.gameMode] ?? 0)) best[rec.gameMode] = score;
    }
    return best;
  }, [sessionsLog, bestPerfect10]);

  function goTab(target) {
    setScreen(target);
  }

  const withNav = (content) => (
    <>
      {content}
      <BottomNav active={screen} onNavigate={goTab} />
    </>
  );

  if (screen === "menu") {
    const displayStreak = computeDisplayStreak(streak, new Date());
    return withNav(
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Brand title="Net Sniper" />
          <Text style={s.subtitle}>Track your shooting accuracy, one puck at a time.</Text>

          {displayStreak > 0 ? (
            <View style={s.streakBanner}>
              <Text style={s.streakText}>{displayStreak} day streak</Text>
            </View>
          ) : null}

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
            <Pressable style={s.shareLink} onPress={() => shareStats(null)}>
              <Text style={s.shareLinkText}>Share Career Stats</Text>
            </Pressable>
          </Card>

          <Pressable style={s.btnPrimary} onPress={enterSetup}>
            <Text style={s.btnPrimaryText}>Start Shooting Session</Text>
          </Pressable>
          <Pressable style={s.btnPrimary} onPress={() => setScreen("games")}>
            <Text style={s.btnPrimaryText}>Play a Game</Text>
          </Pressable>
        </ScrollView>
        {showTutorial ? (
          <TutorialOverlay step={tutorialStep} setStep={setTutorialStep} onDone={dismissTutorial} />
        ) : null}
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
            ? "Drag targets to move them, tap one to resize it, or tap empty space to add more."
            : "Net area set. Tap inside it to place target zones.";
    const canBegin = setupStage === "targets" && targets.length > 0;
    const selectedTarget = setupStage === "targets" && selectedTargetIndex != null ? targets[selectedTargetIndex] : null;
    const sliderValue = selectedTarget ? selectedTarget.radius : targetRadius;
    const sliderLabel = selectedTarget ? `Target ${selectedTargetIndex + 1} Size` : "New Target Size";
    const onSliderChange = (v) => {
      if (selectedTarget) {
        setTargets((ts) => ts.map((t, i) => (i === selectedTargetIndex ? { ...t, radius: v } : t)));
      } else {
        setTargetRadius(v);
      }
    };

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
            <NetAndTargets netBox={netBox} targets={setupStage === "targets" ? [] : targets} w={layout.w} h={layout.h} showLabels />
          </Svg>
          {setupStage === "targets"
            ? targets.map((t, i) => (
              <DraggableTarget
                key={`drag-${i}`}
                target={t}
                index={i}
                w={layout.w}
                h={layout.h}
                selected={selectedTargetIndex === i}
                onSelect={onSelectTarget}
                onDrag={onDragTarget}
              />
            ))
            : null}

          <View style={s.topbar}>
            <IconBtn label="<" onPress={() => { setPendingGameMode(null); setScreen("menu"); }} />
            <Text style={s.topbarTitle}>{pendingGameMode ? "Set Up for Game" : "Set Up Net & Targets"}</Text>
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
                  <Text style={s.sliderLabel}>{sliderLabel}</Text>
                  <Text style={s.sliderValue}>{targetSizeLabel(sliderValue)}</Text>
                </View>
                <Slider
                  minimumValue={7}
                  maximumValue={60}
                  step={1}
                  value={sliderValue}
                  minimumTrackTintColor={C.amber}
                  maximumTrackTintColor={C.line}
                  thumbTintColor={C.amber}
                  onValueChange={onSliderChange}
                />
                {selectedTarget ? (
                  <View style={s.rowBtns}>
                    <Pressable
                      style={[s.btnSecondary, s.flexOne]}
                      onPress={() => {
                        setTargets((ts) => ts.filter((_, i) => i !== selectedTargetIndex));
                        setSelectedTargetIndex(null);
                      }}
                    >
                      <Text style={s.btnSecondaryText}>Delete Target</Text>
                    </Pressable>
                    <Pressable style={[s.btnSecondary, s.flexOne]} onPress={() => setSelectedTargetIndex(null)}>
                      <Text style={s.btnSecondaryText}>Done</Text>
                    </Pressable>
                  </View>
                ) : null}
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
                <Text style={s.btnPrimaryText}>{pendingGameMode ? "Continue to Game" : "Begin Session"}</Text>
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
              <Text style={s.pausedCopy}>Timer and camera view are stopped. Say "resume" or tap below.</Text>
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
          <Pressable style={s.btnSecondary} onPress={() => shareStats(summaryRec)}>
            <Text style={s.btnSecondaryText}>Share This Session</Text>
          </Pressable>
          <Pressable style={s.btnPrimary} onPress={() => setScreen("menu")}>
            <Text style={s.btnPrimaryText}>Back to Main Menu</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "sessions") {
    const rows = [...sessionsLog].reverse();
    return withNav(
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <View style={s.topbarStatic}>
          <Text style={s.topbarTitleDark}>Session History</Text>
        </View>
        <ScrollView contentContainerStyle={s.menuPad}>
          {rows.length === 0 ? (
            <Card>
              <Text style={s.empty}>No sessions yet - take your first shot!</Text>
            </Card>
          ) : (
            rows.map((rec, i) => (
              <Card key={rec.date || i}>
                <View style={s.sessionRowHeader}>
                  <Text style={s.sessionRowDate}>{new Date(rec.date).toLocaleString()}</Text>
                  <Text style={s.sessionRowAccuracy}>{pct(rec.onTarget, rec.totalShots)}%</Text>
                </View>
                {rec.gameMode ? <Text style={s.metaTag}>{GAME_INFO[rec.gameMode]?.title || rec.gameMode}</Text> : null}
                <View style={s.statRow}>
                  <Stat n={rec.totalShots} l="Shots" c={C.amber} />
                  <Stat n={rec.onTarget} l="On Target" c={C.green} />
                  <Stat n={rec.missed} l="Missed" c={C.crimson} />
                </View>
                <Text style={s.metaLine}>{fmtMMSS(rec.duration)} - {rec.targetsUsed} target(s)</Text>
                <Pressable style={s.shareLink} onPress={() => shareStats(rec)}>
                  <Text style={s.shareLinkText}>Share This Session</Text>
                </Pressable>
              </Card>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "settings") {
    return withNav(
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <View style={s.topbarStatic}>
          <Text style={s.topbarTitleDark}>Settings</Text>
        </View>
        <ScrollView contentContainerStyle={s.menuPad}>
          <Text style={s.sectionLabel}>Detection Tuning</Text>
          <Text style={s.subtitle}>
            These control how auto-detect senses the puck. Defaults work well for most setups - only
            change these if you're fine-tuning for your lighting or camera.
          </Text>
          <SettingSlider
            label="Motion Sensitivity"
            hint="Lower = more sensitive to small/distant movement"
            value={settings.motionDiffNoiseMult}
            min={1.5}
            max={5}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={(v) => updateSetting("motionDiffNoiseMult", v)}
          />
          <SettingSlider
            label="Minimum Changed Cells"
            hint="How many grid cells must change to count as motion"
            value={settings.minChangedSamples}
            min={1}
            max={10}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => updateSetting("minChangedSamples", Math.round(v))}
          />
          <SettingSlider
            label="Grid Detail"
            hint="Smaller spacing = finer detection grid (uses more CPU)"
            value={settings.sampleSpacingPx}
            min={3}
            max={12}
            step={1}
            format={(v) => `${Math.round(v)}px`}
            onChange={(v) => updateSetting("sampleSpacingPx", Math.round(v))}
          />
          <SettingSlider
            label="Frames to Confirm Shot Start"
            hint="Higher = fewer false starts, but slightly slower to react"
            value={settings.motionOnsetFrames}
            min={1}
            max={5}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => updateSetting("motionOnsetFrames", Math.round(v))}
          />
          <SettingSlider
            label="Frames to Confirm Shot End"
            hint="Higher = waits longer for bounces/wobble to settle before counting"
            value={settings.motionEndQuietFrames}
            min={1}
            max={10}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(v) => updateSetting("motionEndQuietFrames", Math.round(v))}
          />
          <SettingSlider
            label="Cooldown Between Shots"
            hint="Minimum time before a new shot can start after one ends"
            value={settings.shotCooldownMs}
            min={200}
            max={3000}
            step={50}
            format={(v) => `${Math.round(v)}ms`}
            onChange={(v) => updateSetting("shotCooldownMs", Math.round(v))}
          />
          <SettingSlider
            label="Hit Zone Generosity"
            hint="How far past a target's edge still counts as a hit"
            value={settings.hitRadiusMult}
            min={1}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}x`}
            onChange={(v) => updateSetting("hitRadiusMult", v)}
          />
          <SettingSlider
            label="Max Changed Ratio"
            hint="Ignore motion covering more than this % of the net box (shake/lighting)"
            value={settings.maxChangedRatio * 100}
            min={20}
            max={90}
            step={5}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => updateSetting("maxChangedRatio", v / 100)}
          />
          <Pressable style={s.btnSecondary} onPress={resetSettingsToDefault}>
            <Text style={s.btnSecondaryText}>Reset Detection Settings</Text>
          </Pressable>

          <Text style={[s.sectionLabel, { marginTop: 8 }]}>Data</Text>
          <Pressable style={s.btnDanger} onPress={resetAllStats}>
            <Text style={s.btnDangerText}>Reset All Stats</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "games") {
    return withNav(
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <View style={s.topbarStatic}>
          <Text style={s.topbarTitleDark}>Games</Text>
        </View>
        <ScrollView contentContainerStyle={s.menuPad}>
          <Text style={s.subtitle}>
            Picking a game always walks you through a fresh net &amp; target setup first, so your
            targets are exactly where you want them each time.
          </Text>

          <Pressable style={s.btnSecondary} onPress={() => setScreen("highscores")}>
            <Text style={s.btnSecondaryText}>View High Scores</Text>
          </Pressable>

          <Card title={GAME_INFO.timeAttack.title}>
            <Text style={s.gameBlurb}>{GAME_INFO.timeAttack.blurb}</Text>
            <View style={s.durationRow}>
              {TIME_ATTACK_DURATIONS.map((d) => (
                <Pressable
                  key={d}
                  style={[s.durationChip, timeAttackDuration === d && s.durationChipActive]}
                  onPress={() => setTimeAttackDuration(d)}
                >
                  <Text style={[s.durationChipText, timeAttackDuration === d && s.durationChipTextActive]}>{d}s</Text>
                </Pressable>
              ))}
            </View>
            {highScores.timeAttack > 0 ? <Text style={s.metaLine}>Best: {highScores.timeAttack} on target</Text> : null}
            <Pressable style={s.btnPrimary} onPress={() => startGameFlow("timeAttack")}>
              <Text style={s.btnPrimaryText}>Play Time Attack</Text>
            </Pressable>
          </Card>

          <Card title={GAME_INFO.suddenDeath.title}>
            <Text style={s.gameBlurb}>{GAME_INFO.suddenDeath.blurb}</Text>
            {highScores.suddenDeath > 0 ? <Text style={s.metaLine}>Best streak: {highScores.suddenDeath}</Text> : null}
            <Pressable style={s.btnPrimary} onPress={() => startGameFlow("suddenDeath")}>
              <Text style={s.btnPrimaryText}>Play Sudden Death</Text>
            </Pressable>
          </Card>

          <Card title={GAME_INFO.perfect10.title}>
            <Text style={s.gameBlurb}>{GAME_INFO.perfect10.blurb}</Text>
            {bestPerfect10 > 0 ? <Text style={s.metaLine}>Best: {bestPerfect10}%</Text> : null}
            <Pressable style={s.btnPrimary} onPress={() => startGameFlow("perfect10")}>
              <Text style={s.btnPrimaryText}>Play Perfect 10</Text>
            </Pressable>
          </Card>

          <Card title={GAME_INFO.calledShot.title}>
            <Text style={s.gameBlurb}>{GAME_INFO.calledShot.blurb}</Text>
            {highScores.calledShot > 0 ? <Text style={s.metaLine}>Best: {highScores.calledShot} rounds</Text> : null}
            <Pressable style={s.btnPrimary} onPress={() => startGameFlow("calledShot")}>
              <Text style={s.btnPrimaryText}>Play Called Shot</Text>
            </Pressable>
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "highscores") {
    const rows = [
      { key: "timeAttack", label: "On Target Hits" },
      { key: "suddenDeath", label: "Longest Streak" },
      { key: "perfect10", label: "Best Accuracy" },
      { key: "calledShot", label: "Rounds Completed" },
    ];
    return withNav(
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <View style={s.topbarStatic}>
          <IconBtn label="<" onPress={() => setScreen("games")} />
          <Text style={s.topbarTitleDark}>High Scores</Text>
          <View style={{ width: 38 }} />
        </View>
        <ScrollView contentContainerStyle={s.menuPad}>
          {rows.map((r) => (
            <Card key={r.key} title={GAME_INFO[r.key].title}>
              <View style={s.summaryHero}>
                <Text style={s.summaryAccuracyMed}>
                  {highScores[r.key]}{r.key === "perfect10" ? "%" : ""}
                </Text>
                <Text style={s.centerMeta}>{r.label}</Text>
              </View>
            </Card>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === "game" && device && hasPermission) {
    const live = gameLive || {};
    const phase = live.phase || "armed";
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
            isActive={screen === "game" && !isPaused}
            pixelFormat="yuv"
            frameProcessor={autoDetectOn ? frameProcessor : undefined}
          />
          <Svg style={StyleSheet.absoluteFill}>
            <NetAndTargets netBox={netBox} targets={targets} w={layout.w} h={layout.h} flash={flash} />
          </Svg>

          <View style={s.hudTop}>
            <Text style={s.timerText}>{GAME_INFO[gameMode]?.title}</Text>
            <Text style={[s.autoStatus, autoDetectOn ? s.autoOn : s.autoOff]}>{autoStatusText}</Text>
          </View>

          {phase === "live" && gameMode === "timeAttack" ? (
            <View style={s.hudStats}>
              <Pill n={fmtMMSS(Math.ceil((live.remainingMs || 0) / 1000))} l="Time Left" c={C.cyan} />
              <Pill n={current?.onTarget ?? 0} l="On Target" c={C.green} />
              <Pill n={current?.missed ?? 0} l="Missed" c={C.crimson} />
            </View>
          ) : null}

          {phase === "live" && gameMode === "suddenDeath" ? (
            <View style={s.hudStats}>
              <Pill n={live.streak ?? 0} l="Streak" c={C.amber} />
              <Pill n={current?.totalShots ?? 0} l="Shots" c={C.ice} />
            </View>
          ) : null}

          {phase === "live" && gameMode === "perfect10" ? (
            <View style={s.hudStats}>
              <Pill n={`${live.shots ?? 0}/10`} l="Shots" c={C.ice} />
              <Pill n={`${pct(current?.onTarget ?? 0, current?.totalShots ?? 0)}%`} l="Accuracy" c={C.amber} />
            </View>
          ) : null}

          {phase === "live" && gameMode === "calledShot" ? (
            <View style={s.hudStats}>
              <Pill n={live.roundsCompleted ?? 0} l="Rounds" c={C.amber} />
              <Pill n={`${(((live.roundLimitMs ?? CALLED_SHOT_START_MS)) / 1000).toFixed(1)}s`} l="Round Limit" c={C.cyan} />
            </View>
          ) : null}

          {phase === "live" && gameMode === "calledShot" && live.calledIndex != null ? (
            <View style={s.calledShotOverlay} pointerEvents="none">
              <Text style={s.calledShotBig}>{live.calledIndex + 1}</Text>
              <View style={s.calledShotBarTrack}>
                <View
                  style={[
                    s.calledShotBarFill,
                    { width: `${Math.max(0, Math.min(100, ((live.roundRemainingMs || 0) / (live.roundLimitMs || 1)) * 100))}%` },
                  ]}
                />
              </View>
            </View>
          ) : null}

          {(phase === "armed" || phase === "countdown") ? (
            <View style={s.armedOverlay} pointerEvents="box-none">
              {phase === "armed" ? (
                <>
                  <Text style={s.armedTitle}>Ready when you are</Text>
                  <Text style={s.armedCopy}>Auto-detect is watching the net. Say "start" or tap below to begin.</Text>
                  <Pressable style={s.startBtn} onPress={startCountdown}>
                    <Text style={s.startBtnText}>Start</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={s.countdownBig}>{live.count}</Text>
              )}
            </View>
          ) : null}

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

            {phase === "live" ? (
              gameMode === "calledShot" ? (
                <View style={s.calledShotBtnGrid}>
                  {targets.map((t, i) => (
                    <Pressable key={i} style={s.calledShotNumBtn} onPress={() => registerCalledShotTarget(i)}>
                      <Text style={s.calledShotNumBtnText}>{i + 1}</Text>
                    </Pressable>
                  ))}
                  <Pressable style={s.shotBtnMiss} onPress={registerCalledShotMiss}>
                    <Text style={s.shotBtnText}>Miss</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={s.shotBtns}>
                  <Pressable style={s.shotBtnOn} onPress={() => registerShot(true)}>
                    <Text style={s.shotBtnText}>Manual: On Target</Text>
                  </Pressable>
                  <Pressable style={s.shotBtnMiss} onPress={() => registerShot(false)}>
                    <Text style={s.shotBtnText}>Manual: Missed</Text>
                  </Pressable>
                </View>
              )
            ) : null}

            <View style={s.rowBtns}>
              {phase === "live" ? (
                <Pressable style={s.pauseBtn} onPress={isPaused ? resumeGame : pauseGame}>
                  <Text style={s.btnSecondaryText}>{isPaused ? "Resume" : "Pause"}</Text>
                </Pressable>
              ) : null}
              <Pressable style={[s.btnSecondary, s.flexOne]} onPress={() => setPendingGameEnd({ reason: "quit" })}>
                <Text style={s.btnSecondaryText}>End Game</Text>
              </Pressable>
            </View>
          </View>

          {isPaused ? (
            <View style={s.pausedBanner}>
              <Text style={s.pausedTitle}>Paused</Text>
              <Text style={s.pausedCopy}>Say "resume" or tap below.</Text>
              <Pressable style={s.btnPrimaryWide} onPress={resumeGame}>
                <Text style={s.btnPrimaryText}>Resume Game</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  if (screen === "gameSummary" && gameSummaryRec) {
    const rec = gameSummaryRec;
    const info = GAME_INFO[rec.gameMode];
    return (
      <SafeAreaView style={s.root}>
        <ExpoStatusBar style="light" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Brand title={info ? info.title : "Game Complete"} />
          <Card>
            <View style={s.summaryHero}>
              <Text style={s.summaryAccuracy}>
                {rec.gameMode === "perfect10" ? `${rec.gameScore}%` : rec.gameScore}
              </Text>
              <Text style={s.centerMeta}>
                {rec.gameMode === "timeAttack" && "On Target Hits"}
                {rec.gameMode === "suddenDeath" && "Final Streak"}
                {rec.gameMode === "perfect10" && "Accuracy"}
                {rec.gameMode === "calledShot" && "Rounds Completed"}
              </Text>
            </View>
          </Card>
          <Card>
            <View style={s.statRow}>
              <Stat n={rec.totalShots} l="Total Shots" c={C.amber} />
              <Stat n={rec.onTarget} l="On Target" c={C.green} />
              <Stat n={rec.missed} l="Missed" c={C.crimson} />
            </View>
          </Card>
          <Card>
            <View style={s.statRow}>
              <Stat n={fmtMMSS(rec.duration)} l="Session Time" c={C.cyan} />
              <Stat n={pct(rec.onTarget, rec.totalShots)} l="Accuracy %" c={C.ice} />
            </View>
          </Card>
          <Pressable style={s.btnSecondary} onPress={() => shareStats(rec)}>
            <Text style={s.btnSecondaryText}>Share This Result</Text>
          </Pressable>
          <Pressable style={s.btnPrimary} onPress={() => startGameFlow(rec.gameMode)}>
            <Text style={s.btnPrimaryText}>Play Again</Text>
          </Pressable>
          <Pressable style={s.btnSecondary} onPress={() => setScreen("games")}>
            <Text style={s.btnSecondaryText}>Back to Games</Text>
          </Pressable>
          <Pressable style={s.btnSecondary} onPress={() => setScreen("menu")}>
            <Text style={s.btnSecondaryText}>Back to Main Menu</Text>
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

function NavIcon({ shape, active }) {
  const color = active ? C.amber : C.steel;
  if (shape === "menu") {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Rect x={3} y={5} width={18} height={2.4} rx={1.2} fill={color} />
        <Rect x={3} y={10.8} width={18} height={2.4} rx={1.2} fill={color} />
        <Rect x={3} y={16.6} width={18} height={2.4} rx={1.2} fill={color} />
      </Svg>
    );
  }
  if (shape === "games") {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9} fill="none" stroke={color} strokeWidth={2} />
        <Circle cx={12} cy={12} r={3.2} fill={color} />
      </Svg>
    );
  }
  if (shape === "sessions") {
    return (
      <Svg width={22} height={22} viewBox="0 0 24 24">
        <Circle cx={12} cy={12} r={9} fill="none" stroke={color} strokeWidth={2} />
        <Rect x={11} y={7} width={2} height={6} rx={1} fill={color} />
        <Rect x={11} y={12} width={5} height={2} rx={1} fill={color} />
      </Svg>
    );
  }
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={3.4} fill="none" stroke={color} strokeWidth={2} />
      <Circle cx={12} cy={4.5} r={1.6} fill={color} />
      <Circle cx={12} cy={19.5} r={1.6} fill={color} />
      <Circle cx={4.5} cy={12} r={1.6} fill={color} />
      <Circle cx={19.5} cy={12} r={1.6} fill={color} />
    </Svg>
  );
}

function BottomNav({ active, onNavigate }) {
  const tabs = [
    { key: "menu", label: "Main Menu", shape: "menu" },
    { key: "games", label: "Games", shape: "games" },
    { key: "sessions", label: "History", shape: "sessions" },
    { key: "settings", label: "Settings", shape: "settings" },
  ];
  const activeTab = active === "highscores" ? "games" : active;
  if (!SCREENS_WITH_NAV.includes(active)) return null;
  return (
    <SafeAreaView style={s.navSafe} edges={["bottom"]}>
      <View style={s.navBar}>
        {tabs.map((t) => {
          const isActive = t.key === activeTab;
          return (
            <Pressable key={t.key} style={s.navItem} onPress={() => onNavigate(t.key)}>
              <NavIcon shape={t.shape} active={isActive} />
              <Text style={[s.navLabel, isActive && s.navLabelActive]}>{t.label}</Text>
              {isActive ? <View style={s.navDot} /> : null}
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function NetAndTargets({ netBox, targets, w, h, showLabels, flash }) {
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
        const radius = ((t.radius || DEFAULT_TARGET_RADIUS) / REF_WIDTH) * w;
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

function DraggableTarget({ target, index, w, h, selected, onSelect, onDrag }) {
  const stateRef = useRef({ target, index, w, h, onSelect, onDrag });
  stateRef.current = { target, index, w, h, onSelect, onDrag };
  const startRef = useRef({ x: 0, y: 0 });

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        const { target: t, w: ww, h: hh, index: idx, onSelect: sel } = stateRef.current;
        startRef.current = { x: t.x * ww, y: t.y * hh };
        sel(idx);
      },
      onPanResponderMove: (_evt, gesture) => {
        const { w: ww, h: hh, index: idx, onDrag: drag } = stateRef.current;
        const nx = Math.max(0, Math.min(1, (startRef.current.x + gesture.dx) / ww));
        const ny = Math.max(0, Math.min(1, (startRef.current.y + gesture.dy) / hh));
        drag(idx, nx, ny);
      },
    })
  ).current;

  const radius = ((target.radius || DEFAULT_TARGET_RADIUS) / REF_WIDTH) * w;
  const size = radius * 2;

  return (
    <View
      {...pan.panHandlers}
      style={[
        s.dragTarget,
        {
          left: target.x * w - radius,
          top: target.y * h - radius,
          width: size,
          height: size,
          borderRadius: radius,
          borderColor: selected ? C.cyan : C.amber,
          backgroundColor: selected ? "rgba(79,182,199,0.15)" : "rgba(226,166,59,0.08)",
        },
      ]}
    >
      <Text style={s.dragTargetLabel}>{index + 1}</Text>
    </View>
  );
}

function SettingSlider({ label, hint, value, min, max, step, format, onChange }) {
  return (
    <Card>
      <View style={s.sliderHeader}>
        <Text style={s.settingLabel}>{label}</Text>
        <Text style={s.sliderValue}>{format(value)}</Text>
      </View>
      <Slider
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        minimumTrackTintColor={C.amber}
        maximumTrackTintColor={C.line}
        thumbTintColor={C.amber}
        onValueChange={onChange}
      />
      <Text style={s.settingHint}>{hint}</Text>
    </Card>
  );
}

const TUTORIAL_STEPS = [
  {
    title: "Welcome to Net Sniper",
    body: "Track your shooting accuracy using your phone's camera. Here's a quick rundown before your first session.",
  },
  {
    title: "1. Set Up Your Net",
    body: "Before every session or game, tap the top-left then bottom-right corner of your net opening to mark the area the camera should watch.",
  },
  {
    title: "2. Place Targets",
    body: "Tap inside the net to drop target zones. Drag any target to move it, or tap one to resize it individually.",
  },
  {
    title: "3. Shoot",
    body: "In a free session, turn on Auto-Detect and the app watches for pucks entering the net. In games, auto-detect is on by default - say \"start\" or tap Start to begin the countdown, and say \"pause\" any time to freeze the clock.",
  },
  {
    title: "4. Build a Streak",
    body: "Take at least 5 shots in a session before midnight (your local time) to keep your daily streak alive. Miss a day and it resets.",
  },
];

function TutorialOverlay({ step, setStep, onDone }) {
  const info = TUTORIAL_STEPS[step];
  const isLast = step === TUTORIAL_STEPS.length - 1;
  return (
    <Modal transparent animationType="fade" visible>
      <View style={s.tutorialBackdrop}>
        <View style={s.tutorialCard}>
          <Text style={s.tutorialTitle}>{info.title}</Text>
          <Text style={s.tutorialBody}>{info.body}</Text>
          <View style={s.tutorialDots}>
            {TUTORIAL_STEPS.map((_, i) => (
              <View key={i} style={[s.tutorialDot, i === step && s.tutorialDotActive]} />
            ))}
          </View>
          <View style={s.rowBtns}>
            {step > 0 ? (
              <Pressable style={[s.btnSecondary, s.flexOne]} onPress={() => setStep((v) => v - 1)}>
                <Text style={s.btnSecondaryText}>Back</Text>
              </Pressable>
            ) : (
              <Pressable style={[s.btnSecondary, s.flexOne]} onPress={onDone}>
                <Text style={s.btnSecondaryText}>Skip</Text>
              </Pressable>
            )}
            <Pressable
              style={[s.btnPrimary, s.flexOne]}
              onPress={() => (isLast ? onDone() : setStep((v) => v + 1))}
            >
              <Text style={s.btnPrimaryText}>{isLast ? "Got It" : "Next"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.arena },
  cameraRoot: { flex: 1, backgroundColor: "#000" },
  cameraFill: { flex: 1 },
  center: { justifyContent: "center", alignItems: "center", gap: 14, padding: 30 },
  menuPad: { paddingHorizontal: 20, paddingTop: 26, paddingBottom: 110, gap: 16 },
  brand: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: -4 },
  brandTitle: { color: C.ice, fontSize: 34, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  subtitle: { color: C.steel, fontSize: 13, marginTop: -6, marginBottom: 6, lineHeight: 19 },
  sectionLabel: { color: C.amber, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1.4, marginTop: 4, marginBottom: -6 },
  card: {
    position: "relative",
    backgroundColor: C.slate2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.line,
    padding: 18,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 3,
  },
  cardAccent: { position: "absolute", top: 0, left: 18, right: 70, height: 3, backgroundColor: C.amber, borderBottomRightRadius: 2 },
  cardHeader: { color: C.steel, fontSize: 11, letterSpacing: 1.2, fontWeight: "700", textTransform: "uppercase", marginBottom: 14 },
  statRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  stat: { flex: 1, alignItems: "center" },
  statNum: { fontSize: 24, fontWeight: "700" },
  statLbl: { color: C.steel, fontSize: 10.5, marginTop: 4, textTransform: "uppercase", textAlign: "center" },
  empty: { color: C.steel, fontSize: 14, textAlign: "center", paddingVertical: 10 },
  metaLine: { color: C.steel, fontSize: 12, marginTop: 12, textAlign: "center" },
  metaTag: { color: C.violet, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  centerMeta: { color: C.steel, fontSize: 11, textAlign: "center", textTransform: "uppercase", letterSpacing: 1.2 },
  careerAccuracy: { color: C.cyan, fontSize: 28, fontWeight: "700", textAlign: "center", marginTop: 14 },
  cameraIcon: { color: C.amber, fontSize: 28, fontWeight: "700" },
  errorText: { color: C.steel, textAlign: "center", fontSize: 15, lineHeight: 22 },
  btnPrimary: { backgroundColor: C.amber, borderRadius: 14, padding: 18, alignItems: "center" },
  btnPrimaryWide: { backgroundColor: C.amber, borderRadius: 14, padding: 18, alignItems: "center", minWidth: 220 },
  btnPrimaryText: { color: "#1a1204", fontWeight: "800", fontSize: 16, letterSpacing: 0.3 },
  btnSecondary: { backgroundColor: C.slate2, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 16, alignItems: "center" },
  btnSecondaryText: { color: C.ice, fontWeight: "700", fontSize: 14 },
  btnDanger: { backgroundColor: "rgba(209,73,91,0.12)", borderColor: "rgba(209,73,91,0.5)", borderWidth: 1, borderRadius: 14, padding: 16, alignItems: "center" },
  btnDangerText: { color: C.crimson, fontWeight: "800", fontSize: 14 },
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
  armedOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 18, backgroundColor: "rgba(6,10,15,0.55)", padding: 30 },
  armedTitle: { color: C.ice, fontSize: 26, fontWeight: "800", textAlign: "center" },
  armedCopy: { color: C.steel, fontSize: 14, textAlign: "center", lineHeight: 20, maxWidth: 300 },
  startBtn: { backgroundColor: C.amber, borderRadius: 40, paddingVertical: 20, paddingHorizontal: 56, marginTop: 6 },
  startBtnText: { color: "#1a1204", fontWeight: "800", fontSize: 20, letterSpacing: 1 },
  countdownBig: { color: C.amber, fontSize: 160, fontWeight: "800", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 16 },
  summaryHero: { alignItems: "center", paddingVertical: 4 },
  summaryAccuracy: { color: C.amber, fontSize: 50, fontWeight: "700" },
  summaryAccuracyMed: { color: C.amber, fontSize: 34, fontWeight: "800" },
  streakBanner: { backgroundColor: "rgba(226,166,59,0.14)", borderColor: "rgba(226,166,59,0.4)", borderWidth: 1, borderRadius: 12, paddingVertical: 10, alignItems: "center" },
  streakText: { color: C.amber, fontWeight: "700", fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5 },
  shareLink: { marginTop: 14, alignItems: "center", paddingVertical: 6 },
  shareLinkText: { color: C.cyan, fontWeight: "700", fontSize: 12.5, textTransform: "uppercase", letterSpacing: 0.5 },
  topbarStatic: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  topbarTitleDark: { color: C.ice, fontSize: 17, fontWeight: "800", flex: 1, textAlign: "center", textTransform: "uppercase", letterSpacing: 0.4 },
  sessionRowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  sessionRowDate: { color: C.steel, fontSize: 12 },
  sessionRowAccuracy: { color: C.amber, fontSize: 16, fontWeight: "700" },
  dragTarget: {
    position: "absolute",
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  dragTargetLabel: { color: C.ice, fontWeight: "700", fontSize: 13 },
  settingLabel: { color: C.ice, fontSize: 13, fontWeight: "700", flex: 1, paddingRight: 8 },
  settingHint: { color: C.steel, fontSize: 11, marginTop: 8 },
  tutorialBackdrop: { flex: 1, backgroundColor: "rgba(6,10,15,0.82)", alignItems: "center", justifyContent: "center", padding: 24 },
  tutorialCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: C.slate2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.line,
    padding: 22,
    gap: 14,
  },
  tutorialTitle: { color: C.amber, fontSize: 20, fontWeight: "700" },
  tutorialBody: { color: C.ice, fontSize: 14.5, lineHeight: 21 },
  tutorialDots: { flexDirection: "row", justifyContent: "center", gap: 6 },
  tutorialDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.line },
  tutorialDotActive: { backgroundColor: C.amber },
  gameBlurb: { color: C.steel, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  durationRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  durationChip: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 10, alignItems: "center", backgroundColor: C.slate },
  durationChipActive: { borderColor: C.amber, backgroundColor: "rgba(226,166,59,0.15)" },
  durationChipText: { color: C.steel, fontWeight: "700", fontSize: 13 },
  durationChipTextActive: { color: C.amber },
  calledShotOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 16 },
  calledShotBig: { color: C.amber, fontSize: 140, fontWeight: "700", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 12 },
  calledShotBarTrack: { width: "60%", height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.15)", overflow: "hidden" },
  calledShotBarFill: { height: "100%", backgroundColor: C.cyan },
  calledShotBtnGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  calledShotNumBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.amber, alignItems: "center", justifyContent: "center" },
  calledShotNumBtnText: { color: "#1a1204", fontWeight: "700", fontSize: 18 },
  navSafe: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: C.slate },
  navBar: {
    flexDirection: "row",
    backgroundColor: C.slate,
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 6,
  },
  navItem: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 2 },
  navLabel: { color: C.steel, fontSize: 10.5, fontWeight: "700" },
  navLabelActive: { color: C.amber },
  navDot: { position: "absolute", top: -10, width: 18, height: 3, borderRadius: 2, backgroundColor: C.amber },
});
