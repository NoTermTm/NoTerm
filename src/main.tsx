import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { KeysPage } from "./pages/Keys";
import { SettingsPage } from "./pages/Settings";
import { I18nProvider, useI18n } from "./i18n";
import "./icons/materialSymbols";
import "./index.css";

const Placeholder = ({ messageKey }: { messageKey: string }) => {
  const { t } = useI18n();
  return <div style={{ padding: "24px" }}>{t(messageKey)}</div>;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/connections" replace />} />
            <Route path="sessions" element={<Navigate to="/keys" replace />} />
            <Route path="connections" element={<div />} />
            <Route path="forwarding" element={<div />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="files" element={<Placeholder messageKey="placeholder.sftp" />} />
            <Route path="profile" element={<Placeholder messageKey="placeholder.profile" />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="space" element={<div />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
