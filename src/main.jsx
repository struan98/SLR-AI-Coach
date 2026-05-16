import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// React 18 strict mode is helpful in dev for catching effects bugs,
// but it double-renders which can confuse first-time deploy testing.
// Leave it OFF for now; turn on after we're past initial deployment.
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
