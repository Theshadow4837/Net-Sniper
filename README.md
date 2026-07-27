# Net Sniper

This app was made with AI as part of my learning process, and it also shows something real: young programmers like me may struggle to get programming jobs in the future because AI can now build software faster and faster.

## What this app is

Net Sniper is a React Native (Expo) hockey shooting tracker.  
It helps you track:

- Total shots
- On-target shots
- Missed shots
- Session accuracy
- Session history and streaks

## How it works

1. **Start a session** from the main menu.
2. **Set up your net area** by tapping two corners on the camera preview.
3. **Place target zones** in the net where you want to track accuracy.
4. Choose between:
   - **Manual mode** (tap On Target or Missed buttons), or
   - **Auto-detect mode** (camera-based motion detection tracks shots automatically).
5. **Finish the session** to see a summary with accuracy, time, and targets used.
6. Your data is saved locally, so you can review all-time stats and session history later.

## Tech stack

- React Native
- Expo
- react-native-vision-camera
- AsyncStorage for local stats/session storage
