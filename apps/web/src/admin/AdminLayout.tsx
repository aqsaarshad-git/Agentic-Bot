import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Phone,
  MessagesSquare,
  AlertTriangle,
  Ticket,
  Bot,
  BookOpen,
  Wrench,
  UserCog,
  Megaphone,
  CalendarClock,
  BarChart3,
  FileText,
  ScrollText,
  Settings,
  LogOut,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useAdminAuth } from '../shared/AdminAuthContext';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Overview',
    items: [{ to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    title: 'Customer activity',
    items: [
      { to: '/admin/customers', label: 'Customers', icon: Users },
      { to: '/admin/calls', label: 'Calls', icon: Phone },
      { to: '/admin/conversations', label: 'Conversations', icon: MessagesSquare },
      { to: '/admin/escalations', label: 'Escalations', icon: AlertTriangle },
      { to: '/admin/tickets', label: 'Tickets', icon: Ticket },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { to: '/admin/agents', label: 'AI Agents', icon: Bot },
      { to: '/admin/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
      { to: '/admin/tools', label: 'Tools', icon: Wrench },
      { to: '/admin/human-agents', label: 'Human Agents', icon: UserCog },
    ],
  },
  {
    title: 'Outreach',
    items: [
      { to: '/admin/campaigns', label: 'Campaigns', icon: Megaphone },
      { to: '/admin/callbacks', label: 'Callbacks', icon: CalendarClock },
    ],
  },
  {
    title: 'Insights',
    items: [
      { to: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/admin/reports', label: 'Reports', icon: FileText },
      { to: '/admin/audit-logs', label: 'Audit Logs', icon: ScrollText },
    ],
  },
  {
    title: 'System',
    items: [{ to: '/admin/settings', label: 'Settings', icon: Settings }],
  },
];

export function AdminLayout() {
  const { user, logout } = useAdminAuth();
  const initials = (user?.name ?? '?')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck size={16} color="#fff" />
          </span>
          Barq Bank
        </div>
        <div className="admin-nav-scroll">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="admin-nav-section">{section.title}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink key={item.to} to={item.to} end={item.end}>
                    <Icon size={16} />
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
      <div className="admin-main">
        <div className="admin-topbar">
          <div className="admin-topbar-user">
            <span className="admin-topbar-avatar">{initials}</span>
            {user?.name}
          </div>
          <button className="btn btn-ghost" onClick={logout}>
            <LogOut size={15} />
            Log out
          </button>
        </div>
        <div className="admin-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
