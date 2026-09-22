import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminAuthProvider, useAdminAuth } from './shared/AdminAuthContext';
import { CustomerAuthProvider } from './shared/CustomerAuthContext';
import { AdminLayout } from './admin/AdminLayout';
import { LoginPage } from './admin/LoginPage';
import { DashboardPage } from './admin/DashboardPage';
import { CustomersPage } from './admin/CustomersPage';
import { CallsPage } from './admin/CallsPage';
import { ConversationsPage } from './admin/ConversationsPage';
import { ConversationDetailPage } from './admin/ConversationDetailPage';
import { EscalationsPage } from './admin/EscalationsPage';
import { KnowledgeBasePage } from './admin/KnowledgeBasePage';
import { TicketsPage } from './admin/TicketsPage';
import { AgentsPage } from './admin/AgentsPage';
import { AuditLogsPage } from './admin/AuditLogsPage';
import { HumanAgentsPage } from './admin/HumanAgentsPage';
import { ToolsPage } from './admin/ToolsPage';
import { CampaignsPage } from './admin/CampaignsPage';
import { CallbacksPage } from './admin/CallbacksPage';
import { AnalyticsPage } from './admin/AnalyticsPage';
import { ComingSoonPage } from './admin/ComingSoonPage';
import { SupportPage } from './support/SupportPage';

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { token, loading } = useAdminAuth();
  if (loading) return null;
  if (!token) return <Navigate to="/admin/login" replace />;
  return children;
}

function AdminRoutes() {
  return (
    <AdminAuthProvider>
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          path=""
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="calls" element={<CallsPage />} />
          <Route path="conversations" element={<ConversationsPage />} />
          <Route path="conversations/:id" element={<ConversationDetailPage />} />
          <Route path="escalations" element={<EscalationsPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="audit-logs" element={<AuditLogsPage />} />
          <Route path="knowledge-base" element={<KnowledgeBasePage />} />
          <Route path="tools" element={<ToolsPage />} />
          <Route path="human-agents" element={<HumanAgentsPage />} />
          <Route path="campaigns" element={<CampaignsPage />} />
          <Route path="callbacks" element={<CallbacksPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="reports" element={<ComingSoonPage title="Reports" phase={6} />} />
          <Route path="settings" element={<ComingSoonPage title="Settings" phase={6} />} />
        </Route>
      </Routes>
    </AdminAuthProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/support" replace />} />
      <Route
        path="/support/*"
        element={
          <CustomerAuthProvider>
            <SupportPage />
          </CustomerAuthProvider>
        }
      />
      <Route path="/admin/*" element={<AdminRoutes />} />
    </Routes>
  );
}
