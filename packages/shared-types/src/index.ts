export type TicketStatus =
  | 'NEW'
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_CUSTOMER'
  | 'ESCALATED'
  | 'RESOLVED'
  | 'CLOSED';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type ConversationState =
  | 'CALL_STARTED'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'LISTENING'
  | 'PROCESSING'
  | 'UNDERSTANDING_REQUEST'
  | 'EXECUTING_ACTION'
  | 'WAITING_FOR_TOOL'
  | 'CONFIRMING_ACTION'
  | 'RESOLVING'
  | 'ESCALATING'
  | 'CALLBACK_REQUESTED'
  | 'CALL_ENDED';

export type MessageSender = 'CUSTOMER' | 'AI' | 'SYSTEM' | 'HUMAN_AGENT';

export interface Customer {
  id: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  language: string;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  content: string;
  createdAt: string;
}

export interface ConversationSummaryEntry {
  id: string;
  summary: string;
  generatedAt: string;
}

export interface Conversation {
  id: string;
  customerId: string;
  aiAgentId?: string | null;
  channel: 'TEXT' | 'VOICE';
  state: ConversationState;
  intent?: string | null;
  createdAt: string;
  messages?: Message[];
  customer?: { id: string; fullName: string };
  summaries?: ConversationSummaryEntry[];
}

export interface Ticket {
  id: string;
  ticketNumber: string;
  customerId: string;
  conversationId?: string | null;
  category?: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  description: string;
  aiSummary?: string | null;
  resolution?: string | null;
  createdAt: string;
  updatedAt: string;
  assignments?: TicketAssignment[];
  messages?: TicketMessageEntry[];
}

export interface AiAgentConfigSummary {
  id: string;
  systemInstructions: string;
  supportedLanguages: string[];
  allowedTools: string[];
  knowledgeBaseAccess: boolean;
}

export interface AiAgent {
  id: string;
  name: string;
  description?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  configs: AiAgentConfigSummary[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface CustomerIdentifyResponse {
  customerId: string;
  otpRequired: true;
  /** Only present outside production, since there's no real SMS/email gateway wired up yet. */
  devOtp?: string;
  /** A fixed code that works for ANY customer while OTP_DEV_BYPASS_CODE is set — dev/test only. */
  devBypassCode?: string;
}

export interface CustomerOtpVerifyResponse {
  accessToken: string;
  customer: Customer;
}

export interface SendMessageResponse {
  reply: string;
  state: ConversationState;
  /** Transcript-based classification of the customer's turn (used to pick the agent's TTS
   *  tone on calls; also useful for admin-side triage even though chat has no TTS). */
  emotion?: string;
  sentiment?: string;
  urgency?: string;
  intent?: string;
}

export interface StaffUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  role: { name: string };
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TicketAssignment {
  id: string;
  userId: string;
  assignedAt: string;
  unassignedAt?: string | null;
  user: { id: string; name: string };
}

export interface TicketMessageEntry {
  id: string;
  ticketId: string;
  authorType: 'CUSTOMER' | 'AGENT' | 'AI' | 'SYSTEM';
  authorId?: string | null;
  content: string;
  createdAt: string;
}

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';
export type CampaignContactStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
export type CampaignCallOutcome =
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'CALLBACK_REQUESTED'
  | 'RESOLVED'
  | 'ESCALATED'
  | 'FAILED';

export interface CampaignCallEntry {
  id: string;
  callId?: string | null;
  attemptNumber: number;
  outcome: CampaignCallOutcome;
  createdAt: string;
}

export interface CampaignContactEntry {
  id: string;
  customerId: string;
  status: CampaignContactStatus;
  attempts: number;
  lastAttemptAt?: string | null;
  customer?: { id: string; fullName: string };
  calls?: CampaignCallEntry[];
}

export interface Campaign {
  id: string;
  name: string;
  aiAgentId?: string | null;
  status: CampaignStatus;
  startDate: string;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  maxAttempts: number;
  retryIntervalMinutes: number;
  script?: string | null;
  createdAt: string;
  _count?: { contacts: number };
  contacts?: CampaignContactEntry[];
}

export type CallbackStatus = 'PENDING' | 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface CallbackEntry {
  id: string;
  customerId: string;
  requestedDate: string;
  requestedTime: string;
  reason?: string | null;
  status: CallbackStatus;
  createdAt: string;
  customer?: { id: string; fullName: string };
}

export type CallDirection = 'INBOUND' | 'OUTBOUND';
export type CallEscalationStatus = 'NONE' | 'ESCALATED' | 'RESOLVED';
export type CallTransport = 'WEBRTC' | 'PSTN';

export interface CallTranscriptSegment {
  role: 'customer' | 'ai';
  text: string;
  at: string;
}

export interface Call {
  id: string;
  customerId: string;
  aiAgentId?: string | null;
  conversationId?: string | null;
  direction: CallDirection;
  liveKitRoomName?: string | null;
  transport: CallTransport;
  fromNumber?: string | null;
  toNumber?: string | null;
  providerCallUuid?: string | null;
  startTime: string;
  endTime?: string | null;
  durationSeconds?: number | null;
  outcome?: string | null;
  escalationStatus: CallEscalationStatus;
  createdAt: string;
  customer?: { id: string; fullName: string };
  transcript?: { content: CallTranscriptSegment[] } | null;
  conversation?: Conversation;
}

export type KnowledgeDocumentStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface KnowledgeDocument {
  id: string;
  title: string;
  category?: string | null;
  content?: string | null;
  status: KnowledgeDocumentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsSummary {
  conversations: { total: number; byState: Record<string, number>; escalationRate: number };
  calls: { total: number; avgDurationSeconds: number | null; byOutcome: Record<string, number> };
  tickets: { total: number; byStatus: Record<string, number>; byPriority: Record<string, number> };
  tools: {
    totalExecutions: number;
    failures: number;
    failureRate: number;
    byTool: { name: string; success: number; failure: number }[];
  };
  llm: { errorCount: number; avgLatencyMs: number | null };
  voice: { avgSttLatencyMs: number | null; avgTtsLatencyMs: number | null };
  avgTotalResponseMs: number | null;
  callbacks: { byStatus: Record<string, number> };
  campaigns: { byStatus: Record<string, number>; contactsByStatus: Record<string, number> };
}

export interface AuditLogEntry {
  id: string;
  requestId?: string | null;
  actorType: 'CUSTOMER' | 'USER' | 'AI_AGENT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  toolName?: string | null;
  success: boolean;
  createdAt: string;
}
