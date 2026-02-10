import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutGrid, List, Folder, User, Settings as SettingsIcon } from 'lucide-react';
import { TitleBar, Tab } from './TitleBar';
import './Layout.css';

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const navItems = [
    { path: '/sessions', icon: LayoutGrid, label: '会话', panelId: 'sessions' },
    { path: '/connections', icon: List, label: '连接器管理', panelId: 'connections' },
    { path: '/files', icon: Folder, label: 'SFTP', panelId: 'files' },
  ];

  const bottomItems = [
    { path: '/profile', icon: User, label: '用户', panelId: null },
    { path: '/settings', icon: SettingsIcon, label: '设置', panelId: null },
  ];

  const handleNavClick = (path: string, panelId: string | null) => {
    if (panelId) {
      // 如果点击的是同一个面板，切换开关状态
      if (activePanel === panelId) {
        setActivePanel(null);
      } else {
        setActivePanel(panelId);
      }
    } else {
      // 设置页面等不需要面板的页面
      setActivePanel(null);
    }
    navigate(path);
  };

  const handleTabClick = (id: string) => {
    setActiveTabId(id);
  };

  const handleTabClose = (id: string) => {
    // 标签关闭由子页面处理，这里只更新状态
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
    if (activeTabId === id) {
      setActiveTabId(null);
    }
  };

  const handleNewTab = () => {
    // 新建标签由子页面处理
  };

  return (
    <div className="app-container">
      <TitleBar 
        tabs={tabs}
        activeTabId={activeTabId}
        onTabClick={handleTabClick}
        onTabClose={handleTabClose}
        onNewTab={handleNewTab}
      />
      <div className="layout">
        <div className="sidebar">
          {navItems.map((item) => (
            <button
              key={item.path}
              className={`sidebar-item ${activePanel === item.panelId ? 'active' : ''}`}
              onClick={() => handleNavClick(item.path, item.panelId)}
              title={item.label}
            >
              <item.icon size={20} strokeWidth={1.5} />
            </button>
          ))}
          
          <div className="sidebar-spacer" />
          
          {bottomItems.map((item) => (
            <button
              key={item.path}
              className={`sidebar-item ${location.pathname === item.path ? 'active' : ''}`}
              onClick={() => handleNavClick(item.path, item.panelId)}
              title={item.label}
            >
              <item.icon size={20} strokeWidth={1.5} />
            </button>
          ))}
        </div>
        
        <div className="main-content">
          <Outlet context={{ 
            activePanel, 
            setActivePanel,
            tabs,
            setTabs,
            activeTabId,
            setActiveTabId,
            onTabClick: handleTabClick,
            onTabClose: handleTabClose,
            onNewTab: handleNewTab
          }} />
        </div>
      </div>
    </div>
  );
}
