import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { I18nProvider } from "./i18n";
import "./icons/materialSymbols";
import "./index.css";
import { installInputAssistanceDisabler } from "./utils/inputAssistance";

installInputAssistanceDisabler();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/connections" replace />} />
          <Route path="sessions" element={<Navigate to="/keys" replace />} />
          <Route path="*" element={<Layout />} />
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
