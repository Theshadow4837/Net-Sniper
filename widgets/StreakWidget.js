import React from "react";
import { FlexWidget, TextWidget } from "react-native-android-widget";

// Colors match the app's own palette (see the `C` object in App.js) so the
// widget looks like part of Net Sniper rather than a generic Android widget.
const WIDGET_BG = "#0A121C";
const WIDGET_AMBER = "#E2A63B";
const WIDGET_ICE = "#E9F2F6";

export function StreakWidget({ streak }) {
  const count = streak || 0;
  return (
    <FlexWidget
      style={{
        height: "match_parent",
        width: "match_parent",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: WIDGET_BG,
      }}
      clickAction="OPEN_APP"
    >
      <TextWidget
        text={String(count)}
        style={{ fontSize: 34, fontWeight: "700", color: WIDGET_AMBER }}
      />
      <TextWidget
        text={count === 1 ? "day streak" : "day streak"}
        style={{ fontSize: 12, color: WIDGET_ICE }}
      />
    </FlexWidget>
  );
}
