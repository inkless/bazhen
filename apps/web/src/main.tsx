import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { linkManifest } from "./install.ts";
import "./ui/palette.css";
import "./ui/tokens.css";
import "./ui/ui.css";
import "./app.css";

linkManifest(document, navigator.userAgent);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
