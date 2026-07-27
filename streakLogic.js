// Pure streak-calculation helpers shared between App.js (foreground app) and
// widget-task-handler.js (headless Android widget task). Kept dependency-free
// on purpose - the widget task imports this file directly and must stay
// lightweight, so nothing here should import React, AsyncStorage, or any
// native module.

export function dateKeyFor(d) {
  // Local calendar day (respects the device's timezone), not UTC.
  return d.toDateString();
}

export function isConsecutiveDay(prevKey, todayDate) {
  if (!prevKey) return false;
  const y = new Date(todayDate);
  y.setDate(todayDate.getDate() - 1);
  return prevKey === dateKeyFor(y);
}

export function computeDisplayStreak(streak, now) {
  if (!streak || !streak.lastDate || !streak.count) return 0;
  const today = dateKeyFor(now);
  if (streak.lastDate === today) return streak.count;
  if (isConsecutiveDay(streak.lastDate, now)) return streak.count;
  // A day was missed without a qualifying session - streak is gone.
  return 0;
}
