import { useState } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ToastHost from './shared/Toast';
import AiOnScreen from './AiOnScreen';

export default function Layout({ children, lastRefresh, onRefresh }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div className="app-main">
        <TopBar lastRefresh={lastRefresh} onRefresh={onRefresh} />
        <div className="app-content">
          {children}
        </div>
      </div>
      <AiOnScreen />
      <ToastHost />
    </div>
  );
}
