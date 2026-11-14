import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { linkAppFiles, thisDevice } from "./install.ts";
import "./ui/palette.css";
import "./ui/tokens.css";
import "./ui/ui.css";
import "./app.css";

linkAppFiles(document, thisDevice());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
