import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StreakWidget } from "./widgets/StreakWidget";
import { computeDisplayStreak } from "./streakLogic";

// Must match the key App.js uses for AsyncStorage.setItem(K_STREAK, ...).
const K_STREAK = "netsniper:streak";

// This runs as a headless JS task on Android, separate from the running app.
// Keep it minimal and fast - it should not import App.js or anything that
// pulls in the camera/vision-camera stack.
export async function widgetTaskHandler(props) {
  if (props.widgetInfo.widgetName !== "StreakWidget") return;

  switch (props.widgetAction) {
    case "WIDGET_ADDED":
    case "WIDGET_UPDATE":
    case "WIDGET_RESIZED":
    case "WIDGET_CLICK": {
      let streak = { count: 0, lastDate: null };
      try {
        const raw = await AsyncStorage.getItem(K_STREAK);
        if (raw) streak = JSON.parse(raw);
      } catch {
        // Unreadable/corrupt storage should not crash the widget - show 0.
      }
      const displayStreak = computeDisplayStreak(streak, new Date());
      props.renderWidget(<StreakWidget streak={displayStreak} />);
      break;
    }
    default:
      break;
  }
}
