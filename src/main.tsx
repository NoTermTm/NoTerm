import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ConnectionsPage } from "./pages/Connections";
import { SettingsPage } from "./pages/Settings";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/connections" replace />} />
          <Route path="sessions" element={<div style={{ padding: '24px' }}>会话管理 - 开发中</div>} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="files" element={<div style={{ padding: '24px' }}>SFTP 文件管理 - 开发中</div>} />
          <Route path="profile" element={<div style={{ padding: '24px' }}>用户信息 - 开发中</div>} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
