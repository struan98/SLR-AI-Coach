import React from "react";
import SincApp from "./pages/SincApp.jsx";

// Top-level entry.
//
// The deployed app is SincApp — it has all the features embedded as tabs
// (Home, Plan, Food, Train, Insights, More). The standalone SincTraining and
// SincAnalytics files are kept in src/pages/ for reference but aren't wired
// to the live entry — they were alternative entry points for artifact testing.
//
// If we later want deep-link routing (e.g. /train, /food), we'll add React Router
// here. For now, SincApp handles its own internal nav state.
export default function App() {
  return <SincApp />;
}
