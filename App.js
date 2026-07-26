import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, Pressable, ScrollView, StatusBar, Alert,
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Circle, Rect } from "react-native-svg";
import {
  Camera, useCameraDevice, useCameraPermission,
} from "react-native-vision-camera";

// ---------- palette (matches the web version) ----------
const C = {
  arena: "#0A121C", slate: "#121F2C", slate2: "#182838",
  ice: "#E9F2F6", steel: "#7E93A6", line: "#223243",
  amber: "#E2A63B", cyan: "#4FB6C7", green: "#4CAE7C", crimson: "#D1495B",
};

const K_TOTALS = "netsniper:totals";
const K_LATEST = "netsniper:latest";
const K_SESSIONS = "netsniper:sessions";

function pct(on, total) { return total ? Math.round((on / total) * 100) : 0; }
function fmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
}

export default function App() {
  const [screen, setScreen] = useState("menu");
  const [totals, setTotals] = useState({ totalShots: 0, onTarget: 0, missed: 0 });
  const [latest, setLatest] = useState(null);
  const [sessionsLog, setSessionsLog] = useState([]);

  const [facing, setFacing] = useState("back");
  const [netBox, setNetBox] = useState(null); // {x1,y1,x2,y2} normalized 0-1
  const [setupStage, setSetupStage] = useState("netcorner1");
  const [targets, setTargets] = useState([]); // [{x,y}] normalized
  const [layout, setLayout] = useState({ w: 1, h: 1 });

  const [current, setCurrent] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [summaryRec, setSummaryRec] = useState(null);
  const [flash, setFlash] = useState(null);

  const timerRef = useRef(null);
  const pauseStartRef = useRef(0);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice(facing === "back" ? "back" : "front");
  // useCameraFormat balances several criteria (resolution match, photo size,
  // etc.) and doesn't reliably just pick "max fps" — so instead we scan
  // device.formats ourselves and explicitly pick the format with the highest
  // maxFps among the low-resolution options (phones only unlock their
  // 120/240fps sensor modes at reduced resolution).
  const format = React.useMemo(() => {
    if (!device || !device.formats || device.formats.length === 0) return undefined;
    const small = device.formats.filter((f) => f.videoWidth <= 1280 && f.videoHeight <= 720);
    const pool = small.length ? small : device.formats;
    return pool.reduce((best, f) => {
      if (!best) return f;
      const fMax = f.maxFps ?? 0, bestMax = best.maxFps ?? 0;
      if (fMax > bestMax) return f;
      if (fMax === bestMax && f.videoWidth * f.videoHeight < best.videoWidth * best.videoHeight) return f;
      return best;
    }, undefined);
  }, [device]);
  const maxFps = format?.maxFps ?? null;

  useEffect(() => {
    if (device && format) {
      console.log(
        "Selected format:", format.videoWidth + "x" + format.videoHeight,
        "| maxFps:", format.maxFps,
        "| total formats available:", device.formats?.length
      );
    }
  }, [device, format]);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem(K_TOTALS);
      const l = await AsyncStorage.getItem(K_LATEST);
      const s = await AsyncStorage.getItem(K_SESSIONS);
      if (t) setTotals(JSON.parse(t));
      if (l) setLatest(JSON.parse(l));
      if (s) setSessionsLog(JSON.parse(s));
    })();
  }, []);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission]);

  // ---------- setup screen tap handling ----------
  const onSetupTap = useCallback((evt) => {
    const { locationX, locationY } = evt.nativeEvent;
    const x = locationX / layout.w, y = locationY / layout.h;
    if (setupStage === "netcorner1") {
      setNetBox({ x1: x, y1: y });
      setSetupStage("netcorner2");
    } else if (setupStage === "netcorner2") {
      setNetBox((nb) => ({ ...nb, x2: x, y2: y }));
      setSetupStage("targets");
    } else {
      setTargets((ts) => [...ts, { x, y }]);
    }
  }, [layout, setupStage]);

  function resetSetup() {
    setNetBox(null); setTargets([]); setSetupStage("netcorner1");
  }

  function undoSetup() {
    if (setupStage === "targets" && targets.length > 0) {
      setTargets((ts) => ts.slice(0, -1));
    } else if (setupStage === "targets" && targets.length === 0) {
      setNetBox((nb) => ({ x1: nb.x1, y1: nb.y1 }));
      setSetupStage("netcorner2");
    } else if (setupStage === "netcorner2") {
      setNetBox(null); setSetupStage("netcorner1");
    }
  }

  function beginSession() {
    setCurrent({ totalShots: 0, onTarget: 0, missed: 0, startTime: Date.now(), pausedAccum: 0 });
    setIsPaused(false);
    setElapsed(0);
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
    pauseStartRef.current = Date.now();
  }
  function resumeSession() {
    setCurrent((cur) => ({ ...cur, pausedAccum: cur.pausedAccum + (Date.now() - pauseStartRef.current) }));
    setIsPaused(false);
  }

  async function finishSession() {
    if (timerRef.current) clearInterval(timerRef.current);
    const duration = (Date.now() - current.startTime - current.pausedAccum) / 1000;
    const rec = {
      totalShots: current.totalShots, onTarget: current.onTarget, missed: current.missed,
      duration, targetsUsed: targets.length, date: Date.now(),
    };
    const newTotals = {
      totalShots: totals.totalShots + rec.totalShots,
      onTarget: totals.onTarget + rec.onTarget,
      missed: totals.missed + rec.missed,
    };
    const newLog = [...sessionsLog, rec].slice(-100);
    setTotals(newTotals); setLatest(rec); setSessionsLog(newLog);
    await AsyncStorage.setItem(K_TOTALS, JSON.stringify(newTotals));
    await AsyncStorage.setItem(K_LATEST, JSON.stringify(rec));
    await AsyncStorage.setItem(K_SESSIONS, JSON.stringify(newLog));
    setSummaryRec(rec);
    setScreen("summary");
  }

  async function resetAllStats() {
    Alert.alert("Reset all-time stats?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset", style: "destructive", onPress: async () => {
          setTotals({ totalShots: 0, onTarget: 0, missed: 0 });
          setLatest(null); setSessionsLog([]);
          await AsyncStorage.multiRemove([K_TOTALS, K_LATEST, K_SESSIONS]);
        },
      },
    ]);
  }

  // ---------------- render: MENU ----------------
  if (screen === "menu") {
    return (
      <View style={s.root}>
        <ExpoStatusBar style="light" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Text style={s.brandTitle}>NET SNIPER</Text>
          <Text style={s.subtitle}>Track your shooting accuracy, one puck at a time.</Text>

          <View style={s.card}>
            <Text style={s.cardHeader}>— LATEST SESSION</Text>
            {!latest ? (
              <Text style={s.empty}>No sessions yet — take your first shot!</Text>
            ) : (
              <View>
                <View style={s.statRow}>
                  <Stat n={latest.totalShots} l="Total Shots" c={C.amber} />
                  <Stat n={latest.onTarget} l="On Target" c={C.green} />
                  <Stat n={latest.missed} l="Missed" c={C.crimson} />
                </View>
                <Text style={s.metaLine}>
                  Accuracy: {pct(latest.onTarget, latest.totalShots)}% · {fmtMMSS(latest.duration)}
                </Text>
              </View>
            )}
          </View>

          <View style={s.card}>
            <Text style={s.cardHeader}>— ALL-TIME STATS</Text>
            <View style={s.statRow}>
              <Stat n={totals.totalShots} l="Total Shots" c={C.amber} />
              <Stat n={totals.onTarget} l="On Target" c={C.green} />
              <Stat n={totals.missed} l="Missed" c={C.crimson} />
            </View>
            <Text style={[s.bigStat, { textAlign: "center", marginTop: 14 }]}>
              {pct(totals.onTarget, totals.totalShots)}%
            </Text>
            <Text style={s.metaLine}>Career Accuracy</Text>
          </View>

          {maxFps ? (
            <Text style={[s.metaLine, { textAlign: "center" }]}>
              Camera ready — up to {Math.round(maxFps)} fps on this device
            </Text>
          ) : null}

          <Pressable style={s.btnPrimary} onPress={() => { resetSetup(); setScreen("setup"); }}>
            <Text style={s.btnPrimaryText}>🥅 Start Shooting Session</Text>
          </Pressable>
          <Pressable style={s.btnSecondary} onPress={resetAllStats}>
            <Text style={s.btnSecondaryText}>Reset All Stats</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // ---------------- render: camera unavailable ----------------
  if (!device || !hasPermission) {
    return (
      <View style={[s.root, s.center]}>
        <ExpoStatusBar style="light" />
        <Text style={{ fontSize: 40 }}>📷</Text>
        <Text style={s.errorText}>
          {!hasPermission
            ? "Camera permission is needed.\nGrant access in Settings, then reopen the app."
            : "No camera device found."}
        </Text>
        <Pressable style={s.btnSecondary} onPress={requestPermission}>
          <Text style={s.btnSecondaryText}>Grant Camera Access</Text>
        </Pressable>
        <Pressable style={s.btnSecondary} onPress={() => setScreen("menu")}>
          <Text style={s.btnSecondaryText}>Back to Menu</Text>
        </Pressable>
      </View>
    );
  }

  // ---------------- render: SETUP ----------------
  if (screen === "setup") {
    const hint =
      setupStage === "netcorner1" ? "Step 1: Tap the TOP-LEFT corner of your net opening." :
      setupStage === "netcorner2" ? "Step 2: Tap the BOTTOM-RIGHT corner of your net opening." :
      `${targets.length} target(s) placed. Tap to add more, or begin session.`;

    return (
      <View style={s.root}>
        <ExpoStatusBar style="light" />
        <Pressable
          style={{ flex: 1 }}
          onLayout={(e) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          onPress={onSetupTap}
        >
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            fps={maxFps ? Math.round(maxFps) : undefined}
            isActive={screen === "setup"}
          />
          <Svg style={StyleSheet.absoluteFill}>
            <NetAndTargets netBox={netBox} targets={targets} w={layout.w} h={layout.h} />
          </Svg>

          <View style={s.topbar}>
            <IconBtn label="←" onPress={() => setScreen("menu")} />
            <Text style={s.topbarTitle}>Set Up Net & Targets</Text>
            <IconBtn label="🔄" onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))} />
            <IconBtn label="✕" onPress={resetSetup} />
          </View>

          <View style={s.fpsPillWrap}>
            <Text style={s.fpsPillText}>
              📹 {maxFps ? `up to ${Math.round(maxFps)} fps` : device ? "detecting fps…" : "no camera device"}
            </Text>
          </View>

          <View style={s.bottomPanel} pointerEvents="box-none">
            <Text style={s.hint}>{hint}</Text>
            <View style={s.rowBtns}>
              <Pressable style={[s.btnSecondary, { flex: 1 }]} onPress={undoSetup}>
                <Text style={s.btnSecondaryText}>Undo</Text>
              </Pressable>
              <Pressable
                style={[s.btnPrimary, { flex: 1, opacity: targets.length === 0 || setupStage !== "targets" ? 0.4 : 1 }]}
                disabled={targets.length === 0 || setupStage !== "targets"}
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

  // ---------------- render: SESSION ----------------
  if (screen === "session") {
    return (
      <View style={s.root}>
        <ExpoStatusBar style="light" />
        <View style={{ flex: 1 }} onLayout={(e) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            fps={maxFps ? Math.round(maxFps) : undefined}
            isActive={screen === "session" && !isPaused}
          />
          <Svg style={StyleSheet.absoluteFill}>
            <NetAndTargets netBox={netBox} targets={targets} w={layout.w} h={layout.h} flash={flash} />
          </Svg>

          <View style={s.hudTop}>
            <Text style={s.timerText}>{fmtMMSS(elapsed)}</Text>
            {maxFps ? <Text style={s.fpsPillText}>{Math.round(maxFps)} fps</Text> : <Text style={s.fpsPillText}>fps: n/a</Text>}
          </View>
          <View style={s.hudStats}>
            <Pill n={current?.totalShots ?? 0} l="Shots" c={C.ice} />
            <Pill n={current?.onTarget ?? 0} l="On Target" c={C.green} />
            <Pill n={current?.missed ?? 0} l="Missed" c={C.crimson} />
          </View>

          <View style={s.hudBottom}>
            <View style={s.shotBtns}>
              <Pressable style={s.shotBtnOn} onPress={() => registerShot(true)}>
                <Text style={s.shotEmoji}>🎯</Text>
                <Text style={s.shotBtnText}>On Target</Text>
              </Pressable>
              <Pressable style={s.shotBtnMiss} onPress={() => registerShot(false)}>
                <Text style={s.shotEmoji}>❌</Text>
                <Text style={s.shotBtnText}>Missed</Text>
              </Pressable>
            </View>
            <View style={s.rowBtns}>
              <Pressable style={s.pauseBtn} onPress={isPaused ? resumeSession : pauseSession}>
                <Text style={s.btnSecondaryText}>{isPaused ? "▶ Resume" : "⏸ Pause"}</Text>
              </Pressable>
              <Pressable style={[s.btnSecondary, { flex: 1 }]} onPress={finishSession}>
                <Text style={s.btnSecondaryText}>🏁 Finish</Text>
              </Pressable>
            </View>
          </View>

          {isPaused ? (
            <View style={s.pausedBanner}>
              <Text style={s.pausedTitle}>⏸ Paused</Text>
              <Pressable style={s.btnPrimary} onPress={resumeSession}>
                <Text style={s.btnPrimaryText}>▶ Resume Session</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  // ---------------- render: SUMMARY ----------------
  if (screen === "summary" && summaryRec) {
    const rec = summaryRec;
    return (
      <View style={s.root}>
        <ExpoStatusBar style="light" />
        <ScrollView contentContainerStyle={s.menuPad}>
          <Text style={s.brandTitle}>SESSION COMPLETE</Text>
          <View style={[s.card, { alignItems: "center", paddingVertical: 22 }]}>
            <Text style={[s.bigStat, { fontSize: 50 }]}>{pct(rec.onTarget, rec.totalShots)}%</Text>
            <Text style={s.metaLine}>— ACCURACY</Text>
          </View>
          <View style={s.card}>
            <View style={s.statRow}>
              <Stat n={rec.totalShots} l="Total Shots" c={C.amber} />
              <Stat n={rec.onTarget} l="On Target" c={C.green} />
              <Stat n={rec.missed} l="Missed" c={C.crimson} />
            </View>
          </View>
          <View style={s.card}>
            <View style={s.statRow}>
              <Stat n={fmtMMSS(rec.duration)} l="Session Time" c={C.cyan} />
              <Stat n={rec.targetsUsed} l="Targets Used" c={C.ice} />
            </View>
          </View>
          <Pressable style={s.btnPrimary} onPress={() => setScreen("menu")}>
            <Text style={s.btnPrimaryText}>Back to Main Menu</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  return null;
}

// ---------- small subcomponents ----------
function Stat({ n, l, c }) {
  return (
    <View style={{ flex: 1, alignItems: "center" }}>
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
      <Text style={{ color: C.ice, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}
function NetAndTargets({ netBox, targets, w, h, flash }) {
  return (
    <>
      {netBox && netBox.x2 !== undefined ? (
        <Rect
          x={Math.min(netBox.x1, netBox.x2) * w}
          y={Math.min(netBox.y1, netBox.y2) * h}
          width={Math.abs(netBox.x2 - netBox.x1) * w}
          height={Math.abs(netBox.y2 - netBox.y1) * h}
          fill="rgba(79,182,199,0.08)" stroke={C.cyan} strokeWidth={2} strokeDasharray="6 5"
        />
      ) : netBox ? (
        <Circle cx={netBox.x1 * w} cy={netBox.y1 * h} r={8} fill={C.cyan} />
      ) : null}
      {targets.map((t, i) => (
        <React.Fragment key={i}>
          <Circle cx={t.x * w} cy={t.y * h} r={34} fill="none" stroke={C.amber} strokeWidth={3} opacity={0.9} />
          <Circle cx={t.x * w} cy={t.y * h} r={12} fill="none" stroke={C.ice} strokeWidth={1.5} opacity={0.7} />
        </React.Fragment>
      ))}
      {flash ? (
        <Circle
          cx={w / 2} cy={h / 2} r={9999}
          fill={flash.hit ? "rgba(76,174,124,0.15)" : "rgba(209,73,91,0.15)"}
        />
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.arena },
  center: { justifyContent: "center", alignItems: "center", gap: 14, padding: 30 },
  menuPad: { padding: 20, paddingTop: 50, gap: 16 },
  brandTitle: { color: C.ice, fontSize: 32, fontWeight: "700", letterSpacing: 0.5 },
  subtitle: { color: C.steel, fontSize: 13, marginTop: -8 },
  card: {
    backgroundColor: C.slate2, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: C.line,
  },
  cardHeader: { color: C.steel, fontSize: 11, letterSpacing: 1.2, fontWeight: "700", marginBottom: 12 },
  statRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  statNum: { fontSize: 24, fontWeight: "700" },
  statLbl: { color: C.steel, fontSize: 10.5, marginTop: 4, textTransform: "uppercase" },
  bigStat: { color: C.amber, fontSize: 28, fontWeight: "700" },
  metaLine: { color: C.steel, fontSize: 12, marginTop: 12 },
  empty: { color: C.steel, fontSize: 14, textAlign: "center", paddingVertical: 10 },
  errorText: { color: C.steel, textAlign: "center", fontSize: 15, lineHeight: 22 },
  btnPrimary: {
    backgroundColor: C.amber, borderRadius: 12, padding: 18, alignItems: "center",
  },
  btnPrimaryText: { color: "#1a1204", fontWeight: "700", fontSize: 16 },
  btnSecondary: {
    backgroundColor: C.slate2, borderColor: C.line, borderWidth: 1, borderRadius: 12,
    padding: 16, alignItems: "center",
  },
  btnSecondaryText: { color: C.ice, fontWeight: "700", fontSize: 14 },
  pauseBtn: {
    flex: 1, backgroundColor: "#243342", borderRadius: 12, padding: 16, alignItems: "center",
  },
  topbar: {
    position: "absolute", top: 50, left: 0, right: 0, flexDirection: "row",
    justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, gap: 8,
  },
  topbarTitle: { color: C.ice, fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center", justifyContent: "center",
  },
  fpsPillWrap: {
    position: "absolute", top: 100, left: 0, right: 0, alignItems: "center",
  },
  fpsPillText: {
    color: C.green, backgroundColor: "rgba(15,22,30,0.85)", borderColor: C.line, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 18, fontSize: 12, fontWeight: "700",
    overflow: "hidden",
  },
  bottomPanel: {
    position: "absolute", left: 0, right: 0, bottom: 40, paddingHorizontal: 16, gap: 10,
  },
  hint: {
    color: C.ice, fontSize: 13, textAlign: "center", backgroundColor: "rgba(0,0,0,0.45)",
    padding: 9, borderRadius: 10,
  },
  rowBtns: { flexDirection: "row", gap: 10 },
  hudTop: {
    position: "absolute", top: 50, left: 0, right: 0, flexDirection: "row",
    justifyContent: "space-between", paddingHorizontal: 16,
  },
  timerText: {
    color: C.ice, fontWeight: "700", fontSize: 16.5, backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, overflow: "hidden",
  },
  hudStats: { position: "absolute", top: 100, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 8, paddingHorizontal: 14 },
  pill: {
    backgroundColor: "rgba(13,20,28,0.8)", borderColor: C.line, borderWidth: 1, borderRadius: 12,
    padding: 8, alignItems: "center", flex: 1, maxWidth: 110,
  },
  pillN: { fontSize: 18, fontWeight: "700" },
  pillL: { color: C.steel, fontSize: 9, textTransform: "uppercase" },
  hudBottom: { position: "absolute", left: 0, right: 0, bottom: 40, paddingHorizontal: 16, gap: 10 },
  shotBtns: { flexDirection: "row", gap: 10 },
  shotBtnOn: {
    flex: 1, backgroundColor: C.green, borderRadius: 14, padding: 15, alignItems: "center", gap: 3,
  },
  shotBtnMiss: {
    flex: 1, backgroundColor: C.crimson, borderRadius: 14, padding: 15, alignItems: "center", gap: 3,
  },
  shotEmoji: { fontSize: 18 },
  shotBtnText: { color: C.ice, fontWeight: "700", fontSize: 13 },
  pausedBanner: {
    ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(6,10,15,0.85)",
    alignItems: "center", justifyContent: "center", gap: 16,
  },
  pausedTitle: { color: C.ice, fontSize: 32, fontWeight: "700" },
});
