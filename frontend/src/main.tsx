import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./index.css";

// Restore persisted theme & global font size before first paint
const savedTheme = localStorage.getItem("comfyvault_theme") || "dark";
if (savedTheme === "light") {
  document.documentElement.classList.add("theme-light");
  document.documentElement.classList.remove("dark");
} else {
  document.documentElement.classList.remove("theme-light");
  document.documentElement.classList.add("dark");
}
const savedFont = localStorage.getItem("comfyvault_font_size") || "md";
document.documentElement.setAttribute("data-font-size", savedFont);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
